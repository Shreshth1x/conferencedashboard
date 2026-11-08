import { createHash } from 'node:crypto';
import { isPast, rankContacts, type Conference, type Contact, type QueueItem, type Workspace } from '../../../src/model.ts';
import {
  createGmailAuthorization, createGmailDraft, findGmailDraft, findGmailSent, findPriorGmailOutreach,
  finishGmailAuthorization, getGmailAccessToken, GmailApiError, gmailMessageId, inspectGmailThread,
  sendGmailDraft, updateGmailDraft, type GmailAccount, type GmailAuthorization, type GmailConfig,
  type GmailDraft, type GmailDraftInput, type GmailMessage, type PriorGmailOutreach,
} from '../../../server/gmail.ts';
import { canReachContact, isOutreachOpen, outreachContactKeys, outreachDraftOwners, outreachReservations } from '../../../server/outreach-planner.ts';
import { writeDraft } from '../../../server/outbound-writer.ts';
import { SCHEDULE_GAP_MS } from '../../../server/schedule.ts';
import type { DeskState } from './storage.ts';

const MAX_SEND_LATENESS = 15 * 60_000;
const REPLY_LOOKBACK = 14 * 86_400_000;
const AUTO_SYNC_INTERVAL = 5 * 60_000;
const WORK_WINDOW = 25_000;

export type DeskGoogleMode = 'login' | 'mailbox';
type AuthCallback = { code?: string | null; state?: string | null };
type MailThread = NonNullable<Awaited<ReturnType<typeof inspectGmailThread>>>;

export function deskGmailConfig(): GmailConfig | undefined {
  const clientId = Deno.env.get('GMAIL_CLIENT_ID');
  const clientSecret = Deno.env.get('GMAIL_CLIENT_SECRET');
  const redirectUri = Deno.env.get('GMAIL_REDIRECT_URI') || `${Deno.env.get('SUPABASE_URL')}/functions/v1/desk/gmail/callback`;
  return clientId && clientSecret && redirectUri.startsWith('https://') ? { clientId, clientSecret, redirectUri } : undefined;
}

export function beginDeskGoogleAuth(config: GmailConfig, mode: DeskGoogleMode) {
  const { url, pending } = createGmailAuthorization(config);
  const authorization = new URL(url);
  if (mode === 'login') {
    authorization.searchParams.set('scope', 'openid email');
    authorization.searchParams.delete('access_type');
    authorization.searchParams.set('prompt', 'select_account');
  } else {
    authorization.searchParams.set('prompt', 'select_account consent');
  }
  return { url: authorization.toString(), pending };
}

async function googleJson<T>(url: string, init: RequestInit): Promise<T> {
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (response.ok) return await response.json() as T;
  } catch {
    // Google error responses can contain private account data.
  }
  throw new GmailApiError(403, 'Google could not verify this sign-in. Start again from Conference Desk.');
}

export async function finishDeskGoogleAuth(
  config: GmailConfig,
  pending: GmailAuthorization | undefined,
  callback: AuthCallback,
  mode: DeskGoogleMode,
): Promise<{ email: string; refreshToken?: string }> {
  if (mode === 'mailbox') return finishGmailAuthorization(config, pending, callback);
  if (!pending || pending.state !== callback.state || pending.expiresAt <= Date.now() || !callback.code) {
    throw new GmailApiError(400, 'The sign-in request expired or was canceled. Start again from Conference Desk.');
  }

  const tokens = await googleJson<{ access_token?: string }>('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'authorization_code',
      code: callback.code, code_verifier: pending.verifier, redirect_uri: config.redirectUri,
    }),
  });
  if (!tokens.access_token) throw new GmailApiError(403, 'Google did not verify this sign-in.');
  const profile = await googleJson<{ email?: string; email_verified?: boolean }>('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (profile.email_verified !== true || typeof profile.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email)) {
    throw new GmailApiError(403, 'Sign in with a verified Google account.');
  }
  return { email: profile.email.toLowerCase() };
}

