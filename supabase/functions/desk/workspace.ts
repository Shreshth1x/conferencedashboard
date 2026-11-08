import type { BatchPreview, Conference, Contact, ICP, McpConnection, Provider, QueueItem, Snapshot, Workspace } from "../../../src/model.ts";
import { isPast, localDate, rankContacts, safeLink, target } from "../../../src/model.ts";
import { canReachContact, isOutreachOpen, outreachContactKeys, outreachDraftOwners, outreachReservations, planOutreach } from "../../../server/outreach-planner.ts";
import { SCHEDULE_GAP_MS } from "../../../server/schedule.ts";
import { writeDraft } from "../../../server/outbound-writer.ts";
import { parseAttendeeList, scoreContact, type ResearchContact, type ResearchResult } from "../../../server/conference-research.ts";
import type { GmailAuthorization } from "../../../server/gmail.ts";
import type { DeskState } from "./storage.ts";
import { deskGmailConfig, exportDeskGmailDrafts, getDeskMailbox, hasConflictingDeskDraft, syncDeskMailbox } from "./mail.ts";
import { clean, DeskError, expire, token } from "./shared.ts";
import { apolloAction, checkHostedMcp, discovery, enrichment, providerKey, queueConferenceDiscovery, refreshApollo } from "./providers.ts";

type Input = Record<string, unknown>;
export type HostedState = {
  oauth?: Record<string, { pending: GmailAuthorization; mode: "login" | "mailbox"; returnUrl: string; ownerSession?: string }>;
  exchanges?: Record<string, { expiresAt: number; sessionToken: string }>;
  sessions?: Record<string, number>;
  batchPreviews?: Record<string, { preview: BatchPreview; expiresAt: number; fingerprint: string }>;
  apolloPreviews?: Record<string, { conferenceId: string; contactIds: string[]; fingerprints: string[]; expiresAt: number }>;
  providerChecks?: Partial<Record<Provider, McpConnection>>;
};
export const hosted = (state: Pick<DeskState, "secrets">) => (state.secrets.hosted ??= {}) as HostedState;
export const active = (item: QueueItem) => item.status === "scheduled" || item.status === "sending";

