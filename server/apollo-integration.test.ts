import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { ApolloPreview, Snapshot, Workspace } from '../src/model';
import { defaultIcp } from './default-icp';

const eventId = 'apollo-fixture-event';
const recipientId = 'apollo-fixture-attendee';
const requestId = '1039995589705121975';
const workEmail = 'jamie.lee@example.org';

const preload = String.raw`
const realNow = Date.now;
const setRealInterval = globalThis.setInterval;
let offset = 0;
Date.now = () => realNow() + offset;
globalThis.setInterval = (task, interval, ...args) => setRealInterval(task, interval === 5000 ? 35 : interval, ...args);
process.on('message', message => {
  if (typeof message?.advance === 'number') {
    offset += message.advance;
    process.send({ offset });
  }
});
globalThis.fetch = () => Promise.reject(new Error('External network is disabled for the Apollo integration test'));
`;

function fakeCodex(auditPath: string) {
  return `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const assert = require('node:assert/strict');
const [command] = process.argv.slice(2);
if (command === 'login') {
  process.stdout.write('Logged in using ChatGPT\\n');
} else if (command === 'mcp') {
  process.stdout.write('[]');
} else {
  assert.equal(command, 'app-server');
  assert.ok(process.argv.some(arg => arg.includes('https://mcp.apollo.io/mcp')));
  const send = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
  const audit = frame => appendFileSync(${JSON.stringify(auditPath)}, JSON.stringify(frame) + '\\n');
  const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  let polls = 0;
  createInterface({ input: process.stdin }).on('line', line => {
    const frame = JSON.parse(line);
    if (frame.method === 'initialized') return;
    let output = {};
    if (frame.method === 'mcpServerStatus/list') {
      output = { data: [{ name: 'apollo', authStatus: 'oAuth', tools: {
        apollo_users_api_profile: {}, apollo_people_match: {}, apollo_webhook_result_show: {},
      } }] };
    } else if (frame.method === 'thread/start') {
      output = { thread: { id: 'fixture-thread' } };
    } else if (frame.method === 'mcpServer/tool/call') {
      const { tool, arguments: args } = frame.params;
      audit({ tool, args });
      assert.equal(frame.params.server, 'apollo');
      if (tool === 'apollo_users_api_profile') {
        assert.equal(args.include_waterfall_capability, true);
        output = result({ waterfall_email_enabled: true });
      } else if (tool === 'apollo_people_match') {
        assert.equal(args.name, 'Jamie Lee');
        assert.equal(args.organization_name, 'Example Systems');
        assert.equal(args.run_waterfall_email, true);
        assert.equal(args.run_waterfall_phone, false);
        assert.equal(args.reveal_phone_number, false);
        assert.equal(args.reveal_personal_emails, false);
        output = result({
          request_id: ${JSON.stringify(requestId)}, waterfall: { status: 'accepted' }, match_confidence: 'high',
          person: { id: 'fixture-person', name: 'Jamie Lee', organization: { name: 'Example Systems' } },
        });
      } else if (tool === 'apollo_webhook_result_show') {
        assert.equal(args.request_id, ${JSON.stringify(requestId)});
        output = polls++ === 0
          ? { ...result({ error_code: 'result_pending', error_details: { retry_after_seconds: 25 } }), isError: true }
          : result({ request_id: ${JSON.stringify(requestId)}, webhook_result: {
            status: 'success', credits_consumed: 2,
            people: [{ id: 'fixture-person', emails: [{ email: ${JSON.stringify(workEmail)}, email_status_cd: 'Verified' }] }],
          } });
      } else {
        throw new Error('Unexpected fixture tool ' + tool);
      }
    } else {
      assert.equal(frame.method, 'initialize');
    }
    send({ id: frame.id, result: output });
  });
}
`;
}

async function freePort() {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  let value = await read();
  for (let attempt = 0; !ready(value) && attempt < 120; attempt++) {
    await delay(25);
    value = await read();
  }
  assert.ok(ready(value), JSON.stringify(value));
  return value;
}