export function getDeskMailbox(state: DeskState, email?: string): GmailAccount {
  const selected = (email ?? state.secrets.activeMailbox)?.trim().toLowerCase();
  const mailbox = selected && Object.hasOwn(state.secrets.mailboxes, selected) ? state.secrets.mailboxes[selected] : undefined;
  if (!mailbox) throw new GmailApiError(400, email ? 'Connect this Gmail mailbox to continue.' : 'Choose a connected Gmail mailbox.');
  return mailbox;
}

function requireConfig() {
  const config = deskGmailConfig();
  if (!config) throw new GmailApiError(503, 'Gmail setup is unavailable. Check Connections before continuing.');
  return config;
}

function errorText(error: unknown): string {
  return error instanceof GmailApiError ? error.message : 'Gmail could not complete this operation. Check the mailbox before trying again.';
}

function reserved(person: Contact, reservations: ReadonlySet<string>) {
  return outreachContactKeys(person).some(key => reservations.has(key));
}

export function deskDraftConflicts(workspace: Workspace, account: string) {
  const accounts = new Set(workspace.conferences.flatMap(conference => conference.contacts.flatMap(contact =>
    contact.draft?.gmailId && contact.draft.gmailAccount ? [contact.draft.gmailAccount] : [],
  )));
  const owners = [...accounts].map(ownerAccount => ({ ownerAccount, contacts: outreachDraftOwners(workspace.conferences, ownerAccount) }));
  return (event: Conference, person: Contact) => outreachContactKeys(person).some(key => owners.some(({ ownerAccount, contacts }) => {
    const owner = contacts.get(key);
    return owner && (ownerAccount !== account || owner.conferenceId !== event.id || owner.contactId !== person.id);
  }));
}

export function hasConflictingDeskDraft(workspace: Workspace, event: Conference, person: Contact, account: string) {
  return deskDraftConflicts(workspace, account)(event, person);
}

function draftRevision(input: Pick<GmailDraftInput, 'to' | 'subject' | 'body'>) {
  return createHash('sha256').update(JSON.stringify([input.to, input.subject, input.body])).digest('hex');
}

function rememberDraft(person: Contact, draft: GmailDraft, input: GmailDraftInput, exportedAt: string) {
  person.draft = { ...person.draft, subject: input.subject, body: input.body,
    gmailId: draft.id, gmailAccount: input.from, gmailRevision: draftRevision(input), gmailThreadId: draft.message.threadId,
    gmailExportedAt: exportedAt, gmailExportedSubject: input.subject, gmailExportedEmail: input.to };
}

function recordPrior(person: Contact, message: PriorGmailOutreach, account: string) {
  person.previouslyContacted = true;
  person.priorOutreach = { account, email: message.recipient, sentAt: message.sentAt, subject: message.subject,
    gmailThreadId: message.threadId, gmailMessageId: message.id };
}

function markSent(
  workspace: Workspace, event: Conference, person: Contact, mailbox: string, message: GmailMessage,
  recipient: string, subject?: string,
) {
  const sentAt = Number(message.internalDate);
  person.sentAt = Number.isFinite(sentAt) && sentAt > 0 && sentAt <= 8.64e15
    ? new Date(sentAt).toISOString() : person.sentAt || new Date().toISOString();
  person.gmailThreadId = message.threadId;
  person.gmailMessageId = message.id;
  person.gmailAccount = mailbox;
  person.sentEmail ||= recipient;
  person.sentSubject ||= subject;
  for (const item of workspace.queue) {
    if (item.conferenceId !== event.id || item.contactId !== person.id || item.account !== mailbox || item.status === 'cancelled') continue;
    Object.assign(item, { status: 'sent', sentAt: person.sentAt, gmailThreadId: message.threadId, gmailMessageId: message.id });
    delete item.error;
  }
}

function recordThread(
  workspace: Workspace, event: Conference, person: Contact, mailbox: string, threadId: string,
  thread: MailThread, recipient: string, subject?: string,
) {
  markSent(workspace, event, person, mailbox, { id: thread.sentMessageId, threadId, internalDate: String(Date.parse(thread.sentAt)) },
    recipient, subject);
  person.repliedAt ||= thread.firstReplyAt;
  person.replyCount = Math.max(person.replyCount || Number(Boolean(person.repliedAt)), thread.replyCount);
  for (const item of workspace.queue) {
    if (item.conferenceId === event.id && item.contactId === person.id && item.account === mailbox && item.status === 'sent') {
      item.repliedAt = person.repliedAt;
      item.replyCount = person.replyCount;
    }
  }
}

