import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const GOOGLE_AUTHORIZATION = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.readonly',
]

export interface GmailConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export interface GmailAccount {
  email: string
  refreshToken: string
}

export interface GmailAuthorization {
  state: string
  verifier: string
  expiresAt: number
}

export interface GmailMessage {
  id: string
  threadId: string
  internalDate?: string
  labelIds?: string[]
  payload?: { headers?: Array<{ name: string; value: string }> }
}

export interface GmailDraft {
  id: string
  message: GmailMessage
}

export interface GmailDraftInput {
  to: string
  subject: string
  body: string
  messageId: string
  from?: string
}

interface GmailTokens {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  error?: string
}

export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'GmailApiError'
  }
}

export function createGmailAuthorization(config: GmailConfig): {
  url: string
  pending: GmailAuthorization
} {
  const state = randomBytes(32).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const query = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  })
  return {
    url: `${GOOGLE_AUTHORIZATION}?${query}`,
    pending: { state, verifier, expiresAt: Date.now() + 10 * 60_000 },
  }
}

export async function finishGmailAuthorization(
  config: GmailConfig,
  pending: GmailAuthorization | undefined,
  callback: { code?: string | null; state?: string | null },
): Promise<GmailAccount> {
  if (!pending || Date.now() >= pending.expiresAt || !callback.code || !callback.state) {
    throw new GmailApiError(400, 'The Gmail connection request expired or was canceled. Try connecting again.')
  }
  const expected = Buffer.from(pending.state)
  const actual = Buffer.from(callback.state)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new GmailApiError(400, 'The Gmail connection request did not match. Try connecting again.')
  }
  const tokens = await getTokens(config, {
    grant_type: 'authorization_code',
    code: callback.code,
    code_verifier: pending.verifier,
    redirect_uri: config.redirectUri,
  })
  const granted = new Set(tokens.scope?.split(' '))
  if (!tokens.refresh_token || !SCOPES.every((scope) => granted.has(scope))) {
    throw new GmailApiError(403, 'Gmail needs both mailbox permissions and offline access to draft, schedule, and track replies.')
  }
  const profile = await gmail<{ emailAddress?: string }>(tokens.access_token, '/profile')
  if (!profile.emailAddress || !validMailbox(profile.emailAddress)) {
    throw new GmailApiError(502, 'Google did not return a valid mailbox.')
  }
  return { email: profile.emailAddress.toLowerCase(), refreshToken: tokens.refresh_token }
}

let cachedAccess: { account: GmailAccount; clientId: string; token: string; expiresAt: number } | undefined

export async function getGmailAccessToken(config: GmailConfig, account: GmailAccount): Promise<string> {
  if (cachedAccess?.account.refreshToken === account.refreshToken && cachedAccess.clientId === config.clientId
    && Date.now() < cachedAccess.expiresAt) {
    return cachedAccess.token
  }
  const tokens = await getTokens(config, {
    grant_type: 'refresh_token',
    refresh_token: account.refreshToken,
  })
  cachedAccess = {
    account,
    clientId: config.clientId,
    token: tokens.access_token,
    expiresAt: Date.now() + Math.max((tokens.expires_in ?? 0) * 1000 - 60_000, 0),
  }
  return tokens.access_token
}

async function getTokens(config: GmailConfig, fields: Record<string, string>): Promise<GmailTokens> {
  const response = await googleFetch(GOOGLE_TOKEN, {
    method: 'POST',
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...fields }),
  })
  const tokens = await response.json().catch(() => null) as GmailTokens | null
  if (!response.ok || !tokens?.access_token) {
    const reconnect = tokens?.error === 'invalid_grant' && fields.grant_type === 'refresh_token'
    throw new GmailApiError(reconnect ? 401 : response.ok ? 502 : response.status, reconnect
      ? 'The Gmail connection expired. Reconnect the same mailbox to resume.'
      : 'Google could not authorize Gmail. Check the OAuth settings and try again.')
  }
  return tokens
}

async function googleFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000) })
  } catch {
    throw new GmailApiError(502, 'Google did not respond. Check Gmail before retrying a draft or send.')
  }
}

async function gmail<T>(token: string, path: string, body?: unknown, method = body ? 'POST' : 'GET'): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (body) headers['Content-Type'] = 'application/json'
  const response = await googleFetch(GMAIL + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  if (!response.ok) {
    if (response.status === 401) cachedAccess = undefined
    throw new GmailApiError(response.status, response.status === 401
      ? 'Gmail needs to reconnect before continuing.'
      : `Gmail returned HTTP ${response.status}.`)
  }
  return response.json().catch(() => {
    throw new GmailApiError(502, 'Google returned an unreadable response. Check Gmail before retrying a draft or send.')
  }) as Promise<T>
}