test('Apollo waterfall requires exact approval and persists a paid lookup once while polling its result', { timeout: 15_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'conference-desk-apollo-test-'));
  const workspacePath = join(directory, 'workspace.json');
  const auditPath = join(directory, 'codex-audit.jsonl');
  const preloadPath = join(directory, 'clock.mjs');
  const binary = join(directory, 'codex');
  const initial: Workspace = {
    conferences: [{
      id: eventId, title: 'Example Commissioning Forum', createdAt: new Date().toISOString(),
      needsRoster: false, sources: [], notes: [],
      contacts: [
        { id: recipientId, name: 'Jamie Lee', company: 'Example Systems', title: 'Commissioning Manager', attendance: 'attendee', bucket: 'direct', score: 98, reason: 'Fixture' },
        { id: 'fixture-next', name: 'Morgan Smith', company: 'Other Systems', title: 'Commissioning Manager', attendance: 'attendee', bucket: 'direct', score: 90, reason: 'Fixture' },
      ],
    }],
    queue: [], jobs: [], icp: defaultIcp,
  };
  await Promise.all([
    writeFile(workspacePath, JSON.stringify(initial)),
    writeFile(preloadPath, preload),
    writeFile(binary, fakeCodex(auditPath), { mode: 0o700 }),
    writeFile(auditPath, ''),
  ]);
  const origin = `http://127.0.0.1:${await freePort()}`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--import', preloadPath, 'server/index.ts'], {
    env: {
      ...process.env, PORT: new URL(origin).port, NODE_ENV: 'production', CONFERENCE_DATA_DIR: directory, CODEX_BIN: binary,
      GMAIL_CLIENT_ID: '', GMAIL_CLIENT_SECRET: '', APOLLO_API_KEY: '', AUTUMN_API_KEY: '', EXA_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    try { await exited; }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  let logs = '';
  assert.ok(child.stdout && child.stderr);
  child.stdout.on('data', chunk => { logs += String(chunk); });
  child.stderr.on('data', chunk => { logs += String(chunk); });
  await until(async () => logs, value => /Conference Desk is running/.test(value));

  async function request<T>(path: string, body?: object, status = 200): Promise<T> {
    const response = await fetch(origin + '/api' + path, {
      method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result as T;
  }

  async function advance(milliseconds: number) {
    const acknowledged = once(child, 'message');
    child.send({ advance: milliseconds });
    await acknowledged;
  }

  async function audit() {
    return (await readFile(auditPath, 'utf8')).trim().split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { tool: string; args: Record<string, unknown> });
  }

  const base = `/conferences/${eventId}/enrich`;
  const checked = await request<{ snapshot: Snapshot }>('/connections/mcp/check', { provider: 'apollo' });
  assert.equal(checked.snapshot.connections.mcp?.apollo?.status, 'connected');
  const preview = await request<ApolloPreview>(base + '/apollo-preview', {});
  assert.equal(preview.mode, 'waterfall');
  assert.deepEqual(preview.people, ['Jamie Lee · Example Systems']);
  assert.equal(preview.available, 2);
  assert.match(preview.estimate || '', /typically|typical/i);

  await request(base, { provider: 'apollo', token: preview.token, approvedMode: 'standard' }, 400);
  await request(base, { provider: 'apollo', token: preview.token + '-tampered', approvedMode: 'waterfall' }, 400);
  assert.deepEqual((await audit()).map(call => call.tool), ['apollo_users_api_profile']);
  assert.equal((await request<Snapshot>('/workspace')).apolloRuns?.length || 0, 0);

  const approved = await request<Snapshot & { apolloRunId: string }>(base,
    { provider: 'apollo', token: preview.token, approvedMode: 'waterfall', limit: 10 }, 202);
  assert.equal(approved.apolloRuns?.length, 1);
  const run = approved.apolloRuns?.[0];
  assert.equal(run?.id, approved.apolloRunId);
  assert.equal(run?.recipients[0].status, 'queued');
  assert.deepEqual(run?.recipients.map(row => row.contactId), [recipientId]);
  await request(base, { provider: 'apollo', token: preview.token, approvedMode: 'waterfall' }, 400);

  const pending = await until(() => request<Snapshot>('/workspace'), value => value.apolloRuns?.[0]?.recipients[0]?.status === 'pending');
  const firstPollAt = pending.apolloRuns?.[0]?.recipients[0]?.nextCheckAt ?? 0;
  assert.equal(pending.apolloRuns?.[0]?.recipients[0]?.requestId, requestId);
  assert.ok(firstPollAt >= Date.parse(run!.approvedAt) + 15_000);
  assert.equal(pending.conferences[0].contacts[0].email, undefined);
  await delay(120);
  assert.deepEqual((await audit()).map(call => call.tool), ['apollo_users_api_profile', 'apollo_people_match']);

  await advance(20_000);
  const waiting = await until(() => request<Snapshot>('/workspace'),
    value => (value.apolloRuns?.[0]?.recipients[0]?.nextCheckAt ?? 0) > firstPollAt);
  assert.equal(waiting.apolloRuns?.[0]?.recipients[0]?.status, 'pending');
  assert.deepEqual((await audit()).map(call => call.tool),
    ['apollo_users_api_profile', 'apollo_people_match', 'apollo_webhook_result_show']);

  await advance(30_000);
  const matched = await until(() => request<Snapshot>('/workspace'), value => value.apolloRuns?.[0]?.recipients[0]?.status === 'matched');
  assert.equal(matched.conferences[0].contacts[0].email, workEmail);
  assert.equal(matched.conferences[0].contacts[0].emailStatus, 'verified');
  assert.equal(matched.conferences[0].contacts[1].email, undefined);
  const persisted = JSON.parse(await readFile(workspacePath, 'utf8')) as Workspace;
  const outcome = persisted.apolloRuns?.[0]?.recipients[0];
  assert.equal(outcome?.status, 'matched');
  assert.equal(outcome?.email, workEmail);
  assert.equal(outcome?.creditsUsed, 2);
  assert.equal(persisted.conferences[0].contacts[0].emailSource, 'Apollo waterfall');
  const calls = await audit();
  assert.deepEqual(calls.map(call => call.tool),
    ['apollo_users_api_profile', 'apollo_people_match', 'apollo_webhook_result_show', 'apollo_webhook_result_show']);
  assert.ok(calls.slice(2).every(call => call.args.request_id === requestId));
});