async function reconcileOwnSend(
  workspace: Workspace, access: string, event: Conference, person: Contact, mailbox: string, item?: QueueItem,
) {
  const draft = person.draft?.gmailAccount === mailbox ? person.draft : undefined;
  const recipient = item?.email || person.sentEmail || draft?.gmailExportedEmail || person.email;
  if (!recipient) return false;
  const messageId = gmailMessageId(event.id, person.id);
  const sent = await findGmailSent(access, messageId);
  const known = person.gmailAccount === mailbox && person.gmailMessageId;
  const threadId = sent?.threadId || (known && person.gmailThreadId) || draft?.gmailThreadId;
  if (!threadId) return false;
  const thread = await inspectGmailThread(access, {
    threadId, recipient, rfcMessageId: messageId, sentMessageId: sent?.id || known || undefined,
    draftSubject: draft?.gmailExportedSubject, draftExportedAt: draft?.gmailExportedAt,
  });
  if (!thread && sent) throw new GmailApiError(409, 'A matching sent message could not be verified. Check the Gmail thread before retrying.');
  if (!thread) return false;
  recordThread(workspace, event, person, mailbox, threadId, thread, recipient, item?.subject || draft?.gmailExportedSubject);
  return true;
}

async function processSend(state: DeskState, config: GmailConfig, item: QueueItem) {
  const { workspace } = state;
  const mailbox = getDeskMailbox(state, item.account);
  const event = workspace.conferences.find(event => event.id === item.conferenceId);
  const person = event?.contacts.find(person => person.id === item.contactId);
  if (!event || !person) throw new GmailApiError(409, 'The scheduled conference or contact is missing.');
  const access = await getGmailAccessToken(config, mailbox);
  if (await reconcileOwnSend(workspace, access, event, person, mailbox.email, item)) return;
  if (item.sendingAt) throw new GmailApiError(409, 'The last send could not be confirmed. Check Sent in Gmail and sync before taking another action.');
  if (Date.now() - Date.parse(item.scheduledAt) > MAX_SEND_LATENESS) {
    throw new GmailApiError(409, 'The worker missed the scheduled time. This email was held for review.');
  }
  if (!isOutreachOpen(event, new Date())) throw new GmailApiError(409, 'This conference’s outreach window has closed.');
  if (!canReachContact(person) || person.email !== item.email) throw new GmailApiError(409, 'A contact change needs review.');
  if (reserved(person, outreachReservations(workspace.conferences, workspace.queue, item.id)) ||
      hasConflictingDeskDraft(workspace, event, person, mailbox.email)) {
    throw new GmailApiError(409, 'This contact already has outreach or a Gmail draft that needs review.');
  }
  const prior = await findPriorGmailOutreach(access, item.email);
  if (prior) {
    recordPrior(person, prior, mailbox.email);
    throw new GmailApiError(409, 'Existing outreach was found in Gmail. Open this contact to see the earlier thread.');
  }

  const messageId = gmailMessageId(event.id, person.id);
  const input = { to: item.email, subject: item.subject, body: item.body, from: mailbox.email, messageId };
  const existing = person.draft?.gmailAccount === mailbox.email ? person.draft.gmailId : undefined;
  let draftId = existing || item.draftId;
  if (!draftId) {
    const exportedAt = new Date().toISOString();
    const draft = await findGmailDraft(access, messageId) || await createGmailDraft(access, input);
    draftId = draft.id;
    rememberDraft(person, draft, input, exportedAt);
    item.draftId = draftId;
    await state.save();
  }
  const sent = await sendGmailDraft(access, draftId, { recipient: item.email, messageId, subject: item.subject, body: item.body,
    from: mailbox.email }, async () => {
    if (Date.now() - Date.parse(item.scheduledAt) > MAX_SEND_LATENESS || !isOutreachOpen(event, new Date())) {
      throw new GmailApiError(409, 'The send window closed while Gmail was preparing the draft. Review it before scheduling again.');
    }
    item.sendingAt = new Date().toISOString();
    item.draftId = draftId;
    await state.save();
  });
  markSent(workspace, event, person, mailbox.email, sent, item.email, item.subject);
}