export function gmailMessageId(conferenceId: string, attendeeId: string): string {
  const hash = createHash('sha256').update(JSON.stringify([conferenceId, attendeeId])).digest('hex')
  return `${hash}@conference-desk.local`
}

function validMailbox(email: string): boolean {
  const [local, domain, extra] = email.split('@')
  return extra === undefined && email.length <= 254 && local.length <= 64
    && /^[a-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+\/=?^_`{|}~-]+)*$/i.test(local)
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(domain ?? '')
}

function requireMessageId(messageId: string): string {
  const bare = messageId.replace(/^<|>$/g, '')
  if (!/^[a-z\d._+-]+@[a-z\d.-]+$/i.test(bare)) {
    throw new GmailApiError(400, 'The draft has an invalid Message-ID.')
  }
  return bare
}

function encodedSubject(subject: string): string {
  // Encoded words are limited to 75 characters and must preserve UTF-8 code points.
  const chunks: string[] = []
  let chunk = ''
  for (const character of subject) {
    if (Buffer.byteLength(chunk + character, 'utf8') > 42) {
      chunks.push(chunk)
      chunk = ''
    }
    chunk += character
  }
  chunks.push(chunk)
  return chunks.map((value) => `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`).join('\r\n ')
}

function draftMessage(input: GmailDraftInput): { raw: string } {
  const to = input.to.trim()
  const from = input.from?.trim()
  const subject = input.subject.trim()
  if (!validMailbox(to) || (from && !validMailbox(from))) {
    throw new GmailApiError(400, 'The draft needs one valid recipient address and a valid sending mailbox.')
  }
  if (!subject || /[\x00-\x1f\x7f]/.test(input.subject) || !input.body.trim()) {
    throw new GmailApiError(400, 'The draft needs a subject on one line and a message body.')
  }
  const messageId = requireMessageId(input.messageId)
  const body = Buffer.from(input.body.replace(/\r?\n|\r/g, '\r\n')).toString('base64').match(/.{1,76}/g)!.join('\r\n')
  const mime = [
    ...(from ? [`From: ${from}`] : []),
    `To: ${to}`,
    `Subject: ${encodedSubject(subject)}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n')
  return { raw: Buffer.from(mime).toString('base64url') }
}

export function createGmailDraft(token: string, input: GmailDraftInput): Promise<GmailDraft> {
  return gmail<GmailDraft>(token, '/drafts', { message: draftMessage(input) })
}

export function updateGmailDraft(token: string, draftId: string, input: GmailDraftInput): Promise<GmailDraft> {
  return gmail<GmailDraft>(token, `/drafts/${encodeURIComponent(draftId)}`, {
    id: draftId,
    message: draftMessage(input),
  }, 'PUT')
}

function header(message: GmailMessage, name: string): string {
  return message.payload?.headers?.find((value) => value.name.toLowerCase() === name)?.value.trim() ?? ''
}

function mailbox(headerValue: string): string {
  if (/[,;]/.test(headerValue.replace(/"(?:\\.|[^"\\])*"/g, ''))) return ''
  const address = headerValue.match(/<([^<>]+)>$/)?.[1] ?? headerValue
  return address.trim().toLowerCase()
}

export async function getGmailDraft(token: string, draftId: string, format: 'metadata' | 'raw' = 'metadata'):
Promise<(GmailDraft & { message: { raw?: string } }) | null> {
  try {
    return await gmail(token, `/drafts/${encodeURIComponent(draftId)}?format=${format}`)
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) return null
    throw error
  }
}

function quotedPrintable(text: string): string {
  const unfolded = text.replace(/=\r?\n/g, '')
  return Buffer.from(unfolded.replace(/=([0-9a-f]{2})/gi, (_, byte) => String.fromCharCode(Number.parseInt(byte, 16))), 'latin1').toString()
}

function decodeSubject(subject: string): string {
  return subject
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?(?:UTF-8|US-ASCII)\?([BQ])\?([^?]*)\?=/gi, (_, encoding, value) => (
      encoding.toUpperCase() === 'B'
        ? Buffer.from(value, 'base64').toString()
        : quotedPrintable(value.replace(/_/g, ' '))
    ))
}

