import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import type { Conference, Provider, Workspace } from '../src/model';
import { defaultIcp } from './default-icp';

export type Secrets = {
  gmail?: { email: string; refreshToken: string };
  keys?: Partial<Record<Provider, string>>;
};

export const dataDirectory = resolve(process.env.CONFERENCE_DATA_DIR || '.data');
const databaseUrl = process.env.CONFERENCE_DATABASE_URL?.trim();
if (!databaseUrl) mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });

function read<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(dataDirectory, name), 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

function emptyWorkspace(): Workspace { return { conferences: [], queue: [], icp: defaultIcp, jobs: [] }; }

function readLocalWorkspace() {
  return read<Workspace>('workspace.json', { ...emptyWorkspace(), conferences: read<Conference[]>('import-conferences.json', []) });
}

export let workspace = databaseUrl ? emptyWorkspace() : readLocalWorkspace();
export let secrets = databaseUrl ? {} as Secrets : read<Secrets>('connections.json', {});

function write(name: string, value: object) {
  const path = join(dataDirectory, name);
  const temporary = path + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
}

const secretsContext = 'conference_desk.workspace_state.v1';
type Database = { client: Client; backendPid: number; revision: string; key: Buffer; writes: Promise<void> };
let database: Database | undefined;
let closing = false;

function encryptionKey() {
  const configured = process.env.CONFERENCE_SECRETS_KEY?.trim() || '';
  const key = Buffer.from(configured, 'base64');
  if (key.length !== 32 || key.toString('base64') !== configured) {
    throw new Error('Set CONFERENCE_SECRETS_KEY to 32 random bytes encoded as base64. Keep this key between deployments.');
  }
  return key;
}

function encryptSecrets(key: Buffer, value: Secrets) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(secretsContext));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', nonce.toString('base64'), cipher.getAuthTag().toString('base64'), bytes.toString('base64')].join(':');
}

function decryptSecrets(key: Buffer, box: string): Secrets {
  const [version, nonce, tag, bytes] = box.split(':');
  try {
    if (version !== 'v1' || !nonce || !tag || !bytes) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(secretsContext));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(bytes, 'base64')), decipher.final()]).toString('utf8')) as Secrets;
  } catch {
    throw new Error('Could not decrypt the stored provider connections. Check CONFERENCE_SECRETS_KEY.');
  }
}