export async function processDueMail(state: DeskState): Promise<number> {
  const config = deskGmailConfig();
  if (!config) return 0;
  const startedAt = Date.now();
  const { queue } = state.workspace;
  const due = queue.filter(item => (item.status === 'scheduled' || item.status === 'sending') && Date.parse(item.scheduledAt) <= startedAt)
    .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  const attemptedMailboxes = new Set<string>();
  let sent = 0;
  for (const item of due) {
    if (attemptedMailboxes.size >= 3 || Date.now() - startedAt > WORK_WINDOW) break;
    if (attemptedMailboxes.has(item.account)) continue;
    const recentAttempt = queue.some(other => other.id !== item.id && other.account === item.account && other.sendingAt &&
      Date.now() - Date.parse(other.sendingAt) < SCHEDULE_GAP_MS);
    if (recentAttempt && !item.sendingAt) continue;
    attemptedMailboxes.add(item.account);
    item.status = 'sending';
    await state.save();
    try {
      await processSend(state, config, item);
      sent++;
    } catch (error) {
      const transient = error instanceof GmailApiError && (error.status === 429 || error.status >= 500);
      item.status = transient && !item.sendingAt && Date.now() - Date.parse(item.scheduledAt) < MAX_SEND_LATENESS ? 'scheduled' : 'failed';
      item.error = errorText(error);
    }
    await state.save();
  }
  return sent;
}

export async function exportDeskGmailDrafts(state: DeskState, event: Conference, contactId?: string, email?: string) {
  if (!isOutreachOpen(event, new Date())) throw new GmailApiError(409, 'This conference’s outreach window has closed.');
  const startedAt = Date.now();
  const mailbox = getDeskMailbox(state, email);
  const access = await getGmailAccessToken(requireConfig(), mailbox);
  const reservations = outreachReservations(state.workspace.conferences, state.workspace.queue);
  const conflicts = deskDraftConflicts(state.workspace, mailbox.email);
  const selected = new Set<string>();
  let held = 0;
  let synced = 0;
  let error: string | undefined;
  const people = rankContacts(event.contacts).filter(person => (!contactId || person.id === contactId) && canReachContact(person));
  const exportable = people.filter(person => {
    if (reserved(person, reservations) || reserved(person, selected) || conflicts(event, person)) {
      held++;
      return false;
    }
    for (const key of outreachContactKeys(person)) selected.add(key);
    if (person.draft?.gmailAccount === mailbox.email && person.draft.gmailId && person.draft.gmailRevision === draftRevision({
      to: person.email!, subject: person.draft.subject, body: person.draft.body,
    })) {
      synced++;
      return false;
    }
    return true;
  });
  for (const person of exportable.slice(0, 20).reverse()) {
    if (Date.now() - startedAt > WORK_WINDOW) break;
    try {
      if (await reconcileOwnSend(state.workspace, access, event, person, mailbox.email)) {
        await state.save();
        continue;
      }
      const prior = await findPriorGmailOutreach(access, person.email!);
      if (prior) {
        recordPrior(person, prior, mailbox.email);
        held++;
        await state.save();
        continue;
      }
      const draft = person.draft || writeDraft(event, person);
      const input = { to: person.email!, subject: draft.subject, body: draft.body,
        from: mailbox.email, messageId: gmailMessageId(event.id, person.id) };
      const existing = person.draft?.gmailAccount === mailbox.email && person.draft.gmailId;
      const id = existing || (await findGmailDraft(access, input.messageId))?.id;
      const exportedAt = new Date().toISOString();
      const saved = id ? await updateGmailDraft(access, id, input) : await createGmailDraft(access, input);
      rememberDraft(person, saved, input, exportedAt);
      await state.save();
      synced++;
    } catch (failure) {
      error ||= errorText(failure);
      if (!(failure instanceof GmailApiError) || ![400, 404, 409].includes(failure.status)) break;
    }
  }
  return { synced, held, error };
}

