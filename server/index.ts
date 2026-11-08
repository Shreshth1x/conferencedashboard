import 'dotenv/config';
import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import type { ApolloPreview, ApolloWaterfallRun, BatchPreview, Conference, Contact, ICP, McpConnection, Provider, QueueItem, ResearchJob, Snapshot } from '../src/model';
import { isPast, rankContacts, target, safeLink, localDate } from '../src/model';
import {
  researchConference, parseAttendeeList, scoreContact, enrichApollo, startAutumnEnrichment, pollAutumnEnrichment,
  startAutumnDiscovery, pollAutumnDiscovery, replyAutumn, canEnrichWithApollo, planApolloMcpEnrichment,
  submitApolloWaterfall, pollApolloWaterfall, type ResearchContact,
} from './conference-research';
import {
  createGmailAuthorization, finishGmailAuthorization, getGmailAccessToken, findGmailDraft, createGmailDraft,
  findGmailSent, sendGmailDraft, gmailMessageId, inspectGmailThread, findPriorGmailOutreach, updateGmailDraft,
  GmailApiError, type GmailAuthorization, type GmailDraft, type GmailMessage,
} from './gmail';
import { SCHEDULE_GAP_MS } from './schedule';
import { canReachContact, isOutreachOpen, outreachContactKeys, outreachDraftOwners, outreachReservations, planOutreach } from './outreach-planner';
import { writeDraft, polishDraftWithCodex } from './outbound-writer';
import { workspace, secrets, persist, saveSecrets, lockWorkspace, initializeStorage, closeStorage } from './store';
import { callResearchMcp, checkResearchMcp, closeResearchMcp, startResearchMcpLogin } from './research-mcp';

const app = express();
const port = Number(process.env.PORT || 4173);
const origin = `http://127.0.0.1:${port}`;
const gmailConfig = process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET ? {
  clientId: process.env.GMAIL_CLIENT_ID,
  clientSecret: process.env.GMAIL_CLIENT_SECRET,
  redirectUri: process.env.GMAIL_REDIRECT_URI || origin + '/api/gmail/callback',
} : undefined;
const keyNames = { apollo: 'APOLLO_API_KEY', autumn: 'AUTUMN_API_KEY', exa: 'EXA_API_KEY' } as const;
const key = (provider: Provider) => secrets.keys?.[provider] || process.env[keyNames[provider]];
const authRequests = new Map<string, GmailAuthorization>();
const previews = new Map<string, { preview: BatchPreview; expiresAt: number; fingerprint: string }>();
const codexBin = process.env.CODEX_BIN || join(homedir(), '.local', 'bin', 'codex');
let codexConnected = false;
const mcpConnections: Partial<Record<Provider, McpConnection>> = {};
const apolloPreviews = new Map<string, { conferenceId: string; fingerprint: string; limit: number; expiresAt: number; mode: ApolloPreview['mode']; costLabel: string; mcp: boolean }>();
const runningApollo = new Set<string>();