function databaseConnection(raw: string) {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error('Set CONFERENCE_DATABASE_URL to a PostgreSQL connection URI.'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.port === '6543' || url.searchParams.has('pgbouncer')) {
    throw new Error('Use a direct PostgreSQL or Supabase session-mode connection URI.');
  }
  // node-postgres lets URI SSL options override the TLS object. Keep certificate and hostname verification enabled.
  for (const option of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslnegotiation', 'uselibpqcompat']) url.searchParams.delete(option);
  return new Client({
    connectionString: url.href,
    ssl: { rejectUnauthorized: true, ca: process.env.CONFERENCE_DATABASE_CA?.trim() || undefined },
    application_name: 'conference-desk', keepAlive: true, keepAliveInitialDelayMillis: 5_000,
    connectionTimeoutMillis: 10_000, statement_timeout: 10_000, query_timeout: 15_000,
  });
}

function stopForDatabaseFailure(): never {
  // The in-memory workspace may differ from the database after an ambiguous write.
  console.error('Conference Desk stopped because the database session or a saved write could not be verified.');
  process.exit(1);
}

export async function initializeStorage() {
  if (!databaseUrl || database) return;
  const key = encryptionKey();
  const client = databaseConnection(databaseUrl);
  client.on('error', () => { if (database?.client === client && !closing) stopForDatabaseFailure(); });
  try {
    await client.connect();
    const { rows: [lock] } = await client.query<{ locked: boolean; backend_pid: number }>(
      "SELECT pg_try_advisory_lock(hashtextextended('conference_desk.workspace_state', 0)) AS locked, pg_backend_pid() AS backend_pid",
    );
    if (!lock?.locked) throw new Error('A Conference Desk server is already running for this database.');
    const { rows: [saved] } = await client.query<{ backend_pid: number; workspace: Workspace | null; secret_box: string | null; revision: string | null }>(
      `SELECT pg_backend_pid() AS backend_pid, state.workspace, state.secret_box, state.revision::text
       FROM (SELECT 1 AS id) AS instance
       LEFT JOIN conference_desk.workspace_state AS state USING (id)`,
    );
    if (saved?.backend_pid !== lock.backend_pid) throw new Error('Conference Desk requires a persistent PostgreSQL session.');
    let revision = saved.revision;
    if (revision !== null) {
      if (!saved.workspace || !saved.secret_box) throw new Error('Conference Desk database state is incomplete.');
      workspace = saved.workspace;
      secrets = decryptSecrets(key, saved.secret_box);
    } else {
      workspace = readLocalWorkspace();
      secrets = read<Secrets>('connections.json', {});
      const { rows: [created] } = await client.query<{ revision: string }>(
        `INSERT INTO conference_desk.workspace_state (id, workspace, secret_box)
         SELECT 1, $1::jsonb, $2 WHERE pg_backend_pid() = $3 RETURNING revision::text`,
        [JSON.stringify(workspace), encryptSecrets(key, secrets), lock.backend_pid],
      );
      if (!created) throw new Error('Conference Desk requires a persistent PostgreSQL session.');
      revision = created.revision;
    }
    database = { client, key, revision, backendPid: lock.backend_pid, writes: Promise.resolve() };
  } catch (error) {
    await client.end().catch(() => undefined);
    if ((error as { code?: string }).code === '42P01') throw new Error('Apply the Conference Desk database migration before starting.');
    throw error;
  }
}

function currentDatabase() {
  if (!database || closing) throw new Error('Conference Desk database is unavailable.');
  return database;
}

function writeDatabase(state: Database, column: 'workspace' | 'secret_box', value: string) {
  state.writes = state.writes.then(async () => {
    const { rows: [updated] } = await state.client.query<{ revision: string }>(
      `UPDATE conference_desk.workspace_state SET ${column} = $1, revision = revision + 1
       WHERE id = 1 AND revision = $2 AND pg_backend_pid() = $3 RETURNING revision::text`,
      [value, state.revision, state.backendPid],
    );
    if (!updated) stopForDatabaseFailure();
    state.revision = updated.revision;
  }).catch(stopForDatabaseFailure);
  return state.writes;
}

export async function persist() {
  if (databaseUrl) await writeDatabase(currentDatabase(), 'workspace', JSON.stringify(workspace));
  else write('workspace.json', workspace);
}

export async function saveSecrets(next: Secrets) {
  if (databaseUrl) {
    const state = currentDatabase();
    await writeDatabase(state, 'secret_box', encryptSecrets(state.key, next));
  } else write('connections.json', next);
  secrets = next;
}

export async function closeStorage() {
  const state = database;
  if (!state || closing) return;
  closing = true;
  await state.writes;
  await state.client.end();
  database = undefined;
}

// One scheduler per workspace. A stale lock is recoverable after a crash.
export function lockWorkspace() {
  if (databaseUrl) return;
  const lock = join(dataDirectory, 'worker.pid');
  const take = () => {
    const descriptor = openSync(lock, 'wx', 0o600);
    try { writeFileSync(descriptor, String(process.pid)); }
    finally { closeSync(descriptor); }
  };
  try {
    take();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = Number(readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(owner) || owner < 1) throw new Error(`Check the workspace lock at ${lock} before starting another server.`);
    try {
      process.kill(owner, 0);
    } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe;
      unlinkSync(lock);
      take();
      process.on('exit', () => unlinkSync(lock));
      return;
    }
    throw new Error('A Conference Desk server is already running for this workspace.');
  }
  process.on('exit', () => unlinkSync(lock));
}
