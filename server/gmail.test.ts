import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  createGmailAuthorization,
  createGmailDraft,
  findGmailDraft,
  findPriorGmailOutreach,
  finishGmailAuthorization,
  gmailMessageId,
  inspectGmailThread,
  sendGmailDraft,
  updateGmailDraft,
} from './gmail.ts'
import { generateScheduleSlots } from './schedule.ts'

const config = {
  clientId: 'test-id',
  clientSecret: 'test-secret',
  redirectUri: 'http://127.0.0.1:4173/api/gmail/callback',
}

const from = 'sender@example.com'
const to = 'attendee@example.org'
const draft = {
  from,
  to,
  subject: 'Quick intro at the data center summit with a longer Unicode subject ☀️',
  body: 'Hi Chris,\n\nCould we meet at the summit?\n\nShreshth',
  messageId: gmailMessageId('example-event', 'contact-1'),
}

test('Gmail OAuth requires state, PKCE, both scopes and a refresh token', async (t) => {
  const auth = createGmailAuthorization(config)
  const url = new URL(auth.url)
  const scopes = url.searchParams.get('scope')
  assert.equal(url.searchParams.get('state'), auth.pending.state)
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(auth.pending.verifier).digest('base64url'))
  const mock = t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    const target = new URL(input)
    if (target.hostname === 'oauth2.googleapis.com') {
      assert.equal((init.body as URLSearchParams).get('code_verifier'), auth.pending.verifier)
      return Response.json({ access_token: 'access', refresh_token: 'refresh', scope: scopes })
    }
    assert.equal(target.pathname, '/gmail/v1/users/me/profile')
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer access')
    return Response.json({ emailAddress: from.toUpperCase() })
  })
  await assert.rejects(finishGmailAuthorization(config, auth.pending, { code: 'code', state: 'wrong' }), { status: 400 })
  assert.equal(mock.mock.callCount(), 0)
  assert.deepEqual(
    await finishGmailAuthorization(config, auth.pending, { code: 'code', state: auth.pending.state }),
    { email: from, refreshToken: 'refresh' },
  )
})

test('Gmail only sends the approved single-recipient draft content', async (t) => {
  let raw = ''
  let attempted = false
  const beforeSend = () => { attempted = true }
  const mock = t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    const url = new URL(input)
    const resource = url.pathname.split('/').at(-1)
    if (init.method === 'GET') {
      assert.equal(resource, 'draft-1')
      assert.equal(url.searchParams.get('format'), 'raw')
      return Response.json({ id: 'draft-1', message: { raw } })
    }
    const body = JSON.parse(init.body as string)
    if (resource === 'send') {
      assert.equal(attempted, true)
      assert.equal(body.id, 'draft-1')
      assert.equal(body.message.raw, raw)
      return Response.json({ id: 'sent-1', threadId: 'thread-1' })
    }
    assert.equal(init.method, resource === 'drafts' ? 'POST' : 'PUT')
    raw = body.message.raw
    return Response.json({ id: 'draft-1', message: { id: 'draft-msg', threadId: 'thread-1' } })
  })
  await createGmailDraft('token', draft)
  assert.match(Buffer.from(raw, 'base64url').toString(), /Message-ID: <[^>]+@conference-desk\.local>/)
  assert.throws(() => createGmailDraft('token', { ...draft, to: `${to}\r\nBcc: other@example.org` }), { status: 400 })
  await updateGmailDraft('token', 'draft-1', { ...draft, body: 'New message' })
  const expected = { recipient: to, from, subject: draft.subject, messageId: draft.messageId }
  await assert.rejects(sendGmailDraft('token', 'draft-1', { ...expected, body: draft.body }, beforeSend), { status: 409 })
  assert.equal(attempted, false)
  assert.equal(mock.mock.callCount(), 3)
  assert.equal((await sendGmailDraft('token', 'draft-1', { ...expected, body: 'New message' }, beforeSend)).id, 'sent-1')
})

test('Gmail lookup recovers a stable draft ID and checks exact prior recipients', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input)
    const label = url.searchParams.get('labelIds')
    const resource = url.pathname.split('/').at(-1)
    if (resource === 'messages' && label === 'DRAFT') {
      assert.equal(url.searchParams.get('q'), `rfc822msgid:<${draft.messageId}>`)
      return Response.json({ messages: [{ id: 'draft-msg', threadId: 'thread-1' }] })
    }
    if (resource === 'drafts') {
      if (!url.searchParams.has('pageToken')) return Response.json({ drafts: [], nextPageToken: 'next' })
      return Response.json({ drafts: [{ id: 'draft-1', message: { id: 'draft-msg', threadId: 'thread-1' } }] })
    }
    if (resource === 'messages' && label === 'SENT') {
      assert.equal(url.searchParams.get('q'), `to:"${to}"`)
      return Response.json({ messages: [{ id: 'wrong' }, { id: 'exact', threadId: 'prior-thread' }] })
    }
    assert.ok(resource === 'exact' || resource === 'wrong')
    assert.deepEqual(url.searchParams.getAll('metadataHeaders'), ['To', 'Subject'])
    return Response.json({
      id: resource,
      internalDate: '1793961600000',
      labelIds: ['SENT'],
      payload: { headers: [
        { name: 'To', value: resource === 'exact' ? `"Last, First" <${to}>` : 'attendee@example.org.other.com' },
        { name: 'Subject', value: 'Earlier outreach' },
      ] },
    })
  })
  assert.equal((await findGmailDraft('token', draft.messageId))?.id, 'draft-1')
  const prior = await findPriorGmailOutreach('token', to)
  assert.equal(prior?.id, 'exact')
  assert.equal(prior.threadId, 'prior-thread')
  assert.equal(prior.recipient, to)
  assert.equal(prior.internalDate, '1793961600000')
  assert.equal(prior.sentAt, new Date(1793961600000).toISOString())
  assert.equal(prior.subject, 'Earlier outreach')
})

