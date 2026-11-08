import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { defaultIcp } from '../../../server/default-icp.ts';
import { gmailMessageId } from '../../../server/gmail.ts';
import type { QueueItem, Workspace } from '../../../src/model.ts';
import { beginDeskGoogleAuth, finishDeskGoogleAuth, processDueMail, syncDeskMailbox } from './mail.ts';
import type { DeskState } from './storage.ts';
import { workspaceAction } from './workspace.ts';

const config = { clientId: 'test-client', clientSecret: 'test-secret', redirectUri: 'https://project.example/functions/v1/desk/gmail/callback' };
const mailboxA = 'first@example.com';
const mailboxB = 'second@example.com';

function fixture(prefix: string, accounts: string[]) {
  const queue: QueueItem[] = accounts.map((account, index) => ({
    id: `item-${index}`, conferenceId: 'conference', contactId: `contact-${index}`, account,
    email: `recipient-${index}@example.org`, subject: 'Hello', body: 'Approved outreach',
    scheduledAt: new Date(Date.now() - 3_000 + index).toISOString(), status: 'scheduled',
  }));
  const workspace: Workspace = { icp: defaultIcp, jobs: [], queue, conferences: [{
    id: 'conference', title: 'A conference', createdAt: new Date().toISOString(), needsRoster: false, sources: [], notes: [],
    contacts: queue.map(item => ({ id: item.contactId, name: item.contactId, attendance: 'attendee', bucket: 'direct',
      email: item.email, emailStatus: 'verified', score: 80, reason: 'Test contact' })),
  }] };
  let persisted = structuredClone(workspace);
  const state: DeskState = { workspace,
    secrets: { mailboxes: { [mailboxA]: { email: mailboxA, refreshToken: `${prefix}-${mailboxA}` },
      [mailboxB]: { email: mailboxB, refreshToken: `${prefix}-${mailboxB}` } }, activeMailbox: mailboxB },
    save() { persisted = structuredClone(workspace); return Promise.resolve(); },
  };
  return { state, queue, persisted: () => persisted };
}

async function withGmailEnv(run: () => Promise<void>) {
  const values = { GMAIL_CLIENT_ID: config.clientId, GMAIL_CLIENT_SECRET: config.clientSecret, GMAIL_REDIRECT_URI: config.redirectUri };
  const restore = Object.keys(values).map(key => [key, Deno.env.get(key)] as const);
  const fetch = globalThis.fetch;
  for (const [key, value] of Object.entries(values)) Deno.env.set(key, value);
  try { await run(); }
  finally {
    globalThis.fetch = fetch;
    for (const [key, value] of restore) value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value);
  }
}

function mockMailbox(prefix: string, sent: (mailbox: string, draftId: string) => Response, lookup?: (url: URL) => Response | undefined) {
  const drafts = new Map<string, string>();
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com') {
      const refresh = (init?.body as URLSearchParams).get('refresh_token');
      assert.ok(refresh?.startsWith(`${prefix}-`));
      return Response.json({ access_token: refresh!.slice(prefix.length + 1), expires_in: 3600 });
    }
    assert.equal(url.hostname, 'gmail.googleapis.com');
    const mailbox = new Headers(init?.headers).get('Authorization')?.slice('Bearer '.length);
    assert.ok(mailbox === mailboxA || mailbox === mailboxB);
    const response = lookup?.(url);
    if (response) return response;
    const route = url.pathname.replace('/gmail/v1/users/me', '');
    if (route === '/messages') return Response.json({ messages: [] });
    if (route === '/drafts') {
      const raw = JSON.parse(String(init?.body)).message.raw;
      assert.match(Buffer.from(raw, 'base64url').toString(), new RegExp(`From: ${mailbox}`));
      const draftId = `draft-${mailbox}`;
      drafts.set(draftId, raw);
      return Response.json({ id: draftId, message: { id: 'draft-message', threadId: 'draft-thread' } });
    }
    if (route === '/drafts/send') {
      const { id, message } = JSON.parse(String(init?.body));
      assert.equal(message.raw, drafts.get(id));
      return sent(mailbox, id);
    }
    const draftId = decodeURIComponent(route.slice('/drafts/'.length));
    assert.ok(drafts.has(draftId));
    return Response.json({ id: draftId, message: { raw: drafts.get(draftId) } });
  };
}

