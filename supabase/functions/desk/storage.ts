import { defaultIcp } from '../../../server/default-icp.ts';
import type { Provider, Workspace } from '../../../src/model.ts';

export interface DeskMailbox {
  email: string;
  refreshToken: string;
}

export interface DeskSecrets {
  mailboxes: Record<string, DeskMailbox>;
  activeMailbox?: string;
  keys?: Partial<Record<Provider, string>>;
  hosted?: Record<string, unknown>;
  mailSync?: Record<string, { checkedAt: number; cursor?: string }>;
}

export interface DeskState {
  workspace: Workspace;
  secrets: DeskSecrets;
  save(): Promise<void>;
}

type SavedState = { workspace: Workspace; secret_box: string; revision: string };

export class DeskStorageError extends Error {
  constructor(message: string, readonly status = 503) { super(message); }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const secretsContext = encoder.encode('conference_desk.workspace_state.v1');

function emptyWorkspace(): Workspace {
  return { conferences: [], queue: [], icp: structuredClone(defaultIcp), jobs: [] };
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

function decodeBase64(encoded: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
}

let encryptionKey: Promise<CryptoKey> | undefined;
function getEncryptionKey(): Promise<CryptoKey> {
  if (encryptionKey) return encryptionKey;
  const configured = Deno.env.get('CONFERENCE_SECRETS_KEY')?.trim() || '';
  try {
    const bytes = decodeBase64(configured);
    if (bytes.length !== 32 || encodeBase64(bytes) !== configured) throw new Error();
    encryptionKey = crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return encryptionKey;
  } catch {
    throw new DeskStorageError('The workspace encryption key is missing or invalid.');
  }
}

async function seal(json: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertextAndTag = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: secretsContext, tagLength: 128 },
    await getEncryptionKey(), encoder.encode(json),
  ));
  const tagStart = ciphertextAndTag.length - 16;
  return ['v1', encodeBase64(nonce), encodeBase64(ciphertextAndTag.subarray(tagStart)), encodeBase64(ciphertextAndTag.subarray(0, tagStart))].join(':');
}

async function open(box: string): Promise<DeskSecrets> {
  const key = await getEncryptionKey();
  try {
    const [version, nonce, tag, content, extra] = box.split(':');
    if (version !== 'v1' || !nonce || !tag || !content || extra !== undefined) throw new Error();
    const iv = decodeBase64(nonce);
    const tagBytes = decodeBase64(tag);
    const ciphertext = decodeBase64(content);
    if (iv.length !== 12 || tagBytes.length !== 16) throw new Error();
    const ciphertextAndTag = new Uint8Array(ciphertext.length + tagBytes.length);
    ciphertextAndTag.set(ciphertext);
    ciphertextAndTag.set(tagBytes, ciphertext.length);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: secretsContext, tagLength: 128 }, key, ciphertextAndTag);
    const { gmail, ...stored } = JSON.parse(decoder.decode(plain)) as Partial<DeskSecrets> & { gmail?: DeskMailbox };
    const mailboxes = stored.mailboxes ?? {};
    const activeMailbox = stored.activeMailbox ?? gmail?.email.toLowerCase();
    if (gmail && activeMailbox && !mailboxes[activeMailbox]) mailboxes[activeMailbox] = gmail;
    return { ...stored, mailboxes, activeMailbox };
  } catch {
    throw new DeskStorageError('The workspace credentials could not be decrypted.');
  }
}

function serializeSecrets(secrets: DeskSecrets) {
  // Keep the active mailbox readable by the Node workspace if the operator rolls back the deployment.
  const gmail = secrets.activeMailbox && secrets.mailboxes[secrets.activeMailbox];
  return JSON.stringify({ ...secrets, gmail: gmail || undefined });
}

function serviceKey() {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  const keys = Deno.env.get('SUPABASE_SECRET_KEYS');
  try { return keys && (JSON.parse(keys) as { default?: string }).default; }
  catch { return undefined; }
}

async function rpc<T>(operation: string, arguments_: Record<string, unknown> = {}): Promise<T> {
  const url = Deno.env.get('SUPABASE_URL');
  const key = serviceKey();
  if (!url || !key) throw new DeskStorageError('Workspace database access is not configured.');
  const headers = new Headers({ 'content-type': 'application/json', apikey: key });
  if (!key.startsWith('sb_secret_')) headers.set('authorization', `Bearer ${key}`);
  try {
    const response = await fetch(new URL(`/rest/v1/rpc/${operation}`, url), {
      method: 'POST', headers, body: JSON.stringify(arguments_), signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error();
    if (response.status === 204) return null as T;
    return await response.json() as T;
  } catch {
    throw new DeskStorageError('The workspace database did not respond. Please try again.');
  }
}

export async function readDeskState(): Promise<Pick<DeskState, 'workspace' | 'secrets'>> {
  const snapshot = await rpc<SavedState | null>('desk_read_state');
  return snapshot
    ? { workspace: snapshot.workspace, secrets: await open(snapshot.secret_box) }
    : { workspace: emptyWorkspace(), secrets: { mailboxes: {} } };
}

export async function withDeskState<T>(task: (state: DeskState) => Promise<T>): Promise<T> {
  const token = crypto.randomUUID();
  const snapshot = await rpc<SavedState | null>('desk_claim_state', {
    p_token: token, p_initial_workspace: emptyWorkspace(), p_initial_box: await seal('{"mailboxes":{}}'),
  });
  if (!snapshot) throw new DeskStorageError('Another workspace update is in progress. Try again shortly.', 409);

  let writes = Promise.resolve();
  try {
    const workspace = snapshot.workspace;
    const secrets = await open(snapshot.secret_box);
    let revision = snapshot.revision;
    let savedWorkspace = JSON.stringify(workspace);
    let savedSecrets = serializeSecrets(secrets);
    const state: DeskState = { workspace, secrets, save: () => {
      const nextWorkspace = JSON.stringify(state.workspace);
      const nextSecrets = serializeSecrets(state.secrets);
      writes = writes.then(async () => {
        const nextRevision = await rpc<string | null>('desk_commit_state', {
          p_token: token, p_revision: revision, p_workspace: JSON.parse(nextWorkspace), p_box: await seal(nextSecrets),
        });
        if (nextRevision === null) throw new DeskStorageError('This workspace update expired. Check the latest state before retrying.', 409);
        revision = nextRevision;
        savedWorkspace = nextWorkspace;
        savedSecrets = nextSecrets;
      });
      return writes;
    } };

    const result = await task(state);
    await writes;
    if (savedWorkspace !== JSON.stringify(state.workspace) || savedSecrets !== serializeSecrets(state.secrets)) await state.save();
    return result;
  } finally {
    await writes.catch(() => undefined);
    // The database expires the lease if this invocation ended before it could release it.
    await rpc('desk_release_state', { p_token: token }).catch(() => undefined);
  }
}