export function conference(workspace: Workspace, id: string) {
  const event = workspace.conferences.find(item => item.id === id);
  if (!event) throw new DeskError("Conference not found.", 404);
  return event;
}
function contact(event: Conference, id: string) {
  const person = event.contacts.find(item => item.id === id);
  if (!person) throw new DeskError("Contact not found.", 404);
  return person;
}
export function ensureLive(event: Conference) {
  if (event.example || isPast(event)) throw new DeskError("Choose an active conference for outreach.");
}
const validDate = (value: string) => !value || (/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
const normalized = (value?: string) => value?.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ") || "";
function samePerson(a: ResearchContact, b: ResearchContact) {
  return Boolean(a.email && b.email && normalized(a.email) === normalized(b.email)) ||
    Boolean(a.linkedin && b.linkedin && normalized(a.linkedin).replace(/\/$/, "") === normalized(b.linkedin).replace(/\/$/, "")) ||
    (normalized(a.name) === normalized(b.name) && (!a.company || !b.company || normalized(a.company) === normalized(b.company)));
}

export function mergeContacts(workspace: Workspace, event: Conference, incoming: ResearchContact[]) {
  let added = 0;
  for (const person of incoming) {
    if (!person.name) continue;
    const existing = event.contacts.find(row => samePerson(row, person));
    if (!existing) {
      event.contacts.push({ ...person, id: crypto.randomUUID(), ...scoreContact(person, workspace.icp) });
      added++;
      continue;
    }
    for (const field of ["title", "company", "linkedin", "hook", "hookSource", "sourceUrl", "sourceLabel", "sessionTitle"] as const) {
      if (!existing[field] && person[field]) existing[field] = person[field];
    }
    if (!existing.email && person.email) {
      existing.email = person.email;
      existing.emailStatus = person.emailStatus;
      existing.emailSource = person.emailSource;
    } else if (existing.email && person.email && normalized(existing.email) === normalized(person.email) &&
        (!existing.emailStatus || existing.emailStatus === "unverified") && person.emailSource &&
        (person.emailStatus === "sourced" || person.emailStatus === "verified") && !existing.sentAt && !existing.previouslyContacted &&
        !workspace.queue.some(item => item.conferenceId === event.id && item.contactId === existing.id && active(item))) {
      existing.emailStatus = person.emailStatus;
      existing.emailSource = person.emailSource;
    }
    if (existing.attendance === "unconfirmed") existing.attendance = person.attendance;
    Object.assign(existing, scoreContact(existing, workspace.icp));
  }
  return added;
}
export function applyResearch(workspace: Workspace, event: Conference, result: ResearchResult) {
  event.location ||= result.location;
  event.startDate ||= result.startDate;
  event.endDate ||= result.endDate;
  event.url ||= result.url;
  event.notes = [...new Set([...event.notes, ...result.notes])];
  for (const source of result.sources) if (!event.sources.some(existing => existing.url === source.url)) event.sources.push(source);
  mergeContacts(workspace, event, result.contacts);
  event.needsRoster &&= result.needsRoster;
}

export function snapshot(state: Pick<DeskState, "workspace" | "secrets">): Snapshot {
  const { workspace, secrets } = state;
  const gmailConfig = deskGmailConfig();
  const mailboxes = Object.keys(secrets.mailboxes).sort();
  const gmail = gmailConfig ? mailboxes.find(email => email === secrets.activeMailbox) ?? mailboxes[0] : undefined;
  const { readyCount } = planOutreach({ conferences: workspace.conferences, queue: workspace.queue, account: gmail || "", count: 0 });
  return {
    ...workspace, outreachReady: readyCount,
    connections: { gmailConfigured: Boolean(gmailConfig), gmailRedirectUri: gmailConfig?.redirectUri,
      gmail, mailboxes, apollo: Boolean(providerKey(state, "apollo")), autumn: Boolean(providerKey(state, "autumn")),
      exa: Boolean(providerKey(state, "exa")), codex: false,
      mcp: { exa: { status: "connected", detail: "Public web search" }, ...hosted(state).providerChecks } },
  };
}

function fingerprint(workspace: Workspace, rows: BatchPreview["rows"]) {
  return JSON.stringify(rows.map(row => {
    const event = conference(workspace, row.conferenceId);
    const person = contact(event, row.contactId);
    return [event.id, event.title, event.shortTitle, event.startDate, event.endDate, person.id, person.name, person.email,
      person.draft?.subject, person.draft?.body, person.emailStatus, person.bucket, person.score, person.linkedin];
  }));
}

async function previewBatch(state: DeskState, input: Input, conferenceId?: string) {
  const { workspace } = state;
  if (conferenceId) ensureLive(conference(workspace, conferenceId));
  const selectedConferenceIds = conferenceId ? [conferenceId] : Array.isArray(input.conferenceIds)
    ? [...new Set(input.conferenceIds.filter((id): id is string => typeof id === "string" && id.length <= 400))] : undefined;
  if (selectedConferenceIds && !selectedConferenceIds.length) throw new DeskError("Choose at least one conference.");
  const count = Number(input.count ?? 5);
  if (!Number.isInteger(count) || count < 5 || count > 10) throw new DeskError("Choose a batch size from 5 to 10.");
  const account = input.email ? getDeskMailbox(state, clean(input.email, 254)).email : snapshot(state).connections.gmail;
  const sendNow = input.now === true;
  if (sendNow && !account) throw new DeskError("Connect Gmail before sending now.");
  const { rows: planned, duplicateCount, readyCount } = planOutreach({
    conferences: workspace.conferences, queue: workspace.queue, selectedConferenceIds, account: account || "", count, sendNow,
  });
  if (!readyCount) throw new DeskError("There are no new contacts with sourced email addresses for the selected conferences.");
  const rows = planned.filter(({ event, contact: person }) => !account || !hasConflictingDeskDraft(workspace, event, person, account))
    .map(({ event, contact: person, scheduledAt }) => {
      const draft = person.draft ??= writeDraft(event, person);
      return {
        conferenceId: event.id, conferenceTitle: event.shortTitle || event.title, contactId: person.id, name: person.name,
        email: person.email, subject: draft.subject, body: draft.body, bucket: person.bucket, scheduledAt,
      };
    });
  if (!rows.length) throw new DeskError("No send slots are available. Check conference dates and drafts from other mailboxes.");
  const preview: BatchPreview = { token: token(), conferenceId, account, duplicateCount, rows };
  const saved = hosted(state).batchPreviews ??= {};
  expire(saved, value => value.expiresAt <= Date.now());
  if (Object.keys(saved).length >= 20) throw new DeskError("Too many open previews. Try again in a few minutes.", 429);
  saved[preview.token] = { preview, expiresAt: Date.now() + 600_000, fingerprint: fingerprint(workspace, rows) };
  await state.save();
  return { preview, snapshot: snapshot(state) };
}

async function confirmBatch(state: DeskState, id: string, conferenceId?: string) {
  const { workspace } = state;
  const saved = hosted(state).batchPreviews?.[id];
  if (!saved || saved.expiresAt <= Date.now() || saved.preview.conferenceId !== conferenceId || !saved.preview.account ||
      saved.fingerprint !== fingerprint(workspace, saved.preview.rows)) {
    throw new DeskError("This batch preview expired or changed. Review a new preview.");
  }
  const { email: account } = getDeskMailbox(state, saved.preview.account);
  const now = new Date();
  const occupied = workspace.queue.filter(item => item.account === account).flatMap(item =>
    [active(item) ? Date.parse(item.scheduledAt) : NaN, item.sendingAt ? Date.parse(item.sendingAt) : NaN].filter(Number.isFinite));
  const additions: QueueItem[] = [];
  const owners = outreachDraftOwners(workspace.conferences, account);
  for (const row of saved.preview.rows) {
    const event = conference(workspace, row.conferenceId);
    const person = contact(event, row.contactId);
    const slot = Date.parse(row.scheduledAt);
    const keys = outreachContactKeys(person);
    const reservations = outreachReservations(workspace.conferences, [...workspace.queue, ...additions]);
    if (!canReachContact(person) || keys.some(key => {
      const owner = owners.get(key);
      return reservations.has(key) || Boolean(owner && (owner.conferenceId !== event.id || owner.contactId !== person.id));
    }) || hasConflictingDeskDraft(workspace, event, person, account) || !isOutreachOpen(event, now) ||
        !isOutreachOpen(event, new Date(slot)) || slot < now.getTime() - 600_000 ||
        occupied.some(time => Math.abs(time - slot) < SCHEDULE_GAP_MS)) {
      throw new DeskError("The queue or a contact changed. Review a fresh batch before scheduling.");
    }
    occupied.push(slot);
    additions.push({ id: crypto.randomUUID(), conferenceId: event.id, contactId: person.id, account, email: row.email,
      subject: row.subject, body: row.body, scheduledAt: row.scheduledAt, status: "scheduled" });
  }
  workspace.queue.push(...additions);
  delete hosted(state).batchPreviews![id];
  await state.save();
  return { count: additions.length, snapshot: snapshot(state) };
}

export async function workspaceAction(state: DeskState, path: string[], input: Input) {
  const { workspace, secrets } = state;
  const [group, id, action, detail, extra] = path;
  if (group === "schedule" && path.length <= 2) {
    return id === "preview" ? previewBatch(state, input) : confirmBatch(state, clean(input.token));
  }
  if (group === "queue" && id && ["cancel", "review"].includes(action)) {
    const item = workspace.queue.find(row => row.id === id);
    if (!item || (action === "cancel" ? item.status !== "scheduled" : item.status !== "failed" || item.sendingAt)) {
      throw new DeskError("This item cannot be released. Check its status and sync Gmail if needed.");
    }
    item.status = "cancelled";
  } else if (group === "gmail" && id === "sync") {
    const synced = await syncDeskMailbox(state, clean(input.email, 254) || undefined);
    return { synced, snapshot: snapshot(state) };
  } else if (group === "gmail" && (id === "select" || id === "disconnect")) {
    const { email } = getDeskMailbox(state, clean(input.email, 254) || undefined);
    if (id === "select") secrets.activeMailbox = email;
    else {
      if (workspace.queue.some(item => item.account === email && active(item))) throw new DeskError("Cancel this mailbox’s scheduled emails before disconnecting.");
      delete secrets.mailboxes[email];
      if (secrets.activeMailbox === email) secrets.activeMailbox = Object.keys(secrets.mailboxes).sort()[0];
    }
  } else if (group === "connections" && ["apollo", "autumn", "exa"].includes(id)) {
    const key = clean(input.key, 4096);
    if (key && (key.length < 10 || /\s/.test(key))) throw new DeskError("Enter a valid API key.");
    const keys = secrets.keys ??= {};
    if (key) keys[id as Provider] = key;
    else delete keys[id as Provider];
    const checks = hosted(state).providerChecks;
    if (checks) delete checks[id as Provider];
  } else if (group === "connections" && id === "mcp" && action === "check") {
    const provider = input.provider;
    if (provider !== "apollo" && provider !== "autumn" && provider !== "exa") throw new DeskError("Choose a research provider.");
    (hosted(state).providerChecks ??= {})[provider] = await checkHostedMcp(state, provider);
    await state.save();
    return { snapshot: snapshot(state) };
  } else if (group === "connections" && id === "codex") {
    return { connected: false, snapshot: snapshot(state) };
  } else if (group === "icp") {
    const terms = (value: unknown) => Array.isArray(value) ? [...new Set(value.map(term => clean(term, 180)).filter(Boolean))].slice(0, 500) : [];
    const icp: ICP = { name: clean(input.name), description: clean(input.description, 3000), direct: terms(input.direct),
      connector: terms(input.connector), accounts: terms(input.accounts) };
    if (!icp.name || !icp.direct.length) throw new DeskError("Add an ICP name and at least one direct fit signal.");
    workspace.icp = icp;
    for (const event of workspace.conferences) for (const person of event.contacts) Object.assign(person, scoreContact(person, icp));
  } else if (group === "conferences" && !id) {
    const title = clean(input.title);
    const provided = clean(input.input, 12_000);
    const url = safeLink(clean(input.url, 2048) || provided.match(/https?:\/\/[^\s<>"']+/i)?.[0]);
    const link = url ? new URL(url) : undefined;
    const startDate = clean(input.startDate, 10);
    const endDate = clean(input.endDate, 10);
    const query = provided.replace(/https?:\/\/[^\s<>"']+/gi, "").trim();
    const eventTitle = title || query.slice(0, 160) || link?.hostname;
    if (!eventTitle || link?.username || link?.password) throw new DeskError("Enter a public conference link, name, or event details.");
    if (!validDate(startDate) || !validDate(endDate) || (startDate && endDate && endDate < startDate)) throw new DeskError("Enter a valid conference date range.");
    const roster = parseAttendeeList(clean(input.attendees, 2_000_000));
    const event: Conference = { id: crypto.randomUUID(), title: eventTitle,
      location: clean(input.location) || undefined, startDate: startDate || undefined, endDate: endDate || undefined,
      url, contacts: [], sources: [], notes: [],
      needsRoster: !roster.some(person => person.attendance === "attendee"), createdAt: new Date().toISOString() };
    mergeContacts(workspace, event, roster);
    workspace.conferences.push(event);
    queueConferenceDiscovery(state, event);
    await state.save();
    return { conferenceId: event.id, snapshot: snapshot(state) };
  } else if (group === "conferences" && id) {
    const event = conference(workspace, id);
    switch (action) {
      case "roster": {
        const people = parseAttendeeList(clean(input.attendees, 2_000_000));
        if (!people.length) throw new DeskError("No contact names were found. Paste names or a CSV with a name column.");
        const added = mergeContacts(workspace, event, people);
        event.needsRoster = false;
        await state.save();
        return { added, snapshot: snapshot(state) };
      }
      case "details": {
        const title = clean(input.title);
        const startDate = clean(input.startDate, 10);
        const endDate = clean(input.endDate, 10);
        if (!title || !validDate(startDate) || !validDate(endDate) || (startDate && endDate && endDate < startDate)) throw new DeskError("Enter a title and a valid date range.");
        const cutoff = startDate || endDate;
        if (cutoff && workspace.queue.some(item => item.conferenceId === id && active(item) && localDate(new Date(item.scheduledAt)) > cutoff)) {
          throw new DeskError("Cancel the affected scheduled emails before changing the dates.");
        }
        Object.assign(event, { title, location: clean(input.location), startDate, endDate, url: safeLink(clean(input.url, 2048)) });
        break;
      }
      case "contacts": {
        const person = contact(event, detail);
        if (extra) throw new DeskError("Draft polishing is available in the local dashboard.", 404);
        if (person.sentAt || workspace.queue.some(item => item.conferenceId === id && item.contactId === detail && (active(item) || item.status === "failed"))) {
          throw new DeskError("Cancel or resolve the queued send before editing this contact.");
        }
        const email = clean(input.email, 254);
        const subject = clean(input.subject, 300);
        const body = clean(input.body, 12_000);
        if (email && !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(email)) throw new DeskError("Enter a single valid email address.");
        if (Boolean(subject) !== Boolean(body) || /[\x00-\x1f\x7f]/.test(subject)) throw new DeskError("A draft needs a one-line subject and a body.");
        if (email !== (person.email || "")) {
          person.email = email || undefined;
          person.emailStatus = email ? "unverified" : undefined;
          person.emailSource = undefined;
        }
        if (email && input.confirmEmail === true) {
          person.emailStatus = "verified";
          person.emailSource ||= "Confirmed by you";
        }
        if (subject && body) person.draft = { ...person.draft, subject, body, approved: input.approved === true };
        break;
      }
      case "drafts": {
        ensureLive(event);
        const people = rankContacts(event.contacts).filter(person => target(person) && !person.draft && !person.sentAt && !person.previouslyContacted);
        for (const person of people) person.draft = writeDraft(event, person);
        await state.save();
        return { count: people.length, snapshot: snapshot(state) };
      }
      case "gmail-drafts": {
        ensureLive(event);
        const result = await exportDeskGmailDrafts(state, event, clean(input.contactId) || undefined, clean(input.email, 254) || undefined);
        return { ...result, snapshot: snapshot(state) };
      }
      case "schedule":
        return detail === "preview" ? previewBatch(state, input, id) : confirmBatch(state, clean(input.token), id);
      case "research":
        await discovery(state, event, input, detail, extra);
        break;
      case "enrich": {
        ensureLive(event);
        if (detail === "apollo-preview") return apolloAction(state, event, input, true);
        if (detail === "apollo-runs" && path.at(-1) === "check") {
          refreshApollo(state, event, extra);
        } else if (input.provider === "apollo") {
          await apolloAction(state, event, input, false);
          return { ...snapshot(state), enrichmentNotes: ["Apollo waterfall queued for the next ranked contacts."] };
        } else if (input.provider === "autumn") {
          await enrichment(state, event, input);
        } else throw new DeskError("Choose an enrichment provider.");
        break;
      }
      default: throw new DeskError("Endpoint not found.", 404);
    }
  } else throw new DeskError("Endpoint not found.", 404);
  await state.save();
  return snapshot(state);
}