function checkCodex() {
  const result = spawnSync(codexBin, ['login', 'status'], {
    encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  codexConnected = result.status === 0 && /logged in using ChatGPT/i.test(`${result.stdout}\n${result.stderr}`);
  return codexConnected;
}

class RequestError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const clean = (value: unknown, max = 400) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const validDate = (value: string) => !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
const validEmail = (value?: string) => Boolean(value && /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(value));
const active = (item: QueueItem) => item.status === 'scheduled' || item.status === 'sending';
const errorText = (error: unknown) => error instanceof Error ? error.message : 'An unexpected error occurred.';

let mutation = Promise.resolve<unknown>(undefined);
function exclusive<T>(task: () => Promise<T> | T) {
  const result = mutation.then(task);
  mutation = result.catch(() => undefined);
  return result;
}
function conference(id: string) {
  const found = workspace.conferences.find(event => event.id === id);
  if (!found) throw new RequestError('Conference not found.', 404);
  return found;
}
function contact(event: Conference, id: string) {
  const found = event.contacts.find(person => person.id === id);
  if (!found) throw new RequestError('Contact not found.', 404);
  return found;
}
function ensureLive(event: Conference) {
  if (event.example) throw new RequestError('Example conferences cannot use live outreach.');
  if (isPast(event)) throw new RequestError('This conference has ended. Its outreach history is available for reference.');
}
function ensureEditable(event: Conference, person: Contact) {
  if (person.sentAt || workspace.queue.some(item => item.conferenceId === event.id && item.contactId === person.id && (active(item) || item.status === 'failed'))) {
    throw new RequestError('This draft belongs to sent or scheduled outreach. Cancel the scheduled send before editing it.');
  }
}
function account() {
  if (!gmailConfig || !secrets.gmail) throw new RequestError('Connect Gmail to continue.');
  return { config: gmailConfig, account: secrets.gmail };
}
function snapshot(): Snapshot {
  const gmail = gmailConfig ? secrets.gmail?.email : undefined;
  const { readyCount } = planOutreach({ conferences: workspace.conferences, queue: workspace.queue, account: gmail || '', count: 0 });
  return {
    ...workspace,
    outreachReady: readyCount,
    connections: { gmailConfigured: Boolean(gmailConfig), gmailRedirectUri: gmailConfig?.redirectUri || origin + '/api/gmail/callback', gmail, apollo: Boolean(key('apollo')), autumn: Boolean(key('autumn')), exa: Boolean(key('exa')), codex: codexConnected, mcp: mcpConnections },
  };
}
function requestProvider(value: unknown): Provider {
  if (typeof value !== 'string' || !Object.hasOwn(keyNames, value)) throw new RequestError('Choose a research provider.');
  return value as Provider;
}

async function refreshMcpConnection(provider: Provider) {
  const result = await checkResearchMcp(provider);
  const canLogin = provider !== 'exa' && result.configured && result.authStatus === 'notLoggedIn';
  mcpConnections[provider] = {
    status: result.connected ? 'connected' : canLogin ? 'needs_login' : 'unavailable',
    detail: result.message,
    canLogin: (canLogin && !result.connected) || result.waterfallEmail?.needsReauthorization,
  };
}

function providerConnection(provider: Provider) {
  return mcpConnections[provider]?.status === 'connected' ? { mcp: callResearchMcp } : { key: key(provider) };
}

function exaConnection() {
  const connection = providerConnection('exa');
  return { exaKey: connection.key, mcp: connection.mcp };
}

function autumnJobConnection(job: ResearchJob) {
  return job.transport === 'mcp' ? { mcp: callResearchMcp } : { key: key('autumn') };
}

function autumnJobOpen(job: ResearchJob) {
  return job.status === 'running' || job.status === 'needs_input';
}

function recalculate(person: Contact) { Object.assign(person, scoreContact(person, workspace.icp)); }
function identity(value?: string) { return value?.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ') || ''; }
function samePerson(a: ResearchContact, b: ResearchContact) {
  return Boolean(a.email && b.email && identity(a.email) === identity(b.email)) ||
    Boolean(a.linkedin && b.linkedin && identity(a.linkedin).replace(/\/$/, '') === identity(b.linkedin).replace(/\/$/, '')) ||
    (identity(a.name) === identity(b.name) && (!a.company || !b.company || identity(a.company) === identity(b.company)));
}
function mergeContacts(event: Conference, incoming: ResearchContact[]) {
  let added = 0;
  for (const person of incoming) {
    if (!person.name) continue;
    const old = event.contacts.find(row => samePerson(row, person));
    if (old) {
      for (const field of ['title', 'company', 'linkedin', 'hook', 'hookSource', 'sourceUrl', 'sourceLabel', 'sessionTitle'] as const) {
        if (!old[field] && person[field]) old[field] = person[field];
      }
      if (!old.email && person.email) {
        old.email = person.email;
        old.emailStatus = person.emailStatus;
        old.emailSource = person.emailSource;
      }
      if (old.attendance === 'unconfirmed') old.attendance = person.attendance;
      recalculate(old);
    } else {
      event.contacts.push({ ...person, id: randomUUID(), ...scoreContact(person, workspace.icp) });
      added++;
    }
  }
  return added;
}
function combineSources(event: Conference, sources: Conference['sources']) {
  for (const source of sources) if (!event.sources.some(existing => existing.url === source.url)) event.sources.push(source);
}
function applyResearch(event: Conference, result: Awaited<ReturnType<typeof researchConference>>) {
  event.location ||= result.location;
  event.startDate ||= result.startDate;
  event.endDate ||= result.endDate;
  event.url ||= result.url;
  event.notes = [...new Set([...event.notes, ...result.notes])];
  combineSources(event, result.sources);
  const count = mergeContacts(event, result.contacts);
  event.needsRoster = event.needsRoster && result.needsRoster;
  return count;
}
function prepareDraft(event: Conference, person: Contact) {
  person.draft ||= writeDraft(event, person);
  return person.draft;
}
function reserved(person: Contact, reservations: ReadonlySet<string>) {
  return outreachContactKeys(person).some(key => reservations.has(key));
}
function hasOtherGmailDraft(event: Conference, person: Contact, owners: ReturnType<typeof outreachDraftOwners>) {
  return outreachContactKeys(person).some(key => {
    const owner = owners.get(key);
    return owner && (owner.conferenceId !== event.id || owner.contactId !== person.id);
  });
}
function fingerprint(rows: BatchPreview['rows']) {
  return JSON.stringify(rows.map(row => {
    const event = conference(row.conferenceId);
    const person = contact(event, row.contactId);
    return [event.id, event.title, event.shortTitle, event.startDate, event.endDate, person.id, person.name, person.email,
      person.draft?.subject, person.draft?.body, person.emailStatus, person.bucket, person.score, person.linkedin];
  }));
}
function recordPrior(person: Contact, message: NonNullable<Awaited<ReturnType<typeof findPriorGmailOutreach>>>, account: string) {
  person.previouslyContacted = true;
  person.priorOutreach = {
    account, email: message.recipient, sentAt: message.sentAt, subject: message.subject,
    gmailThreadId: message.threadId, gmailMessageId: message.id,
  };
}
function markSent(event: Conference, person: Contact, message: GmailMessage, mailbox: string, recipient?: string, subject?: string) {
  const sentAt = Number(message.internalDate);
  person.sentAt = sentAt > 0 && Number.isFinite(sentAt) ? new Date(sentAt).toISOString() : person.sentAt || new Date().toISOString();
  person.gmailThreadId = message.threadId;
  person.gmailMessageId = message.id;
  person.gmailAccount = mailbox;
  person.sentEmail ||= recipient || person.email;
  person.sentSubject ||= subject;
  for (const item of workspace.queue) if (item.conferenceId === event.id && item.contactId === person.id && item.account === mailbox && item.status !== 'cancelled') {
    Object.assign(item, { status: 'sent', sentAt: person.sentAt, gmailThreadId: message.threadId, gmailMessageId: message.id });
    delete item.error;
  }
}
function draftInput(event: Conference, person: Contact, email: string) {
  return { to: person.email!, subject: person.draft!.subject, body: person.draft!.body, messageId: gmailMessageId(event.id, person.id), from: email };
}
function draftRevision(input: ReturnType<typeof draftInput>) {
  return createHash('sha256').update(JSON.stringify([input.to, input.subject, input.body])).digest('hex');
}
function rememberDraft(person: Contact, draft: GmailDraft, input: ReturnType<typeof draftInput>, exportedAt: string) {
  person.draft = { ...person.draft!, gmailId: draft.id, gmailAccount: input.from, gmailRevision: draftRevision(input),
    gmailThreadId: draft.message.threadId, gmailExportedAt: exportedAt, gmailExportedSubject: input.subject, gmailExportedEmail: input.to };
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  if (req.get('host') !== `127.0.0.1:${port}` && req.get('host') !== `localhost:${port}`) return res.status(403).send('Open Conference Desk from its local URL.');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
  if (req.path.startsWith('/api/')) {
    res.set('Cache-Control', 'no-store');
    const requestOrigin = req.get('origin');
    if (requestOrigin && requestOrigin !== origin && requestOrigin !== `http://localhost:${port}`) return res.status(403).json({ error: 'This request must come from Conference Desk.' });
    if (req.method !== 'GET' && !req.is('application/json')) return res.status(415).json({ error: 'Send JSON from Conference Desk.' });
  }
  next();
});
app.use(express.json({ limit: '4mb' }));
app.get('/api/workspace', (_req, res) => res.json(snapshot()));

app.post('/api/conferences', async (req, res) => {
  const title = clean(req.body.title);
  const input = clean(req.body.input, 12_000);
  const suppliedUrl = clean(req.body.url, 2048) || input.match(/https?:\/\/[^\s<>"']+/i)?.[0];
  const url = safeLink(suppliedUrl);
  const startDate = clean(req.body.startDate, 10);
  const endDate = clean(req.body.endDate, 10);
  const attendeeText = clean(req.body.attendees, 2_000_000);
  if (!title && !input && !url) throw new RequestError('Enter a conference link, name, or event details.');
  if (!validDate(startDate) || !validDate(endDate) || (startDate && endDate && endDate < startDate)) throw new RequestError('Enter a valid conference date range.');
  const query = title || (url && input === url ? '' : input.replace(/https?:\/\/[^\s<>"']+/gi, '').trim()) || '';
  const result = await researchConference({ name: title || (url ? undefined : query), url, notes: url ? query : undefined, attendees: attendeeText }, exaConnection());
  const event: Conference = {
    id: randomUUID(), title: title || result.title || query.slice(0, 160) || new URL(url!).hostname,
    location: clean(req.body.location) || undefined, startDate: startDate || undefined, endDate: endDate || undefined,
    url, contacts: [], sources: [], notes: [], needsRoster: true, createdAt: new Date().toISOString(),
  };
  applyResearch(event, result);
  await exclusive(async () => { workspace.conferences.push(event); await persist(); });
  res.status(201).json({ conferenceId: event.id, snapshot: snapshot() });
});

app.post('/api/conferences/:id/roster', async (req, res) => {
  const list = clean(req.body.attendees, 2_000_000);
  if (!list) throw new RequestError('Paste attendee details or choose a CSV.');
  const contacts = parseAttendeeList(list);
  if (!contacts.length) throw new RequestError('No contact names were found. Use one name per line or a CSV with a name column.');
  const added = await exclusive(async () => {
    const event = conference(req.params.id);
    const count = mergeContacts(event, contacts);
    event.needsRoster = false;
    event.notes.push(`Imported ${contacts.length} rows from an attendee list you provided.`);
    await persist();
    return count;
  });
  res.json({ added, snapshot: snapshot() });
});

app.post('/api/conferences/:id/details', async (req, res) => {
  const title = clean(req.body.title);
  const url = safeLink(clean(req.body.url, 2048));
  const startDate = clean(req.body.startDate, 10);
  const endDate = clean(req.body.endDate, 10);
  if (!title || !validDate(startDate) || !validDate(endDate) || (startDate && endDate && endDate < startDate)) throw new RequestError('Enter a title and a valid date range.');
  await exclusive(async () => {
    const event = conference(req.params.id);
    const cutoff = startDate || endDate;
    if (cutoff && workspace.queue.some(item => item.conferenceId === event.id && active(item) && localDate(new Date(item.scheduledAt)) > cutoff)) {
      throw new RequestError('Cancel the affected scheduled emails before changing the conference dates.');
    }
    Object.assign(event, { title, location: clean(req.body.location), startDate, endDate, url });
    await persist();
  });
  res.json(snapshot());
});

app.post('/api/icp', async (req, res) => {
  const terms = (value: unknown) => Array.isArray(value) ? [...new Set(value.map(term => clean(term, 180)).filter(Boolean))].slice(0, 500) : [];
  const icp: ICP = {
    name: clean(req.body.name), description: clean(req.body.description, 3000),
    direct: terms(req.body.direct), connector: terms(req.body.connector), accounts: terms(req.body.accounts),
  };
  if (!icp.name || !icp.direct.length) throw new RequestError('Add an ICP name and at least one direct fit signal.');
  await exclusive(async () => {
    workspace.icp = icp;
    for (const event of workspace.conferences) for (const person of event.contacts) recalculate(person);
    await persist();
  });
  res.json(snapshot());
});

app.post('/api/conferences/:id/contacts/:contactId', async (req, res) => {
  const email = clean(req.body.email, 254);
  const subject = clean(req.body.subject, 300);
  const body = clean(req.body.body, 12_000);
  if (email && !validEmail(email)) throw new RequestError('Enter a single valid email address.');
  if ((subject && !body) || (!subject && body) || /[\x00-\x1f\x7f]/.test(subject)) throw new RequestError('A draft needs a one-line subject and a body.');
  await exclusive(async () => {
    const event = conference(req.params.id);
    const person = contact(event, req.params.contactId);
    ensureEditable(event, person);
    if (person.email !== email) {
      person.email = email || undefined;
      person.emailStatus = email ? 'unverified' : undefined;
      person.emailSource = undefined;
    }
    if (email && req.body.confirmEmail === true) {
      person.emailStatus = 'verified';
      person.emailSource ||= 'Confirmed by you';
    }
    if (subject && body) person.draft = { ...person.draft, subject, body, approved: req.body.approved === true };
    await persist();
  });
  res.json(snapshot());
});

app.post('/api/conferences/:id/drafts', async (req, res) => {
  const count = await exclusive(async () => {
    const event = conference(req.params.id);
    ensureLive(event);
    const people = rankContacts(event.contacts).filter(person => target(person) && !person.draft && !person.sentAt && !person.previouslyContacted);
    for (const person of people) prepareDraft(event, person);
    await persist();
    return people.length;
  });
  res.json({ count, snapshot: snapshot() });
});

app.post('/api/conferences/:id/contacts/:contactId/polish', async (req, res) => {
  const event = conference(req.params.id);
  const person = contact(event, req.params.contactId);
  ensureLive(event);
  ensureEditable(event, person);
  if (!target(person) || !person.draft || !checkCodex()) throw new RequestError('Connect local Codex and prepare this draft first.');
  const original = person.draft;
  const polished = await polishDraftWithCodex(original);
  await exclusive(async () => {
    ensureEditable(event, person);
    if (person.draft !== original) throw new RequestError('The draft changed while Codex was working. Try again.');
    person.draft = { ...original, ...polished, approved: false };
    await persist();
  });
  res.json(snapshot());
});

app.post('/api/connections/codex', (_req, res) => res.json({ connected: checkCodex(), snapshot: snapshot() }));
app.post('/api/connections/mcp/check', async (req, res) => {
  await refreshMcpConnection(requestProvider(req.body.provider));
  res.json({ snapshot: snapshot() });
});
app.post('/api/connections/mcp/connect', async (req, res) => {
  const provider = requestProvider(req.body.provider);
  if (provider === 'exa') throw new RequestError('Exa MCP search can be used without an OAuth login.');
  if (!mcpConnections[provider]) await refreshMcpConnection(provider);
  if (!mcpConnections[provider]?.canLogin) throw new RequestError('Check this provider’s connection before starting authorization.');
  const { authorizationUrl } = await startResearchMcpLogin(provider);
  res.json({ url: authorizationUrl });
});
app.post('/api/connections/:provider', async (req, res) => {
  const provider = req.params.provider as Provider;
  if (!Object.hasOwn(keyNames, provider)) throw new RequestError('Unknown provider.', 404);
  const secret = clean(req.body.key, 4096);
  if (secret && (secret.length < 10 || /\s/.test(secret))) throw new RequestError('Enter a valid API key.');
  await exclusive(async () => {
    const keys = { ...secrets.keys };
    if (secret) keys[provider] = secret;
    else delete keys[provider];
    await saveSecrets({ ...secrets, keys });
  });
  res.json(snapshot());
});

app.post('/api/gmail/connect', (_req, res) => {
  if (!gmailConfig) throw new RequestError('Add your Google OAuth client ID and secret to .env, then restart Conference Desk.');
  const { url, pending } = createGmailAuthorization(gmailConfig);
  for (const [state, request] of authRequests) if (request.expiresAt <= Date.now()) authRequests.delete(state);
  authRequests.set(pending.state, pending);
  res.cookie('gmail_oauth', pending.state, { httpOnly: true, sameSite: 'lax', maxAge: 600_000, path: '/api/gmail/callback' });
  res.json({ url });
});
app.get('/api/gmail/callback', async (req, res) => {
  const state = clean(req.query.state);
  const cookie = req.headers.cookie?.match(/(?:^|;\s*)gmail_oauth=([^;]+)/)?.[1];
  const pending = cookie === state ? authRequests.get(state) : undefined;
  res.clearCookie('gmail_oauth', { path: '/api/gmail/callback' });
  if (pending) authRequests.delete(state);
  try {
    if (!gmailConfig) throw new RequestError('Gmail OAuth is unavailable.');
    const gmail = await finishGmailAuthorization(gmailConfig, pending, { state, code: clean(req.query.code, 4096) });
    await exclusive(() => saveSecrets({ ...secrets, gmail }));
    res.redirect('/?gmail=connected#connections');
  } catch (error) {
    res.redirect(`/?gmail=${encodeURIComponent(errorText(error))}#connections`);
  }
});
app.post('/api/gmail/disconnect', async (_req, res) => {
  await exclusive(async () => {
    if (workspace.queue.some(item => item.account === secrets.gmail?.email && active(item))) throw new RequestError('Cancel this mailbox’s scheduled emails before disconnecting.');
    await saveSecrets({ ...secrets, gmail: undefined });
  });
  res.json(snapshot());
});

app.post('/api/conferences/:id/research', async (req, res) => {
  const event = conference(req.params.id);
  if (req.body.autumn === true) {
    const connection = providerConnection('autumn');
    if (!connection.key && !connection.mcp) throw new RequestError('Connect Autumn to run expanded public research.');
    await exclusive(async () => {
      if (workspace.jobs.some(job => job.conferenceId === event.id && job.kind === 'discovery' && autumnJobOpen(job))) {
        throw new RequestError('Autumn already has a research task for this conference.');
      }
      const result = await startAutumnDiscovery({ name: event.title, url: event.url, notes: clean(req.body.notes, 500) }, connection);
      workspace.jobs.push({ id: result.taskId, conferenceId: event.id, kind: 'discovery', status: 'running', transport: connection.mcp ? 'mcp' : 'api' });
      await persist();
    });
  } else {
    const result = await researchConference({ name: event.title, url: event.url }, exaConnection());
    await exclusive(async () => { applyResearch(event, result); await persist(); });
  }
  res.json(snapshot());
});

function enrichmentLimit(value: unknown) {
  return Math.min(25, Math.max(1, Math.trunc(Number(value) || 10)));
}

function enrichmentPeople(event: Conference, provider: 'apollo' | 'autumn', limit: number) {
  const locked = new Set(workspace.queue.filter(item => item.conferenceId === event.id && active(item)).map(item => item.contactId));
  const waterfallContacts = new Set((workspace.apolloRuns ?? []).filter(run => run.conferenceId === event.id)
    .flatMap(run => run.recipients.filter(row => row.status !== 'skipped').map(row => row.contactId)));
  return rankContacts(event.contacts).filter(person => {
    if (!target(person) || person.sentAt || person.previouslyContacted || locked.has(person.id)) return false;
    return provider === 'apollo' ? !waterfallContacts.has(person.id) && canEnrichWithApollo(person) :
      !person.autumnChecked && (!person.hook || !person.hookSource || !person.email || person.emailStatus === 'unverified');
  }).slice(0, limit);
}

function enrichmentFingerprint(person: Contact) {
  return JSON.stringify([person.id, person.name, person.company, person.linkedin, person.email, person.emailStatus, person.bucket]);
}

app.post('/api/conferences/:id/enrich/apollo-preview', async (req, res) => {
  const event = conference(req.params.id);
  ensureLive(event);
  const connection = providerConnection('apollo');
  if (!connection.key && !connection.mcp) throw new RequestError('Connect Apollo before reviewing this batch.');
  if (!enrichmentPeople(event, 'apollo', 1).length) throw new RequestError('There are no eligible contacts left to enrich.');
  const { mode } = connection.mcp ? await planApolloMcpEnrichment(callResearchMcp, 1) : { mode: 'standard' as const };
  if (mode === 'waterfall' && !(await checkResearchMcp('apollo')).waterfallEmail?.pollAvailable) {
    await refreshMcpConnection('apollo');
    throw new RequestError('Reconnect Apollo MCP in Connections to allow Conference Desk to retrieve waterfall results.');
  }
  const candidates = enrichmentPeople(event, 'apollo', 10);
  const limit = req.body.limit === undefined && mode === 'waterfall' ? 1 : Math.min(10, enrichmentLimit(req.body.limit));
  const people = candidates.slice(0, limit);
  if (!people.length) throw new RequestError('There are no eligible contacts left to enrich.');
  const plan = connection.mcp ? await planApolloMcpEnrichment(callResearchMcp, people.length) : undefined;
  const token = randomUUID();
  const now = Date.now();
  const estimate = mode === 'waterfall' ? plan?.confirmation : undefined;
  for (const [id, saved] of apolloPreviews) if (saved.expiresAt <= now) apolloPreviews.delete(id);
  apolloPreviews.set(token, { conferenceId: event.id, fingerprint: JSON.stringify(people.map(enrichmentFingerprint)), limit,
    expiresAt: now + 600_000, mode, costLabel: estimate ?? '', mcp: Boolean(connection.mcp) });
  res.json({ token, people: people.map(person => person.company ? `${person.name} · ${person.company}` : person.name), mode,
    ...(mode === 'waterfall' ? { estimate, available: candidates.length } : { credits: people.length }),
  } satisfies ApolloPreview);
});

app.post('/api/conferences/:id/enrich', async (req, res) => {
  const event = conference(req.params.id);
  const provider = req.body.provider;
  if (provider !== 'apollo' && provider !== 'autumn') throw new RequestError('Choose Apollo or Autumn.');
  const connection = providerConnection(provider);
  if (!connection.key && !connection.mcp) throw new RequestError(`Connect ${provider === 'apollo' ? 'Apollo' : 'Autumn'} before running enrichment.`);
  let notes: string[] = [];
  if (provider === 'apollo') {
    if (runningApollo.has(event.id)) throw new RequestError('Apollo is already enriching this roster.');
    runningApollo.add(event.id);
    try {
      const { people, limit, run } = await exclusive(async () => {
        ensureLive(event);
        const token = clean(req.body.token);
        const approval = apolloPreviews.get(token);
        if (!approval || approval.conferenceId !== event.id || approval.expiresAt <= Date.now() || approval.mcp !== Boolean(connection.mcp) ||
            (approval.mode === 'waterfall' && req.body.approvedMode !== 'waterfall')) {
          throw new RequestError('Review and approve the current Apollo batch before using credits.');
        }
        const { limit } = approval;
        const people = enrichmentPeople(event, 'apollo', limit);
        if (approval.fingerprint !== JSON.stringify(people.map(enrichmentFingerprint))) {
          throw new RequestError('The contacts changed. Review the current Apollo batch before using credits.');
        }
        apolloPreviews.delete(token);
        const run: ApolloWaterfallRun | undefined = approval.mode === 'waterfall' ? {
          id: randomUUID(), conferenceId: event.id, approvedAt: new Date().toISOString(), costLabel: approval.costLabel,
          recipients: people.map(person => ({ contactId: person.id, name: person.name, company: person.company, linkedin: person.linkedin,
            status: 'queued', fingerprint: enrichmentFingerprint(person), notes: [] })),
        } : undefined;
        if (run) {
          (workspace.apolloRuns ??= []).push(run);
          await persist();
        }
        return { people, limit, run };
      });
      if (run) {
        res.status(202).json({ ...snapshot(), enrichmentNotes: [], apolloRunId: run.id });
        startApolloWorker();
        return;
      }
      const result = await enrichApollo(people, { ...connection, limit, mcpCreditLimit: connection.mcp ? people.length : undefined });
      notes = result.notes;
      await exclusive(async () => {
        applyEnrichment(event, result.contacts);
        event.notes = [...new Set([...event.notes, ...notes])];
        await persist();
      });
    } finally {
      runningApollo.delete(event.id);
    }
  } else {
    await exclusive(async () => {
      ensureLive(event);
      const people = enrichmentPeople(event, 'autumn', enrichmentLimit(req.body.limit));
      if (!people.length) throw new RequestError('There are no eligible contacts left to enrich.');
      if (workspace.jobs.some(job => job.conferenceId === event.id && job.kind === 'enrichment' && autumnJobOpen(job))) {
        throw new RequestError('Autumn already has an enrichment task for this roster.');
      }
      const result = await startAutumnEnrichment(people, event.title, connection);
      workspace.jobs.push({ id: result.taskId, conferenceId: event.id, kind: 'enrichment', status: 'running',
        transport: connection.mcp ? 'mcp' : 'api', contactIds: people.map(person => person.id) });
      await persist();
    });
  }
  res.json({ ...snapshot(), enrichmentNotes: notes });
});

app.post('/api/conferences/:id/enrich/apollo-runs/:runId/check', async (req, res) => {
  await exclusive(async () => {
    const run = workspace.apolloRuns?.find(item => item.conferenceId === req.params.id && item.id === req.params.runId);
    if (!run) throw new RequestError('Apollo run not found.', 404);
    const now = Date.now();
    for (const person of run.recipients) {
      if (!person.requestId || (person.status !== 'waiting' && person.status !== 'uncertain')) continue;
      person.status = 'pending';
      person.nextCheckAt = now;
      person.checkUntil = now + waterfallPollWindow;
    }
    await persist();
  });
  res.json(snapshot());
  startApolloWorker();
});

app.post('/api/conferences/:id/research/:jobId/reply', async (req, res) => {
  const event = conference(req.params.id);
  const message = clean(req.body.message, 4000);
  if (!message) throw new RequestError('Enter an answer for Autumn.');
  await exclusive(async () => {
    const job = workspace.jobs.find(item => item.conferenceId === event.id && item.id === req.params.jobId);
    if (!job || job.status !== 'needs_input') throw new RequestError('This Autumn task is no longer waiting for an answer.');
    await replyAutumn(job.id, message, autumnJobConnection(job));
    job.status = 'running';
    delete job.message;
    await persist();
  });
  res.json(snapshot());
});

function applyEnrichment(event: Conference, people: Contact[]) {
  for (const row of people) {
    const person = event.contacts.find(current => current.id === row.id);
    if (!person || person.sentAt || workspace.queue.some(item => item.conferenceId === event.id && item.contactId === row.id && active(item))) continue;
    for (const field of ['title', 'company', 'linkedin', 'hook', 'hookSource'] as const) if (row[field]) person[field] = row[field];
    if (row.email && person.emailStatus !== 'verified') {
      if (row.email !== person.email && person.draft?.gmailId) continue;
      person.email = row.email;
      person.emailStatus = row.emailStatus;
      person.emailSource = row.emailSource;
    }
    person.apolloChecked ||= row.apolloChecked;
    person.autumnChecked ||= row.autumnChecked;
    recalculate(person);
  }
}

const waterfallPollWindow = 180_000;
let apolloWorkerRunning = false;

function startApolloWorker() {
  if (apolloWorkerRunning || !workspace.apolloRuns?.length) return;
  apolloWorkerRunning = true;
  void workApolloLookup().catch(error => console.error('Apollo waterfall:', errorText(error)))
    .finally(() => { apolloWorkerRunning = false; });
}

async function workApolloLookup() {
  const work = await exclusive(async () => {
    if (!mcpConnections.apollo || mcpConnections.apollo.status !== 'connected' || mcpConnections.apollo.canLogin) return;
    const now = Date.now();
    for (const run of workspace.apolloRuns ?? []) {
      const event = workspace.conferences.find(item => item.id === run.conferenceId);
      for (const row of run.recipients) {
        if (row.status !== 'queued' && (row.status !== 'pending' || (row.nextCheckAt ?? 0) > now)) continue;
        const current = event?.contacts.find(person => person.id === row.contactId);
        if (row.status === 'pending') {
          if (row.requestId && (row.checkUntil ?? 0) > now) return { event, row, current, poll: { requestId: row.requestId, personId: row.personId } };
          row.status = row.requestId ? 'waiting' : 'uncertain';
          await persist();
          continue;
        }
        if (!event || isPast(event) || !current || enrichmentFingerprint(current) !== row.fingerprint ||
            !canEnrichWithApollo(current) || current.sentAt || current.previouslyContacted ||
            workspace.queue.some(item => item.conferenceId === event.id && item.contactId === current.id && active(item))) {
          row.status = 'skipped';
          row.notes.push('This contact changed or no longer needs a lookup. Apollo was not called.');
          await persist();
          continue;
        }
        row.status = 'submitting';
        await persist();
        return { event, row, current: { ...current }, poll: undefined };
      }
    }
  });
  if (!work) return;
  const { event, row, current, poll } = work;
  if (!poll && current) {
    const result = await submitApolloWaterfall(current, callResearchMcp);
    await exclusive(async () => {
      Object.assign(row, { status: result.status, requestId: result.requestId, personId: result.personId, creditsUsed: result.creditsUsed, notes: result.notes });
      if (result.status === 'pending') {
        row.nextCheckAt = Date.now() + Math.max(15, result.retryAfterSeconds ?? 15) * 1000;
        row.checkUntil = Date.now() + waterfallPollWindow;
      }
      await persist();
    });
  } else if (poll) {
    const result = await pollApolloWaterfall<ResearchContact>({ name: row.name, company: row.company, linkedin: row.linkedin, attendance: 'unconfirmed' }, poll, callResearchMcp);
    await exclusive(async () => {
      const priorNotes = result.creditsUsed === undefined ? row.notes : row.notes.filter(note => !note.includes('charge pending'));
      row.notes = [...new Set([...priorNotes, ...result.notes])];
      row.creditsUsed = result.creditsUsed ?? row.creditsUsed;
      if (result.status === 'pending') {
        row.nextCheckAt = Date.now() + Math.max(15, result.retryAfterSeconds ?? 30) * 1000;
      } else if (result.status === 'failed') {
        row.status = 'failed';
      } else {
        row.email = result.contact.email;
        row.status = row.email ? 'matched' : 'no_match';
        if (event && current && event.contacts.includes(current) && enrichmentFingerprint(current) === row.fingerprint &&
            !current.sentAt && !current.previouslyContacted && !current.draft?.gmailId &&
            !workspace.queue.some(item => item.conferenceId === event.id && item.contactId === row.contactId && active(item))) {
          applyEnrichment(event, [{ ...current, email: row.email ?? current.email,
            emailStatus: result.contact.emailStatus ?? current.emailStatus, emailSource: result.contact.emailSource ?? current.emailSource, apolloChecked: true }]);
        } else if (row.email) {
          row.notes.push('The contact or its outreach changed during the lookup. The result is saved here for review.');
        }
      }
      await persist();
    });
  }
}

async function recoverApolloSubmissions() {
  let changed = false;
  for (const run of workspace.apolloRuns ?? []) for (const row of run.recipients) {
    if (row.status !== 'submitting') continue;
    row.status = 'uncertain';
    row.notes.push('Conference Desk restarted before recording Apollo’s receipt. Check Apollo’s enrichment history before retrying.');
    changed = true;
  }
  if (changed) await persist();
}

app.post('/api/conferences/:id/gmail-drafts', async (req, res) => {
  const result = await exclusive(async () => {
    const event = conference(req.params.id);
    ensureLive(event);
    const { config, account: mailbox } = account();
    const access = await getGmailAccessToken(config, mailbox);
    const requestedId = clean(req.body.contactId);
    const people = rankContacts(event.contacts).filter(person => (!requestedId || person.id === requestedId) && canReachContact(person));
    const reservations = outreachReservations(workspace.conferences, workspace.queue);
    const owners = outreachDraftOwners(workspace.conferences, mailbox.email);
    const selected = new Set<string>();
    let held = 0;
    let synced = 0;
    let error: string | undefined;
    const exportable = people.filter(person => {
      if (reserved(person, reservations) || reserved(person, selected) || hasOtherGmailDraft(event, person, owners)) {
        held++;
        return false;
      }
      for (const key of outreachContactKeys(person)) selected.add(key);
      return true;
    });
    // Gmail displays newest drafts first, so create the highest-ranked drafts last.
    for (const person of exportable.reverse()) {
      try {
        if (await reconcileOwnSend(access, event, person, mailbox.email)) { await persist(); continue; }
        const prior = await findPriorGmailOutreach(access, person.email!);
        if (prior) { recordPrior(person, prior, mailbox.email); held++; await persist(); continue; }
        prepareDraft(event, person);
        const input = draftInput(event, person, mailbox.email);
        const existing = person.draft!.gmailAccount === mailbox.email && person.draft!.gmailId;
        const revision = draftRevision(input);
        if (existing && person.draft!.gmailRevision === revision) { synced++; continue; }
        const recovered = existing ? undefined : await findGmailDraft(access, input.messageId);
        const id = existing || recovered?.id;
        const exportedAt = new Date().toISOString();
        const draft = id ? await updateGmailDraft(access, id, input) : await createGmailDraft(access, input);
        rememberDraft(person, draft, input, exportedAt);
        synced++;
        await persist();
      } catch (failure) {
        error ||= errorText(failure);
        if (!(failure instanceof GmailApiError) || ![400, 404, 409].includes(failure.status)) break;
      }
    }
    return { synced, held, error };
  });
  res.json({ ...result, snapshot: snapshot() });
});

async function buildBatchPreview(conferenceId: string | undefined, body: { count?: unknown; now?: unknown; conferenceIds?: unknown }) {
  const selectedConferenceIds = conferenceId ? [conferenceId] : Array.isArray(body.conferenceIds)
    ? [...new Set(body.conferenceIds.filter((id): id is string => typeof id === 'string' && id.length <= 400))] : undefined;
  if (conferenceId) ensureLive(conference(conferenceId));
  if (selectedConferenceIds && !selectedConferenceIds.length) throw new RequestError('Choose at least one conference.');
  const count = Number(body.count ?? 5);
  if (!Number.isInteger(count) || count < 5 || count > 10) throw new RequestError('Choose a batch size from 5 to 10.');
  const mailbox = gmailConfig ? secrets.gmail?.email : undefined;
  const sendNow = body.now === true;
  if (sendNow && !mailbox) throw new RequestError('Connect Gmail to send an email now.');
  const now = new Date();
  const { rows: planned, duplicateCount, readyCount } = planOutreach({
    conferences: workspace.conferences, queue: workspace.queue, selectedConferenceIds, account: mailbox || '', count, now, sendNow,
  });
  if (!readyCount) throw new RequestError('There are no new contacts with sourced email addresses for the selected conferences.');
  if (!planned.length) throw new RequestError(sendNow ? 'The inbox needs five minutes between sends. Try a scheduled batch.' : 'No send slots are available before the selected conferences.');
  const rows = planned.map(({ event, contact: person, scheduledAt }) => {
    const draft = prepareDraft(event, person);
    return {
      conferenceId: event.id, conferenceTitle: event.shortTitle || event.title, contactId: person.id, name: person.name,
      email: person.email, subject: draft.subject, body: draft.body, bucket: person.bucket, scheduledAt,
    };
  });
  await persist();
  const preview: BatchPreview = { token: randomUUID(), conferenceId, account: mailbox, duplicateCount, rows };
  for (const [id, saved] of previews) if (saved.expiresAt <= Date.now()) previews.delete(id);
  previews.set(preview.token, { preview, expiresAt: Date.now() + 600_000, fingerprint: fingerprint(rows) });
  return { preview, snapshot: snapshot() };
}

app.post('/api/conferences/:id/schedule/preview', async (req, res) => {
  res.json(await exclusive(() => buildBatchPreview(req.params.id, req.body)));
});
app.post('/api/schedule/preview', async (req, res) => {
  res.json(await exclusive(() => buildBatchPreview(undefined, req.body)));
});

async function confirmBatch(token: string, scopedConference?: string) {
  const count = await exclusive(async () => {
    const { account: mailbox } = account();
    const saved = previews.get(token);
    if (!saved || saved.expiresAt <= Date.now() || saved.preview.conferenceId !== scopedConference ||
        saved.preview.account !== mailbox.email || saved.fingerprint !== fingerprint(saved.preview.rows)) {
      throw new RequestError('This batch preview expired or changed. Review a new preview.');
    }
    const draftOwners = outreachDraftOwners(workspace.conferences, mailbox.email);
    const additions: QueueItem[] = [];
    const now = Date.now();
    const occupied = workspace.queue.flatMap(item => {
      if (item.account !== mailbox.email) return [];
      return [active(item) ? Date.parse(item.scheduledAt) : NaN, item.sendingAt ? Date.parse(item.sendingAt) : NaN].filter(Number.isFinite);
    });
    const { rows } = saved.preview;
    for (const row of rows) {
      const event = conference(row.conferenceId);
      const person = contact(event, row.contactId);
      const slot = Date.parse(row.scheduledAt);
      const reservations = outreachReservations(workspace.conferences, [...workspace.queue, ...additions]);
      if (!canReachContact(person) || reserved(person, reservations) || hasOtherGmailDraft(event, person, draftOwners) ||
        !isOutreachOpen(event, new Date(slot)) || !isOutreachOpen(event, new Date(now)) || slot < now - 600_000 ||
        occupied.some(time => Math.abs(time - slot) < SCHEDULE_GAP_MS)) {
        throw new RequestError('The queue changed. Review a fresh batch before scheduling.');
      }
      occupied.push(slot);
      additions.push({
        id: randomUUID(), conferenceId: row.conferenceId, contactId: row.contactId, account: mailbox.email, email: row.email,
        subject: row.subject, body: row.body, scheduledAt: row.scheduledAt, status: 'scheduled',
      });
    }
    workspace.queue.push(...additions);
    await persist();
    previews.delete(token);
    return rows.length;
  });
  const result = { count, snapshot: snapshot() };
  void tick().catch(error => console.error('Queue worker:', errorText(error)));
  return result;
}

app.post('/api/conferences/:id/schedule', async (req, res) => {
  res.json(await confirmBatch(clean(req.body.token), req.params.id));
});
app.post('/api/schedule', async (req, res) => {
  res.json(await confirmBatch(clean(req.body.token)));
});

app.post('/api/queue/:id/cancel', async (req, res) => {
  await exclusive(async () => {
    const item = workspace.queue.find(row => row.id === req.params.id);
    if (!item || item.status !== 'scheduled') throw new RequestError('This send is already processing or no longer scheduled.');
    item.status = 'cancelled';
    await persist();
  });
  res.json(snapshot());
});

type MailThread = NonNullable<Awaited<ReturnType<typeof inspectGmailThread>>>;

function recordThread(event: Conference, person: Contact, threadId: string, thread: MailThread, mailbox: string) {
  markSent(event, person, { id: thread.sentMessageId, threadId, internalDate: String(Date.parse(thread.sentAt)) }, mailbox,
    person.draft?.gmailExportedEmail, person.draft?.gmailExportedSubject);
  person.repliedAt ||= thread.firstReplyAt;
  person.replyCount = Math.max(person.replyCount || Number(Boolean(person.repliedAt)), thread.replyCount);
  for (const item of workspace.queue) {
    if (item.conferenceId === event.id && item.contactId === person.id && item.account === mailbox && item.status === 'sent') {
      item.repliedAt = person.repliedAt;
      item.replyCount = person.replyCount;
    }
  }
}

async function reconcileOwnSend(access: string, event: Conference, person: Contact, mailbox: string) {
  const rfcMessageId = gmailMessageId(event.id, person.id);
  const sent = await findGmailSent(access, rfcMessageId);
  if (sent) {
    markSent(event, person, sent, mailbox, person.draft?.gmailExportedEmail, person.draft?.gmailExportedSubject);
    return true;
  }
  const draft = person.draft;
  if (!draft?.gmailThreadId || draft.gmailAccount !== mailbox) return false;
  const thread = await inspectGmailThread(access, {
    threadId: draft.gmailThreadId, recipient: draft.gmailExportedEmail || person.email!, rfcMessageId,
    draftSubject: draft.gmailExportedSubject, draftExportedAt: draft.gmailExportedAt,
  });
  if (!thread) return false;
  recordThread(event, person, draft.gmailThreadId, thread, mailbox);
  return true;
}

async function processSend(item: QueueItem) {
  const { config, account: mailbox } = account();
  const event = conference(item.conferenceId);
  const person = contact(event, item.contactId);
  const messageId = gmailMessageId(event.id, person.id);
  const access = await getGmailAccessToken(config, mailbox);
  if (await reconcileOwnSend(access, event, person, mailbox.email)) return;
  if (item.sendingAt) throw new RequestError('The last send could not be confirmed. Check Sent in Gmail and sync before taking another action.');
  if (Date.now() - Date.parse(item.scheduledAt) > 15 * 60_000) throw new RequestError('The worker missed the scheduled time. This email was held for review.');
  if (!isOutreachOpen(event, new Date())) throw new RequestError('This conference’s outreach window has closed.');
  if (!canReachContact(person) || person.email !== item.email) throw new RequestError('A contact change needs review.');
  if (reserved(person, outreachReservations(workspace.conferences, []))) {
    throw new RequestError('This contact already has outreach recorded elsewhere.');
  }
  if (reserved(person, outreachReservations(workspace.conferences, workspace.queue, item.id)) ||
      hasOtherGmailDraft(event, person, outreachDraftOwners(workspace.conferences, mailbox.email))) {
    throw new RequestError('This contact already has an email in another conference’s queue or Gmail drafts.');
  }
  const prior = await findPriorGmailOutreach(access, item.email);
  if (prior) {
    recordPrior(person, prior, mailbox.email);
    throw new RequestError('Existing outreach was found in Gmail. Open this contact to see the earlier thread.');
  }
  const input = { to: item.email, subject: item.subject, body: item.body, messageId, from: mailbox.email };
  const existing = person.draft?.gmailAccount === mailbox.email && person.draft.gmailId;
  let draftId = existing || undefined;
  if (!draftId) {
    const exportedAt = new Date().toISOString();
    const draft = await findGmailDraft(access, messageId) || await createGmailDraft(access, input);
    draftId = draft.id;
    rememberDraft(person, draft, input, exportedAt);
    await persist();
  }
  const sent = await sendGmailDraft(access, draftId, { recipient: item.email, messageId, subject: item.subject, body: item.body, from: mailbox.email }, async () => {
    item.sendingAt = new Date().toISOString();
    item.draftId = draftId;
    await persist();
  });
  markSent(event, person, sent, mailbox.email, item.email, item.subject);
}

async function syncMailbox(full = true) {
  const { config, account: mailbox } = account();
  const access = await getGmailAccessToken(config, mailbox);
  const unresolved = new Set(workspace.queue.filter(item => item.account === mailbox.email &&
    (item.status === 'failed' || item.status === 'sending')).map(item => item.contactId));
  const recentCutoff = Date.now() - 14 * 86_400_000;
  const tracked = workspace.conferences.flatMap(event => event.contacts.filter(person => person.email && (
    unresolved.has(person.id) ||
    (person.draft?.gmailAccount === mailbox.email && !person.sentAt) ||
    (person.gmailAccount === mailbox.email && (full || !isPast(event) || Date.parse(person.sentAt || '') >= recentCutoff))
  )).map(person => ({ event, person })));
  let synced = 0;
  for (let offset = 0; offset < tracked.length; offset += 6) {
    const outcomes = await Promise.allSettled(tracked.slice(offset, offset + 6).map(async ({ event, person }) => {
      if (!person.gmailThreadId || !person.gmailMessageId) {
        if (!await reconcileOwnSend(access, event, person, mailbox.email)) return false;
      }
      const threadId = person.gmailThreadId!;
      const thread = await inspectGmailThread(access, {
        threadId, sentMessageId: person.gmailMessageId!, recipient: person.sentEmail || person.draft?.gmailExportedEmail || person.email!,
        rfcMessageId: gmailMessageId(event.id, person.id),
      });
      if (thread) recordThread(event, person, threadId, thread, mailbox.email);
      return true;
    }));
    await persist();
    synced += outcomes.filter(result => result.status === 'fulfilled' && result.value).length;
    const failure = outcomes.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  return synced;
}

app.post('/api/gmail/sync', async (_req, res) => {
  const synced = await exclusive(() => syncMailbox());
  res.json({ synced, snapshot: snapshot() });
});

async function refreshJob(job: ResearchJob) {
  const connection = autumnJobConnection(job);
  if (!connection.key && !connection.mcp) return;
  const event = conference(job.conferenceId);
  try {
    const people = job.kind === 'enrichment' ? event.contacts.filter(person => job.contactIds?.includes(person.id)) : [];
    const result = job.kind === 'discovery' ? await pollAutumnDiscovery(job.id, connection)
      : await pollAutumnEnrichment(job.id, people, connection);
    await exclusive(async () => {
      if (job.status !== 'running') return;
      if (result.state === 'input-required') {
        job.status = 'needs_input';
        job.message = result.message || 'Autumn is waiting for more information.';
      } else if (result.done) {
        if (job.kind === 'discovery') {
          mergeContacts(event, result.contacts);
          combineSources(event, result.contacts.flatMap(person => person.sourceUrl ? [{ url: person.sourceUrl, label: person.sourceLabel || 'Autumn public research' }] : []));
          job.message = result.message || `Found ${result.contacts.length} public entries. Import the organizer roster for fuller coverage.`;
        } else {
          applyEnrichment(event, result.contacts as Contact[]);
          job.message = result.message || `Checked ${people.length} contacts.`;
        }
        job.status = /fail|cancel/i.test(result.state) ? 'failed' : 'done';
      } else return;
      await persist();
    });
  } catch (error) {
    await exclusive(async () => {
      if (job.status !== 'running') return;
      job.message = errorText(error);
      await persist();
    });
  }
}

let researchPollRunning = false;
async function pollResearchJobs() {
  if (researchPollRunning) return;
  researchPollRunning = true;
  try {
    for (const job of workspace.jobs.filter(item => item.status === 'running')) await refreshJob(job);
  } finally { researchPollRunning = false; }
}

let ticking = false;
let lastResearchCheck = 0;
let lastGmailSync = 0;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await exclusive(async () => {
      const now = Date.now();
      if (gmailConfig && secrets.gmail) {
        const pending = workspace.queue.filter(item => item.account === secrets.gmail?.email && active(item) && Date.parse(item.scheduledAt) <= now)
          .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
        const recent = workspace.queue.some(item => item.account === secrets.gmail?.email && item.status !== 'sending' && item.sendingAt && now - Date.parse(item.sendingAt) < SCHEDULE_GAP_MS);
        for (const item of recent ? pending.filter(candidate => candidate.status === 'sending') : pending) {
          item.status = 'sending';
          await persist();
          try { await processSend(item); }
          catch (error) { item.status = 'failed'; item.error = errorText(error); }
          await persist();
          if (item.sendingAt) break;
        }
      }
    });
    if (Date.now() - lastResearchCheck > 25_000) {
      lastResearchCheck = Date.now();
      void pollResearchJobs().catch(error => console.error('Autumn polling:', errorText(error)));
    }
    if (gmailConfig && secrets.gmail && Date.now() - lastGmailSync > 5 * 60_000) {
      lastGmailSync = Date.now();
      await exclusive(() => syncMailbox(false)).catch(() => undefined);
    }
  } finally { ticking = false; }
}

app.post('/api/queue/:id/review', async (req, res) => {
  await exclusive(async () => {
    const item = workspace.queue.find(row => row.id === req.params.id);
    if (!item || item.status !== 'failed') throw new RequestError('This email is not held for review.');
    if (item.sendingAt) throw new RequestError('Sync Gmail to reconcile this send before releasing it.');
    item.status = 'cancelled';
    await persist();
  });
  res.json(snapshot());
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = error instanceof RequestError ? error.status : Number((error as { status?: number })?.status) || 500;
  res.status(status >= 400 && status <= 599 ? status : 500).json({ error: errorText(error) });
});
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(resolve('dist')));
  app.get('/', (_req, res) => res.sendFile(resolve('dist/index.html')));
} else {
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}
lockWorkspace();
await initializeStorage();
await recoverApolloSubmissions();
checkCodex();
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Conference Desk is running at ${origin}`);
  for (const provider of ['apollo', 'autumn', 'exa'] as const) void refreshMcpConnection(provider);
});
const timer = setInterval(() => {
  startApolloWorker();
  void tick().catch(error => console.error('Queue worker:', errorText(error)));
}, 5000);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  clearInterval(timer);
  closeResearchMcp();
  server.close(() => { void mutation.then(closeStorage).then(() => process.exit(0), () => process.exit(1)); });
});
