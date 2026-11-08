export type Bucket = 'direct' | 'connector' | 'irrelevant';
export type Attendance = 'attendee' | 'speaker' | 'organizer' | 'unconfirmed';
export type EmailStatus = 'verified' | 'sourced' | 'unverified';
export type QueueStatus = 'scheduled' | 'sending' | 'sent' | 'failed' | 'cancelled';

export interface Source { url: string; label: string }
export interface Draft {
  subject: string;
  body: string;
  approved?: boolean;
  gmailId?: string;
  gmailAccount?: string;
  gmailRevision?: string;
  gmailThreadId?: string;
  gmailExportedAt?: string;
  gmailExportedSubject?: string;
  gmailExportedEmail?: string;
}

export interface PriorOutreach {
  account: string;
  email: string;
  sentAt?: string;
  subject?: string;
  gmailThreadId: string;
  gmailMessageId: string;
}

export interface Contact {
  id: string;
  name: string;
  title?: string;
  company?: string;
  email?: string;
  emailStatus?: EmailStatus;
  emailSource?: string;
  linkedin?: string;
  attendance: Attendance;
  sourceUrl?: string;
  sourceLabel?: string;
  hook?: string;
  hookSource?: string;
  sessionTitle?: string;
  apolloChecked?: boolean;
  autumnChecked?: boolean;
  bucket: Bucket;
  score: number;
  reason: string;
  draft?: Draft;
  sentAt?: string;
  sentEmail?: string;
  sentSubject?: string;
  repliedAt?: string;
  replyCount?: number;
  gmailThreadId?: string;
  gmailMessageId?: string;
  gmailAccount?: string;
  previouslyContacted?: boolean;
  priorOutreach?: PriorOutreach;
}

export interface GmailScheduledMessage {
  account: string;
  email: string;
  gmailMessageId: string;
  gmailThreadId?: string;
  subject?: string;
  scheduledAt?: string;
  contactId?: string;
  observedAt?: string;
  purpose?: 'prospect' | 'organizer';
}

export interface Conference {
  id: string;
  title: string;
  shortTitle?: string;
  location?: string;
  url?: string;
  startDate?: string;
  endDate?: string;
  createdAt: string;
  contacts: Contact[];
  sources: Source[];
  notes: string[];
  needsRoster: boolean;
  example?: boolean;
  gmailScheduled?: GmailScheduledMessage[];
}

export interface ICP {
  name: string;
  description: string;
  direct: string[];
  connector: string[];
  accounts: string[];
}

export interface QueueItem {
  id: string;
  conferenceId: string;
  contactId: string;
  account: string;
  email: string;
  subject: string;
  body: string;
  scheduledAt: string;
  status: QueueStatus;
  error?: string;
  sendingAt?: string;
  draftId?: string;
  sentAt?: string;
  repliedAt?: string;
  replyCount?: number;
  gmailThreadId?: string;
  gmailMessageId?: string;
}

export interface ResearchJob {
  id: string;
  conferenceId: string;
  kind: 'discovery' | 'enrichment';
  status: 'running' | 'needs_input' | 'done' | 'failed';
  transport?: 'mcp' | 'api';
  automatic?: boolean;
  stage?: 'public' | 'autumn_start' | 'autumn_starting';
  lastPolledAt?: number;
  message?: string;
  contactIds?: string[];
}

export interface Workspace {
  conferences: Conference[];
  queue: QueueItem[];
  icp: ICP;
  jobs: ResearchJob[];
  apolloRuns?: ApolloWaterfallRun[];
}

export type Provider = 'apollo' | 'autumn' | 'exa';

export type McpConnection = {
  status: 'connected' | 'needs_login' | 'unavailable' | 'unchecked';
  detail?: string;
  canLogin?: boolean;
};

export interface Connections {
  gmailConfigured: boolean;
  gmailRedirectUri?: string;
  gmail?: string;
  mailboxes?: string[];
  apollo: boolean;
  autumn: boolean;
  exa: boolean;
  codex: boolean;
  mcp?: Partial<Record<Provider, McpConnection>>;
}

export type ApolloPreview = {
  token: string;
  people: string[];
  mode: 'standard' | 'waterfall';
  credits?: number;
  estimate?: string;
  available?: number;
};

export type ApolloWaterfallRecipient = {
  contactId: string;
  name: string;
  company?: string;
  linkedin?: string;
  status: 'queued' | 'submitting' | 'pending' | 'waiting' | 'matched' | 'no_match' | 'failed' | 'uncertain' | 'skipped';
  fingerprint: string;
  requestId?: string;
  personId?: string;
  nextCheckAt?: number;
  checkUntil?: number;
  email?: string;
  creditsUsed?: number;
  notes: string[];
};