Deno.test('Cron uses the mailbox saved with each queued message and fences delivery before calling Gmail', async () => {
  await withGmailEnv(async () => {
    const { state, queue, persisted } = fixture('multiple', [mailboxA, mailboxB, mailboxA]);
    const attempted: string[] = [];
    mockMailbox('multiple', (mailbox, draftId) => {
      const saved = persisted().queue.find(item => item.account === mailbox && item.draftId === draftId);
      assert.equal(saved?.status, 'sending');
      assert.ok(saved.sendingAt);
      attempted.push(mailbox);
      return Response.json({ id: `sent-${mailbox}`, threadId: `thread-${mailbox}` });
    });
    assert.equal(await processDueMail(state), 2);
    assert.deepEqual(attempted, [mailboxA, mailboxB]);
    assert.deepEqual(queue.map(item => item.status), ['sent', 'sent', 'scheduled']);
    assert.equal(await processDueMail(state), 0);
  });
});

Deno.test('A Gmail timeout after the send attempt stays held until its original mailbox proves delivery', async () => {
  await withGmailEnv(async () => {
    const { state, queue, persisted } = fixture('ambiguous', [mailboxA]);
    let sends = 0;
    let delivered = false;
    const messageId = gmailMessageId(queue[0].conferenceId, queue[0].contactId);
    mockMailbox('ambiguous', () => {
      sends++;
      return new Response(null, { status: 502 });
    }, url => {
      if (delivered && url.searchParams.get('q') === `rfc822msgid:<${messageId}>`) {
        return Response.json({ messages: [{ id: 'delivered', threadId: 'delivered-thread' }] });
      }
      if (delivered && url.pathname.endsWith('/threads/delivered-thread')) {
        return Response.json({ messages: [{ id: 'delivered', internalDate: String(Date.now()), labelIds: ['SENT'],
          payload: { headers: [{ name: 'To', value: queue[0].email }, { name: 'Message-ID', value: `<${messageId}>` }] } }] });
      }
    });
    assert.equal(await processDueMail(state), 0);
    assert.equal(persisted().queue[0].status, 'failed');
    assert.ok(persisted().queue[0].sendingAt);
    assert.equal(await processDueMail(state), 0);
    delivered = true;
    assert.equal(await syncDeskMailbox(state, mailboxA), 1);
    assert.equal(persisted().queue[0].status, 'sent');
    assert.equal(sends, 1);
  });
});

Deno.test('Owner Google sign-in verifies the email without requesting Gmail permissions', async () => {
  await withGmailEnv(async () => {
    const { url, pending } = beginDeskGoogleAuth(config, 'login');
    assert.equal(new URL(url).searchParams.get('scope'), 'openid email');
    let verified = false;
    globalThis.fetch = async (input, init) => {
      const target = new URL(String(input));
      if (target.hostname === 'oauth2.googleapis.com') {
        assert.equal((init?.body as URLSearchParams).get('code_verifier'), pending.verifier);
        return Response.json({ access_token: 'test-access' });
      }
      assert.equal(target.hostname, 'openidconnect.googleapis.com');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-access');
      return Response.json({ email: mailboxA.toUpperCase(), email_verified: verified });
    };
    const callback = { state: pending.state, code: 'test-code' };
    await assert.rejects(finishDeskGoogleAuth(config, pending, callback, 'login'), { status: 403 });
    verified = true;
    assert.deepEqual(await finishDeskGoogleAuth(config, pending, callback, 'login'), { email: mailboxA });
  });
});