export async function syncDeskMailbox(state: DeskState, email?: string, options: { full?: boolean; limit?: number } = {}) {
  const mailbox = getDeskMailbox(state, email);
  const { workspace, secrets } = state;
  const startedAt = Date.now();
  const previous = secrets.mailSync?.[mailbox.email];
  const unresolved = new Map(workspace.queue.filter(item => item.account === mailbox.email &&
    (item.status === 'failed' || item.status === 'sending'))
    .map(item => [JSON.stringify([item.conferenceId, item.contactId]), item]));
  const tracked = workspace.conferences.flatMap(event => event.contacts.flatMap(person => {
    const key = JSON.stringify([event.id, person.id]);
    const trackedSend = person.gmailAccount === mailbox.email &&
      (options.full !== false || !isPast(event) || Date.parse(person.sentAt || '') >= startedAt - REPLY_LOOKBACK);
    const trackedDraft = person.draft?.gmailAccount === mailbox.email && !person.sentAt;
    if (!person.email && !person.sentEmail && !person.draft?.gmailExportedEmail) return [];
    if (person.sentAt && person.gmailAccount && person.gmailAccount !== mailbox.email) return [];
    return trackedSend || trackedDraft || unresolved.has(key) ? [{ event, person, key }] : [];
  })).sort((a, b) => a.key.localeCompare(b.key));
  if (!tracked.length) return 0;

  const previousIndex = tracked.findIndex(entry => entry.key === previous?.cursor);
  const ordered = [...tracked.slice(previousIndex + 1), ...tracked.slice(0, previousIndex + 1)];
  const count = Math.min(ordered.length, options.limit ?? 18);
  const access = await getGmailAccessToken(requireConfig(), mailbox);
  let synced = 0;
  for (let offset = 0; offset < count; offset += 4) {
    if (Date.now() - startedAt > WORK_WINDOW) break;
    const batch = ordered.slice(offset, Math.min(count, offset + 4));
    const outcomes = await Promise.allSettled(batch.map(async ({ event, person, key }) => {
      const item = unresolved.get(key);
      if (person.gmailThreadId && person.gmailMessageId && person.gmailAccount === mailbox.email) {
        const recipient = person.sentEmail || person.draft?.gmailExportedEmail || person.email!;
        const thread = await inspectGmailThread(access, {
          threadId: person.gmailThreadId, sentMessageId: person.gmailMessageId, recipient, rfcMessageId: gmailMessageId(event.id, person.id),
        });
        if (thread) recordThread(workspace, event, person, mailbox.email, person.gmailThreadId, thread, recipient, person.sentSubject);
        return Boolean(thread);
      }
      return reconcileOwnSend(workspace, access, event, person, mailbox.email, item);
    }));
    synced += outcomes.filter(result => result.status === 'fulfilled' && result.value).length;
    secrets.mailSync ??= {};
    secrets.mailSync[mailbox.email] = { checkedAt: Date.now(), cursor: batch.at(-1)!.key };
    await state.save();
    const failure = outcomes.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  return synced;
}

export async function syncDueDeskMail(state: DeskState): Promise<number> {
  const now = Date.now();
  const email = Object.keys(state.secrets.mailboxes).filter(email =>
    now - (state.secrets.mailSync?.[email]?.checkedAt ?? 0) >= AUTO_SYNC_INTERVAL,
  ).sort((a, b) => (state.secrets.mailSync?.[a]?.checkedAt ?? 0) - (state.secrets.mailSync?.[b]?.checkedAt ?? 0))[0];
  if (!email || !deskGmailConfig()) return 0;
  try {
    return await syncDeskMailbox(state, email, { full: false, limit: 8 });
  } finally {
    // Rotate even when an inbox is disconnected, idle, or temporarily unavailable.
    if ((state.secrets.mailSync?.[email]?.checkedAt ?? 0) < now) {
      state.secrets.mailSync ??= {};
      state.secrets.mailSync[email] = { ...state.secrets.mailSync[email], checkedAt: now };
      await state.save();
    }
  }
}