export type ApolloWaterfallRun = {
  id: string;
  conferenceId: string;
  approvedAt: string;
  automatic?: boolean;
  costLabel: string;
  recipients: ApolloWaterfallRecipient[];
};

export interface Snapshot extends Workspace { connections: Connections; outreachReady: number }

export interface BatchPreview {
  token: string;
  conferenceId?: string;
  account?: string;
  duplicateCount: number;
  rows: {
    conferenceId: string;
    conferenceTitle: string;
    contactId: string;
    name: string;
    email: string;
    bucket: Bucket;
    subject: string;
    body: string;
    scheduledAt: string;
  }[];
}

export const BUCKETS: Record<Bucket, string> = {
  direct: 'Direct ICP',
  connector: 'Could introduce me',
  irrelevant: 'Low relevance',
};

export const TIME_ZONE = 'America/Chicago';

export function localDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function isPast(conference: Conference) {
  const end = conference.endDate || conference.startDate;
  return Boolean(end && end < localDate());
}

export function rankContacts(contacts: Contact[]) {
  const order = { direct: 0, connector: 1, irrelevant: 2 };
  return [...contacts].sort((a, b) => order[a.bucket] - order[b.bucket] || b.score - a.score || a.name.localeCompare(b.name));
}

export function target(contact: Contact) { return contact.bucket !== 'irrelevant'; }

function normalizedAddress(email: string) { return email.trim().toLowerCase(); }

export function scheduledRecipientKey(account: string, email: string) {
  return JSON.stringify([normalizedAddress(account), normalizedAddress(email)]);
}

export function gmailScheduledMessageKey(message: GmailScheduledMessage) {
  return JSON.stringify([normalizedAddress(message.account), message.gmailMessageId]);
}

export function isGmailSchedulePending(message: GmailScheduledMessage, now = Date.now()) {
  const sendTime = Date.parse(message.scheduledAt || '');
  return !Number.isFinite(sendTime) || sendTime > now;
}

export function scheduledCount(conferences: readonly Conference[], queue: readonly QueueItem[], now = Date.now()) {
  const gmail = conferences.flatMap(event => event.gmailScheduled ?? []);
  const gmailRecipients = new Set(gmail.map(row => scheduledRecipientKey(row.account, row.email)));
  const gmailPending = new Set(gmail.filter(row => isGmailSchedulePending(row, now)).map(gmailScheduledMessageKey));
  return gmailPending.size + queue.filter(item => (item.status === 'scheduled' || item.status === 'sending') &&
    !gmailRecipients.has(scheduledRecipientKey(item.account, item.email))).length;
}

export function campaignCounts(conference: Conference, queue: QueueItem[], now = Date.now()) {
  const contacts = conference.contacts;
  const actionable = contacts.filter(contact => target(contact) && (!contact.previouslyContacted || contact.sentAt));
  const sent = contacts.filter(contact => contact.sentAt).length;
  const replies = contacts.filter(contact => contact.repliedAt).length;
  const eventQueue = queue.filter(item => item.conferenceId === conference.id);
  const scheduled = scheduledCount([conference], eventQueue, now);
  const pending = eventQueue.filter(item => item.status === 'scheduled' || item.status === 'sending');
  const gmailProspects = (conference.gmailScheduled ?? []).filter(row => row.purpose !== 'organizer');
  const scheduledContacts = new Set([...pending, ...gmailProspects].map(row => row.contactId));
  const scheduledAddresses = new Set([...pending, ...gmailProspects].map(row => normalizedAddress(row.email)));
  const left = actionable.filter(contact => !contact.sentAt && !contact.previouslyContacted &&
    !scheduledContacts.has(contact.id) && (!contact.email || !scheduledAddresses.has(normalizedAddress(contact.email)))).length;
  const sentToTargets = actionable.filter(contact => contact.sentAt).length;
  const progress = actionable.length ? Math.round(100 * sentToTargets / actionable.length) : 0;
  const replyRate = sent ? Math.round(100 * replies / sent) : 0;
  return { sent, replies, scheduled, left, progress, replyRate, total: contacts.length, targetCount: actionable.length };
}

export function gmailDraftsUrl(email?: string) {
  return email ? `https://mail.google.com/mail/u/${encodeURIComponent(email)}/#drafts` : 'https://mail.google.com/mail/u/0/#drafts';
}

export function gmailScheduledUrl(email: string) {
  return `https://mail.google.com/mail/u/${encodeURIComponent(email)}/#scheduled`;
}

export function gmailThreadUrl(account?: string, threadId?: string) {
  if (!account || !threadId || !/^[\w-]+$/.test(threadId)) return undefined;
  return `https://mail.google.com/mail/u/${encodeURIComponent(account)}/#all/${encodeURIComponent(threadId)}`;
}

export function safeLink(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}