Deno.test('Mailbox OAuth exchanges the code without a global Buffer', async () => {
  await withGmailEnv(async () => {
    const { url, pending } = beginDeskGoogleAuth(config, 'mailbox');
    const scope = new URL(url).searchParams.get('scope');
    globalThis.fetch = async (input, init) => {
      const target = new URL(String(input));
      if (target.hostname === 'oauth2.googleapis.com') {
        const body = init?.body as URLSearchParams;
        assert.equal(body.get('code'), 'test-code');
        assert.equal(body.get('code_verifier'), pending.verifier);
        return Response.json({ access_token: 'test-access', refresh_token: 'test-refresh', scope });
      }
      assert.equal(target.href, 'https://gmail.googleapis.com/gmail/v1/users/me/profile');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-access');
      return Response.json({ emailAddress: mailboxB.toUpperCase() });
    };
    const globalBuffer = Object.getOwnPropertyDescriptor(globalThis, 'Buffer');
    Object.defineProperty(globalThis, 'Buffer', { value: undefined, configurable: true });
    try {
      assert.deepEqual(
        await finishDeskGoogleAuth(config, pending, { state: pending.state, code: 'test-code' }, 'mailbox'),
        { email: mailboxB, refreshToken: 'test-refresh' },
      );
    } finally {
      if (globalBuffer) Object.defineProperty(globalThis, 'Buffer', globalBuffer);
      else Reflect.deleteProperty(globalThis, 'Buffer');
    }
  });
});

Deno.test('Native Scheduled sync preserves uncertain rows and attributes proven sends to the linked contact', async () => {
  await withGmailEnv(async () => {
    const { state, queue, persisted } = fixture('native', [mailboxA, mailboxA, mailboxA]);
    const event = state.workspace.conferences[0];
    const [prospect, followup, organizer] = event.contacts;
    const oldSentAt = new Date(Date.now() - 86_400_000).toISOString();
    Object.assign(followup, { sentAt: oldSentAt, gmailAccount: mailboxB, gmailMessageId: 'old-send' });
    queue.length = 0;
    const explicitAlias = 'alternate@example.org';
    event.gmailScheduled = [
      { account: mailboxA, gmailMessageId: 'still-scheduled', email: 'another@example.org' },
      { account: mailboxA, gmailMessageId: 'native-sent', email: explicitAlias, contactId: prospect.id },
      { account: mailboxA, gmailMessageId: 'native-followup', email: followup.email!, contactId: followup.id },
      { account: mailboxA, gmailMessageId: 'native-organizer', email: organizer.email!, contactId: organizer.id, purpose: 'organizer' },
      { account: mailboxA, gmailMessageId: 'native-canceled', email: 'canceled@example.org' },
      { account: mailboxA, gmailMessageId: 'native-unknown', email: 'unknown@example.org' },
      { account: mailboxA, gmailMessageId: 'native-failure', email: 'failure@example.org' },
      { account: mailboxB, gmailMessageId: 'other-inbox', email: 'other@example.org' },
    ];
    const reads: string[] = [];
    mockMailbox('native', () => { throw new Error('Scheduled sync must only read Gmail.'); }, url => {
      if (url.searchParams.get('q') === 'in:scheduled') return Response.json({ messages: [{ id: 'still-scheduled' }] });
      const id = url.pathname.split('/').at(-1)!;
      reads.push(id);
      if (id === 'native-unknown') return new Response(null, { status: 404 });
      if (id === 'native-failure') return new Response(null, { status: 503 });
      if (id === 'native-canceled') return Response.json({ id, labelIds: ['DRAFT'] });
      const to = { 'native-sent': explicitAlias, 'native-followup': followup.email, 'native-organizer': organizer.email }[id];
      assert.ok(to);
      return Response.json({ id, threadId: `thread-${id}`, labelIds: ['SENT'], internalDate: String(Date.now()),
        payload: { headers: [{ name: 'To', value: to }, { name: 'From', value: mailboxA }] } });
    });
    await assert.rejects(syncDeskMailbox(state, mailboxA), { status: 503 });
    const saved = persisted().conferences[0];
    assert.deepEqual(saved.gmailScheduled?.map(row => row.gmailMessageId),
      ['still-scheduled', 'native-unknown', 'native-failure', 'other-inbox']);
    assert.equal(saved.contacts[0].gmailMessageId, 'native-sent');
    assert.equal(saved.contacts[0].sentEmail, explicitAlias);
    assert.equal(saved.contacts[1].gmailMessageId, 'old-send');
    assert.equal(saved.contacts[1].sentAt, oldSentAt);
    assert.equal(saved.contacts[2].sentAt, undefined);
    assert.equal(saved.contacts[2].priorOutreach?.gmailMessageId, 'native-organizer');
    assert.ok(!reads.includes('other-inbox'));
    assert.equal(persisted().queue.length, 0);
  });
});