function inspectDraftMime(message: GmailDraft['message'] & { raw?: string }): { message: GmailMessage; body: string | null } {
  if (!message.raw) return { message, body: null }
  const raw = Buffer.from(message.raw, 'base64url').toString()
  const boundary = /\r?\n\r?\n/.exec(raw)
  if (!boundary) return { message, body: null }
  const headers = raw.slice(0, boundary.index).replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)
    .flatMap((line) => {
      const match = /^([^:]+):(.*)$/.exec(line)
      return match ? [{ name: match[1].toLowerCase(), value: match[2].trim() }] : []
    })
  const parsed = { ...message, payload: { headers } }
  const contentType = header(parsed, 'content-type').split(';')[0].toLowerCase()
  if (contentType !== 'text/plain') return { message: parsed, body: null }
  const encoding = header(parsed, 'content-transfer-encoding').toLowerCase()
  const encoded = raw.slice(boundary.index + boundary[0].length)
  let body = null
  if (encoding === 'base64') body = Buffer.from(encoded, 'base64').toString()
  if (encoding === 'quoted-printable') body = quotedPrintable(encoded)
  if (!encoding || encoding === '7bit' || encoding === '8bit') body = encoded
  return { message: parsed, body }
}

function normalizedBody(body: string): string {
  return body.replace(/\r\n?/g, '\n').trimEnd()
}

export async function sendGmailDraft(
  token: string,
  draftId: string,
  expected: { recipient: string; messageId?: string; subject?: string; body?: string; from?: string },
  beforeSend?: () => void | Promise<void>,
): Promise<GmailMessage> {
  const verifyContent = expected.subject !== undefined || expected.body !== undefined
  const draft = await getGmailDraft(token, draftId, verifyContent ? 'raw' : 'metadata')
  if (!draft) throw new GmailApiError(404, 'The Gmail draft is missing. Check whether it was already sent.')
  const { message, body } = inspectDraftMime(draft.message)
  const to = header(message, 'to')
  const messageId = header(message, 'message-id').replace(/^<|>$/g, '')
  const recipients = message.payload?.headers?.filter(({ name }) => /^(?:to|(?:resent-)?(?:cc|bcc)|resent-to)$/i.test(name)) ?? []
  if (!validMailbox(expected.recipient) || mailbox(to) !== expected.recipient.toLowerCase()
    || recipients.length !== 1
    || (expected.messageId && messageId !== requireMessageId(expected.messageId))
    || (expected.from && mailbox(header(message, 'from')) !== expected.from.toLowerCase())
    || (expected.subject !== undefined && decodeSubject(header(message, 'subject')) !== expected.subject.trim())
    || (expected.body !== undefined && (body === null || normalizedBody(body) !== normalizedBody(expected.body)))) {
    throw new GmailApiError(409, 'The Gmail draft changed after it was queued. Review it in Gmail before scheduling again.')
  }
  // Supplying the reviewed content in this request keeps a simultaneous Gmail edit
  // from changing the message between verification and the send.
  const approved = expected.messageId && expected.subject !== undefined && expected.body !== undefined
    ? draftMessage({ to: expected.recipient, subject: expected.subject, body: expected.body, from: expected.from, messageId: expected.messageId })
    : undefined
  await beforeSend?.()
  return gmail<GmailMessage>(token, '/drafts/send', { id: draftId, ...(approved ? { message: approved } : {}) })
}

async function findMessage(token: string, rfcMessageId: string, label: 'DRAFT' | 'SENT') {
  const query = new URLSearchParams({
    q: `rfc822msgid:<${requireMessageId(rfcMessageId)}>`,
    labelIds: label,
    maxResults: '2',
  })
  const list = await gmail<{ messages?: GmailMessage[] }>(token, `/messages?${query}`)
  if ((list.messages?.length ?? 0) > 1) {
    throw new GmailApiError(409, 'More than one Gmail message matches this draft. Review the matching messages in Gmail.')
  }
  return list.messages?.[0] ?? null
}

export async function findGmailDraft(token: string, rfcMessageId: string): Promise<GmailDraft | null> {
  const message = await findMessage(token, rfcMessageId, 'DRAFT')
  if (!message) return null
  // Gmail searches by message ID, but sending needs the separate stable draft ID.
  let pageToken: string | undefined
  do {
    const query = new URLSearchParams({ maxResults: '500' })
    if (pageToken) query.set('pageToken', pageToken)
    const page: { drafts?: GmailDraft[]; nextPageToken?: string } = await gmail(token, `/drafts?${query}`)
    const match = page.drafts?.find((draft) => draft.message.id === message.id)
    if (match) return match
    pageToken = page.nextPageToken
  } while (pageToken)
  return null
}

export function findGmailSent(token: string, rfcMessageId: string): Promise<GmailMessage | null> {
  return findMessage(token, rfcMessageId, 'SENT')
}