test('Gmail sync counts replies from the attendee after the tracked message', async (t) => {
  const header = (name: string, value: string) => ({ name, value })
  const message = (id: string, time: number, labelIds: string[], headers: { name: string; value: string }[]) => ({
    id,
    internalDate: String(time),
    labelIds,
    payload: { headers },
  })
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const url = new URL(input)
    assert.equal(url.searchParams.get('format'), 'metadata')
    return Response.json({ messages: [
      message('old', 10, ['INBOX'], [header('From', to)]),
      message('sent', 20, ['SENT'], [header('To', to), header('Message-ID', `<${draft.messageId}>`)]),
      message('auto', 30, ['INBOX'], [header('From', to), header('Auto-Submitted', 'auto-replied')]),
      message('reply', 40, ['INBOX'], [header('From', `Attendee <${to}>`)]),
      message('other', 50, ['INBOX'], [header('From', 'other@example.org')]),
      message('draft', 60, ['DRAFT'], [header('From', to)]),
    ] })
  })
  assert.deepEqual(await inspectGmailThread('token', { threadId: 'thread', rfcMessageId: draft.messageId, recipient: to }), {
    sentMessageId: 'sent',
    sentAt: new Date(20).toISOString(),
    replyCount: 1,
    firstReplyAt: new Date(40).toISOString(),
  })
})

test('Gmail recovers a manual send only with strong evidence from the exported draft thread', async (t) => {
  const sent = (id: string, internalDate: string, recipient: string, subject: string) => ({
    id, internalDate, labelIds: ['SENT'], payload: { headers: [
      { name: 'To', value: recipient },
      { name: 'Subject', value: subject },
      { name: 'Message-ID', value: `<${id}@gmail.example>` },
    ] },
  })
  const encoded = `=?UTF-8?B?${Buffer.from(draft.subject).toString('base64')}?=`
  const messages = [
    sent('older', '10', to, encoded),
    sent('different-subject', '22', to, 'Changed subject'),
    sent('different-address', '23', 'other@example.org', encoded),
    sent('multiple-recipients', '24', `Other <other@example.org>, Attendee <${to}>`, encoded),
    sent('manual-send', '25', to, encoded),
  ]
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(new URL(url).pathname, '/gmail/v1/users/me/threads/draft-thread')
    assert.ok(new URL(url).searchParams.getAll('metadataHeaders').includes('Subject'))
    return Response.json({ messages })
  })
  const input = { threadId: 'draft-thread', recipient: to, rfcMessageId: draft.messageId, draftSubject: draft.subject }
  assert.equal(await inspectGmailThread('token', input), null)
  const recovery = { ...input, draftExportedAt: new Date(20).toISOString() }
  assert.equal((await inspectGmailThread('token', recovery))?.sentMessageId, 'manual-send')
  assert.equal(await inspectGmailThread('token', { ...recovery, sentMessageId: 'missing-known-send' }), null)
  messages.push(sent('second-send', '26', to, encoded))
  assert.equal(await inspectGmailThread('token', recovery), null)
})

test('scheduler uses the next Chicago date, avoids collisions and stays within cutoff', () => {
  const now = new Date('2026-10-31T23:10:00Z')
  const occupied = ['2026-11-01T15:11:00.000Z', '2026-11-01T19:20:00.000Z']
  assert.deepEqual(generateScheduleSlots({ count: 5, now, occupied }), [
    '2026-11-01T15:20:00.000Z',
    '2026-11-01T15:25:00.000Z',
    '2026-11-01T15:30:00.000Z',
    '2026-11-01T19:25:00.000Z',
    '2026-11-01T19:30:00.000Z',
  ])
  assert.deepEqual(generateScheduleSlots({ count: 5, now, occupied, latestDate: '2026-10-31' }), [])
  assert.equal(generateScheduleSlots({ count: 5, now, occupied, after: '2026-11-01T19:30:00.000Z' })[0], '2026-11-01T19:35:00.000Z')
  assert.equal(generateScheduleSlots({ count: 1, now: new Date('2026-03-08T04:00:00Z'), occupied: [] })[0], '2026-03-08T14:10:00.000Z')
})