Deno.test('Scheduled discovery requires Desk draft evidence and preserves rows on incomplete Gmail listings', async () => {
  await withGmailEnv(async () => {
    const { state, queue, persisted } = fixture('native-draft', [mailboxA]);
    const event = state.workspace.conferences[0];
    const person = event.contacts[0];
    queue.length = 0;
    person.draft = { subject: 'Event invitation', body: 'Test', gmailId: 'desk-draft', gmailAccount: mailboxA,
      gmailExportedEmail: person.email, gmailThreadId: 'known-thread', gmailExportedSubject: 'Event invitation' };
    event.gmailScheduled = [{ account: mailboxA, gmailMessageId: 'missing-page', email: 'other@example.org' }];
    mockMailbox('native-draft', () => { throw new Error('Scheduled sync must only read Gmail.'); }, url => {
      if (url.searchParams.get('q') === 'in:scheduled') {
        return Response.json({ messages: [{ id: 'desk-native' }, { id: 'unrelated-native' }], nextPageToken: 'next' });
      }
      if (url.pathname.endsWith('/missing-page')) return Response.json({ id: 'missing-page', labelIds: ['DRAFT'] });
      if (url.pathname.endsWith('/threads/known-thread')) return Response.json({ messages: [] });
      const id = url.pathname.split('/').at(-1)!;
      if (!['desk-native', 'unrelated-native'].includes(id)) return undefined;
      return Response.json({ id, threadId: id, payload: { headers: [
        { name: 'From', value: mailboxA }, { name: 'To', value: person.email },
        { name: 'Message-ID', value: id === 'desk-native' ? `<${gmailMessageId(event.id, person.id)}>` : '<unrelated@example.org>' },
      ] } });
    });
    await syncDeskMailbox(state, mailboxA);
    const saved = persisted().conferences[0].gmailScheduled!;
    assert.deepEqual(saved.map(row => row.gmailMessageId), ['missing-page', 'desk-native']);
    assert.equal(saved[1].contactId, person.id);
    assert.equal(saved[1].scheduledAt, undefined);
  });
});

Deno.test('A new Gmail-native timestamp invalidates an existing Desk preview for the same inbox', async () => {
  await withGmailEnv(async () => {
    const { state, queue } = fixture('native-spacing', [mailboxA]);
    queue.length = 0;
    const event = state.workspace.conferences[0];
    const response = await workspaceAction(state, ['schedule', 'preview'], { email: mailboxA, count: 5 });
    assert.ok(response && 'preview' in response);
    event.gmailScheduled = [{ account: mailboxA, gmailMessageId: 'collision', email: 'different@example.org',
      scheduledAt: response.preview.rows[0].scheduledAt }];
    await assert.rejects(workspaceAction(state, ['schedule', 'confirm'], { token: response.preview.token }), /Review a fresh batch/);
    assert.equal(queue.length, 0);
  });
});