function gmailTime(value?: string): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const time = Number(value)
  return time <= 8.64e15 ? time : undefined
}

function directRecipient(message: GmailMessage): string {
  const headers = message.payload?.headers?.filter(({ name }) => name.toLowerCase() === 'to') ?? []
  return headers.length === 1 ? mailbox(headers[0].value) : ''
}

export interface PriorGmailOutreach extends GmailMessage {
  recipient: string
  sentAt?: string
  subject?: string
}

export async function findPriorGmailOutreach(token: string, recipient: string): Promise<PriorGmailOutreach | null> {
  const email = recipient.trim().toLowerCase()
  if (!validMailbox(email)) throw new GmailApiError(400, 'A valid email address is required to look for earlier outreach.')
  const query = new URLSearchParams({ q: `to:"${email}"`, labelIds: 'SENT', maxResults: '20' })
  const list = await gmail<{ messages?: GmailMessage[] }>(token, `/messages?${query}`)
  const metadata = new URLSearchParams({ format: 'metadata' })
  metadata.append('metadataHeaders', 'To')
  metadata.append('metadataHeaders', 'Subject')
  for (const item of list.messages ?? []) {
    const message = await gmail<GmailMessage>(token, `/messages/${encodeURIComponent(item.id)}?${metadata}`)
    const matchedRecipient = directRecipient(message)
    if (!message.labelIds?.includes('SENT') || matchedRecipient !== email) continue
    const time = gmailTime(message.internalDate)
    return {
      ...message,
      threadId: message.threadId || item.threadId,
      internalDate: time === undefined ? undefined : message.internalDate,
      recipient: matchedRecipient,
      sentAt: time === undefined ? undefined : new Date(time).toISOString(),
      subject: decodeSubject(header(message, 'subject')) || undefined,
    }
  }
  return null
}

export async function inspectGmailThread(token: string, input: {
  threadId: string
  sentMessageId?: string
  rfcMessageId?: string
  draftSubject?: string
  draftExportedAt?: string
  recipient: string
}): Promise<{ sentMessageId: string; sentAt: string; replyCount: number; firstReplyAt?: string } | null> {
  const query = new URLSearchParams({ format: 'metadata' })
  for (const name of ['From', 'To', 'Subject', 'Message-ID', 'Auto-Submitted', 'Precedence']) {
    query.append('metadataHeaders', name)
  }
  let thread: { messages?: GmailMessage[] }
  try {
    thread = await gmail(token, `/threads/${encodeURIComponent(input.threadId)}?${query}`)
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 404) return null
    throw error
  }
  const messages = thread.messages ?? []
  const expectedId = input.rfcMessageId && requireMessageId(input.rfcMessageId)
  const recipient = input.recipient.trim().toLowerCase()
  if (!validMailbox(recipient)) return null
  const sentToRecipient = messages.filter((message) => message.labelIds?.includes('SENT')
    && !message.labelIds.includes('DRAFT') && directRecipient(message) === recipient)
  let sent = sentToRecipient.find((message) => message.id === input.sentMessageId
    || (expectedId && header(message, 'message-id').replace(/^<|>$/g, '') === expectedId))
  const draftSubject = input.draftSubject?.trim()
  if (!sent && !input.sentMessageId && draftSubject && input.draftExportedAt) {
    // Gmail may replace the RFC Message-ID when someone sends an exported draft manually.
    const exportedAt = Date.parse(input.draftExportedAt)
    const matches = sentToRecipient.filter((message) => (gmailTime(message.internalDate) ?? -Infinity) >= exportedAt
      && decodeSubject(header(message, 'subject')) === draftSubject)
    if (matches.length === 1) sent = matches[0]
  }
  const sentAt = gmailTime(sent?.internalDate)
  if (!sent || sentAt === undefined) return null
  const replyTimes: number[] = []
  for (const message of messages) {
    const time = gmailTime(message.internalDate)
    const auto = header(message, 'auto-submitted').toLowerCase()
    const precedence = header(message, 'precedence').toLowerCase()
    if (time !== undefined && time >= sentAt && message.id !== sent.id
      && !message.labelIds?.some((label) => ['SENT', 'DRAFT', 'SPAM', 'TRASH'].includes(label))
      && mailbox(header(message, 'from')) === recipient
      && (!auto || auto === 'no')
      && !['bulk', 'junk', 'list'].includes(precedence)) replyTimes.push(time)
  }
  return {
    sentMessageId: sent.id,
    sentAt: new Date(sentAt).toISOString(),
    replyCount: replyTimes.length,
    firstReplyAt: replyTimes.length ? new Date(Math.min(...replyTimes)).toISOString() : undefined,
  }
}
