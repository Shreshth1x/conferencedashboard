import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { localDate, type BatchPreview, type Contact, type Snapshot, type Workspace } from '../src/model';
import { defaultIcp } from './default-icp';
import { SCHEDULE_GAP_MS } from './schedule';

const mailbox = 'fake-sender@example.org';
const eventId = 'integration-conference';
const mockNetwork = String.raw`
import assert from 'node:assert/strict';
let draft;
let sentAt;
let recipient;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  const method = init.method ?? 'GET';
  if (url.href === 'https://oauth2.googleapis.com/token') {
    assert.equal(method, 'POST');
    assert.equal(init.body.get('refresh_token'), 'test-refresh');
    return Response.json({ access_token: 'test-access', expires_in: 3600 });
  }
  assert.equal(url.origin, 'https://gmail.googleapis.com', 'External network is disabled in the integration test');
  assert.equal(init.headers.Authorization, 'Bearer test-access');
  const path = url.pathname.replace('/gmail/v1/users/me', '');
  if (path === '/messages' && method === 'GET') return Response.json({ messages: [] });
  if (path === '/drafts' && method === 'POST') {
    draft = JSON.parse(init.body).message.raw;
    const mime = Buffer.from(draft, 'base64url').toString();
    assert.match(mime, /From: fake-sender@example.org/);
    recipient = mime.match(/^To: ([^\r\n]+)$/m)?.[1];
    return Response.json({ id: 'fake-draft', message: { id: 'fake-unsent', threadId: 'fake-thread' } });
  }
  if (path === '/drafts/fake-draft' && method === 'GET') {
    assert.equal(url.searchParams.get('format'), 'raw');
    return Response.json({ id: 'fake-draft', message: { raw: draft } });
  }
  if (path === '/drafts/send' && method === 'POST') {
    assert.equal(sentAt, undefined, 'Only one Gmail send is expected');
    assert.equal(JSON.parse(init.body).message.raw, draft);
    assert.equal(JSON.parse(init.body).id, 'fake-draft');
    sentAt = Date.now();
    return Response.json({ id: 'fake-sent', threadId: 'fake-thread', internalDate: String(sentAt) });
  }
  if (path === '/threads/fake-thread' && method === 'GET') {
    return Response.json({ messages: [
      { id: 'fake-sent', threadId: 'fake-thread', internalDate: String(sentAt), labelIds: ['SENT'],
        payload: { headers: [{ name: 'To', value: recipient }] } },
      { id: 'fake-reply', threadId: 'fake-thread', internalDate: String(sentAt + 1), labelIds: ['INBOX'],
        payload: { headers: [{ name: 'From', value: recipient }] } },
    ] });
  }
  throw new Error('Unexpected mock Gmail request: ' + method + ' ' + path);
};
`;

async function freePort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return address.port;
}

function exampleContact(index: number, bucket: Contact['bucket'], emailStatus: Contact['emailStatus'] = 'verified'): Contact {
  return {
    id: `contact-${index}`, name: `Test Attendee ${index}`, email: `attendee-${index}@example.org`,
    title: bucket === 'direct' ? 'Commissioning Manager' : 'Partnerships Manager', company: 'Example Company',
    attendance: 'attendee', bucket, score: (bucket === 'direct' ? 95 : 60) - index,
    emailStatus, reason: 'Fixture',
  };
}

async function isolatedWorkspace(t: TestContext, workspace: Workspace) {
  const directory = await mkdtemp(join(tmpdir(), 'conference-desk-schedule-test-'));
  const workspacePath = join(directory, 'workspace.json');
  const mockPath = join(directory, 'mock-network.mjs');
  await Promise.all([
    writeFile(workspacePath, JSON.stringify(workspace)),
    writeFile(join(directory, 'connections.json'), JSON.stringify({ gmail: { email: mailbox, refreshToken: 'test-refresh' } })),
    writeFile(mockPath, mockNetwork),
  ]);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', mockPath, 'server/index.ts'], {
    env: {
      ...process.env, PORT: String(port), NODE_ENV: 'production', CONFERENCE_DATA_DIR: directory,
      GMAIL_CLIENT_ID: 'test-client', GMAIL_CLIENT_SECRET: 'test-secret', GMAIL_REDIRECT_URI: origin + '/api/gmail/callback',
      APOLLO_API_KEY: '', AUTUMN_API_KEY: '', EXA_API_KEY: '', OPENAI_API_KEY: '', CODEX_BIN: join(directory, 'codex-disabled'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
    await rm(directory, { recursive: true, force: true });
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += String(chunk); });
  child.stderr.on('data', chunk => { logs += String(chunk); });
  for (let attempt = 0; attempt < 100 && !logs.includes('Conference Desk is running') && child.exitCode === null; attempt++) await delay(30);
  assert.match(logs, /Conference Desk is running/, logs);

  async function request<T>(path: string, body?: object, status = 200): Promise<T> {
    const response = await fetch(origin + '/api' + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result as T;
  }
  return { request, workspacePath };
}

type Planned = { preview: BatchPreview; snapshot: Snapshot };

test('schedule preview, confirmation, cancel, due worker send, and reply sync use an isolated workspace', { timeout: 15_000 }, async t => {
  const { request, workspacePath } = await isolatedWorkspace(t, {
    conferences: [{
      id: eventId, title: 'Example Commissioning Forum', contacts: [
        exampleContact(1, 'direct'), exampleContact(2, 'direct'), exampleContact(3, 'direct'),
        exampleContact(4, 'connector'), exampleContact(5, 'connector'), exampleContact(6, 'irrelevant'),
        exampleContact(7, 'direct', 'unverified'),
      ], createdAt: new Date().toISOString(), sources: [], notes: [], needsRoster: false,
    }],
    queue: [], jobs: [], icp: defaultIcp,
  });

  const base = `/conferences/${eventId}`;
  const initial = await request<Planned>(base + '/schedule/preview', { count: 5 });
  assert.equal(initial.preview.account, mailbox);
  assert.deepEqual(initial.preview.rows.map(row => row.contactId), ['contact-1', 'contact-2', 'contact-3', 'contact-4', 'contact-5']);
  assert.equal(initial.snapshot.queue.length, 0);
  const times = initial.preview.rows.map(row => Date.parse(row.scheduledAt));
  assert.ok(times[0] > Date.now());
  assert.ok(times.slice(1).every((time, index) => time - times[index] >= SCHEDULE_GAP_MS));
  const first = initial.snapshot.conferences[0].contacts[0];
  await request(base + '/contacts/' + first.id, {
    email: first.email, subject: 'Updated subject', body: first.draft?.body, confirmEmail: true, approved: true,
  });
  await request(base + '/schedule', { token: initial.preview.token }, 400);

  const updated = await request<Planned>(base + '/schedule/preview', { count: 5 });
  const confirmed = await request<{ count: number; snapshot: Snapshot }>(base + '/schedule', { token: updated.preview.token });
  assert.equal(confirmed.count, 5);
  assert.ok(confirmed.snapshot.queue.every(item => item.status === 'scheduled'));
  await request(base + '/schedule', { token: updated.preview.token }, 400);
  const firstItem = confirmed.snapshot.queue[0];
  const cancelled = await request<Snapshot>(`/queue/${firstItem.id}/cancel`, {});
  assert.equal(cancelled.queue[0].status, 'cancelled');

  const immediate = await request<Planned>(base + '/schedule/preview', { count: 5, now: true });
  assert.deepEqual(immediate.preview.rows.map(row => row.contactId), [first.id]);
  const sentBatch = await request<{ count: number }>(base + '/schedule', { token: immediate.preview.token });
  assert.equal(sentBatch.count, 1);
  let after = await request<Snapshot>('/workspace');
  for (let attempt = 0; attempt < 100 && !after.queue.some(item => item.status === 'sent'); attempt++) {
    await delay(40);
    after = await request<Snapshot>('/workspace');
  }
  assert.equal(after.queue.at(-1)?.status, 'sent', JSON.stringify(after.queue.at(-1)));
  const synced = await request<{ synced: number; snapshot: Snapshot }>('/gmail/sync', {});
  const sentContact = synced.snapshot.conferences[0].contacts[0];
  assert.equal(synced.synced, 1);
  assert.equal(sentContact.gmailMessageId, 'fake-sent');
  assert.ok(sentContact.sentAt && sentContact.repliedAt);
  const saved = JSON.parse(await readFile(workspacePath, 'utf8')) as Workspace;
  assert.deepEqual(saved.queue.map(item => item.status), ['cancelled', 'scheduled', 'scheduled', 'scheduled', 'scheduled', 'sent']);
});

test('one mailbox alternates conferences by fit and reserves a shared recipient until cancellation', { timeout: 15_000 }, async t => {
  const now = Date.now();
  const earlier = 'earlier-conference';
  const later = 'later-conference';
  const shared = 'shared-attendee@example.org';
  const weakerMatch = { ...exampleContact(12, 'connector'), email: shared };
  const strongerMatch = { ...exampleContact(20, 'direct'), email: shared.toUpperCase() };
  const eventFields = { createdAt: new Date(now).toISOString(), sources: [], notes: [], needsRoster: false };
  const { request } = await isolatedWorkspace(t, {
    conferences: [
      {
        ...eventFields, id: earlier, title: 'Earlier Operations Forum', startDate: localDate(new Date(now + 2 * 86_400_000)),
        contacts: [exampleContact(10, 'direct'), exampleContact(11, 'direct'), weakerMatch, exampleContact(13, 'connector')],
      },
      {
        ...eventFields, id: later, title: 'Later Commissioning Summit', startDate: localDate(new Date(now + 3 * 86_400_000)),
        contacts: [strongerMatch, exampleContact(21, 'direct'), exampleContact(22, 'connector')],
      },
    ],
    queue: [], jobs: [], icp: defaultIcp,
  });

  const first = await request<Planned>('/schedule/preview', { count: 6, conferenceIds: [earlier, later] });
  const { rows } = first.preview;
  assert.equal(first.preview.account, mailbox);
  assert.equal(first.preview.duplicateCount, 1);
  assert.equal(first.snapshot.queue.length, 0);
  assert.deepEqual(rows.map(row => row.conferenceId), [earlier, later, earlier, later, earlier, later]);
  assert.deepEqual(rows.map(row => row.bucket), ['direct', 'direct', 'direct', 'direct', 'connector', 'connector']);
  const sharedRows = rows.filter(row => row.email.toLowerCase() === shared);
  assert.equal(sharedRows.length, 1);
  assert.equal(sharedRows[0].contactId, strongerMatch.id);
  assert.equal(sharedRows[0].conferenceTitle, 'Later Commissioning Summit');
  assert.match(sharedRows[0].body, /Later Commissioning Summit/);
  const times = rows.map(row => Date.parse(row.scheduledAt));
  assert.ok(times.slice(1).every((time, index) => time - times[index] >= SCHEDULE_GAP_MS));

  const stale = await request<Planned>('/schedule/preview', { count: 5, conferenceIds: [earlier] });
  assert.ok(stale.preview.rows.some(row => row.contactId === weakerMatch.id));
  const confirmed = await request<{ count: number; snapshot: Snapshot }>('/schedule', { token: first.preview.token });
  assert.equal(confirmed.count, 6);
  assert.deepEqual(confirmed.snapshot.queue.map(item => [item.conferenceId, item.contactId, item.account, item.scheduledAt]),
    rows.map(row => [row.conferenceId, row.contactId, mailbox, row.scheduledAt]));
  await request('/schedule', { token: stale.preview.token }, 400);

  const draftExport = await request<{ held: number; synced: number; snapshot: Snapshot }>(`/conferences/${earlier}/gmail-drafts`, { contactId: weakerMatch.id });
  assert.equal(draftExport.held, 1);
  assert.equal(draftExport.synced, 0);
  assert.equal(draftExport.snapshot.conferences[0].contacts.find(row => row.id === weakerMatch.id)?.previouslyContacted, undefined);
  await request('/schedule/preview', { count: 5, conferenceIds: [earlier] }, 400);

  const sharedItem = confirmed.snapshot.queue.find(item => item.contactId === strongerMatch.id)!;
  await request(`/queue/${sharedItem.id}/cancel`, {});
  const released = await request<Planned>('/schedule/preview', { count: 5, conferenceIds: [earlier] });
  assert.deepEqual(released.preview.rows.map(row => row.contactId), [weakerMatch.id]);
  const rebooked = await request<{ count: number; snapshot: Snapshot }>('/schedule', { token: released.preview.token });
  const activeShared = rebooked.snapshot.queue.filter(item => item.email.toLowerCase() === shared && item.status === 'scheduled');
  assert.deepEqual(activeShared.map(item => item.conferenceId), [earlier]);
});
