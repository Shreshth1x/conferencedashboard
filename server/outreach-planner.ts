import { localDate, type Conference, type Contact, type QueueItem } from '../src/model.ts';
import { generateScheduleSlots, SCHEDULE_GAP_MS } from './schedule.ts';
import { canReachContact, isOutreachOpen, outreachContactKeys, outreachEmailKey, outreachEventCutoff as cutoff } from '../src/outreach-identity.ts';

export { canReachContact, isOutreachOpen, outreachContactKeys, outreachEmailKey } from '../src/outreach-identity.ts';

type ReachableContact = Contact & { email: string };
type DraftOwner = { conferenceId: string; contactId: string };
type PlannedCandidate = { event: Conference; contact: ReachableContact; identity: string };
type OutreachPlanInput = {
  conferences: readonly Conference[];
  queue: readonly QueueItem[];
  selectedConferenceIds?: readonly string[];
  account: string;
  count: number;
  now?: Date;
  sendNow?: boolean;
};

// Join records only through an exact address or a personal LinkedIn URL. This
// also joins variants when one roster supplies both and another supplies one.
function buildIdentities(conferences: readonly Conference[]) {
  const parent = new Map<string, string>();
  function find(key: string): string {
    let root = key;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    let link = key;
    while (link !== root) {
      const next = parent.get(link)!;
      parent.set(link, root);
      link = next;
    }
    return root;
  }
  const contacts = new Map<string, Map<string, Contact>>();
  for (const event of conferences) {
    contacts.set(event.id, new Map(event.contacts.map(person => [person.id, person])));
    for (const person of event.contacts) {
      const [first, second] = outreachContactKeys(person);
      if (!first) continue;
      if (!parent.has(first)) parent.set(first, first);
      if (second) parent.set(find(second), find(first));
    }
  }
  return { find, keys: parent.keys(), contacts };
}

export function outreachReservations(conferences: readonly Conference[], queue: readonly QueueItem[], ignoreQueueId?: string): Set<string> {
  const identities = buildIdentities(conferences);
  const blocked = new Set<string>();
  const block = (keys: string[]) => { for (const key of keys) if (key) blocked.add(identities.find(key)); };
  for (const event of conferences) {
    for (const person of event.contacts) {
      if (person.sentAt || person.repliedAt || person.previouslyContacted) block([...outreachContactKeys(person), outreachEmailKey(person.sentEmail), outreachEmailKey(person.priorOutreach?.email)]);
    }
  }
  for (const item of queue) {
    if (item.id === ignoreQueueId || item.status === 'cancelled') continue;
    const person = identities.contacts.get(item.conferenceId)?.get(item.contactId);
    block([outreachEmailKey(item.email), ...(person ? outreachContactKeys(person) : [])]);
  }
  // Also expose each alias, so callers can check a single roster record's keys.
  return new Set([...blocked, ...Array.from(identities.keys).filter(key => blocked.has(identities.find(key)))]);
}

function compareConference(a: Conference, b: Conference) {
  return (cutoff(a) || '9999').localeCompare(cutoff(b) || '9999');
}

function fitOrder(contact: Contact) {
  return contact.bucket === 'direct' ? 0 : contact.bucket === 'connector' ? 1 : 2;
}

function compareCandidate(a: { event: Conference; contact: Contact }, b: { event: Conference; contact: Contact }) {
  return fitOrder(a.contact) - fitOrder(b.contact) || b.contact.score - a.contact.score ||
    compareConference(a.event, b.event) || a.contact.name.localeCompare(b.contact.name) ||
    a.event.id.localeCompare(b.event.id) || a.contact.id.localeCompare(b.contact.id);
}

export function outreachDraftOwners(conferences: readonly Conference[], account: string): Map<string, DraftOwner> {
  if (!account) return new Map();
  const identities = buildIdentities(conferences);
  const drafts = conferences.flatMap(event => event.contacts
    .filter(person => person.draft?.gmailId && outreachEmailKey(person.draft.gmailAccount) === outreachEmailKey(account))
    .map(contact => ({ event, contact }))).sort(compareCandidate);
  const primary = new Map<string, DraftOwner>();
  for (const { event, contact } of drafts) {
    const keys = [outreachEmailKey(contact.draft?.gmailExportedEmail), ...outreachContactKeys(contact)].filter(Boolean);
    for (const key of keys) {
      const identity = identities.find(key);
      if (!primary.has(identity)) primary.set(identity, { conferenceId: event.id, contactId: contact.id });
    }
  }
  const owners = new Map(primary);
  for (const key of identities.keys) {
    const owner = primary.get(identities.find(key));
    if (owner) owners.set(key, owner);
  }
  return owners;
}

function isActive(item: QueueItem) { return item.status === 'scheduled' || item.status === 'sending'; }

export function planOutreach({ conferences, queue, selectedConferenceIds, account, count, now = new Date(), sendNow = false }: OutreachPlanInput) {
  const selected = selectedConferenceIds && new Set(selectedConferenceIds);
  const identities = buildIdentities(conferences);
  const reservations = outreachReservations(conferences, queue);
  const owners = outreachDraftOwners(conferences, account);
  const sameMailbox = queue.filter(item => outreachEmailKey(item.account) === outreachEmailKey(account));
  const active = sameMailbox.filter(isActive).sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
  const occupied = [...active.map(item => item.scheduledAt), ...sameMailbox.flatMap(item => item.sendingAt ? [item.sendingAt] : [])];
  const eligibleEvents = conferences.filter(event => (!selected || selected.has(event.id)) && isOutreachOpen(event, now));
  const ranked = eligibleEvents.flatMap(event => event.contacts.filter(canReachContact)
    .map(contact => ({ event, contact, identity: identities.find(outreachEmailKey(contact.email)) }))).sort(compareCandidate);
  const available = ranked.filter(({ event, contact }) => outreachContactKeys(contact).every(key => {
    const owner = owners.get(key);
    return !reservations.has(key) && (!owner || (owner.conferenceId === event.id && owner.contactId === contact.id));
  }));
  const readyCount = new Set(available.map(candidate => candidate.identity)).size;
  const duplicateCount = ranked.length - readyCount;
  if (!readyCount || !count) return { rows: [], readyCount, duplicateCount };

  const latestDate = eligibleEvents.every(cutoff) ? eligibleEvents.map(cutoff).sort().at(-1) : undefined;
  const nowBlocked = occupied.some(time => Math.abs(Date.parse(time) - +now) < SCHEDULE_GAP_MS);
  const slots = sendNow ? nowBlocked ? [] : [now.toISOString()] :
    generateScheduleSlots({ count: Math.min(count, readyCount), occupied, now, latestDate });
  const eventOrder = [...eligibleEvents].sort((a, b) => compareConference(a, b) || a.id.localeCompare(b.id));
  const eventPosition = new Map(eventOrder.map((event, i) => [event.id, i]));
  const rows: Array<PlannedCandidate & { scheduledAt: string }> = [];
  const claimed = new Set<string>();
  let prior: { eventId: string; tier: number; time: number } | undefined;
  let existingIndex = 0;

  for (const scheduledAt of slots) {
    const time = Date.parse(scheduledAt);
    while (existingIndex < active.length && Date.parse(active[existingIndex].scheduledAt) < time) {
      const existing = active[existingIndex++];
      const contact = identities.contacts.get(existing.conferenceId)?.get(existing.contactId);
      const at = Date.parse(existing.scheduledAt);
      if (contact && (!prior || prior.time < at)) prior = { eventId: existing.conferenceId, tier: fitOrder(contact), time: at };
    }

    // Use the strongest version still reachable at this slot. If an earlier
    // conference has closed, a later event can represent that same person.
    const unique = new Map<string, PlannedCandidate>();
    const day = localDate(new Date(time));
    for (const candidate of available) {
      const deadline = cutoff(candidate.event);
      if (claimed.has(candidate.identity) || unique.has(candidate.identity) || (deadline && day > deadline)) continue;
      unique.set(candidate.identity, candidate);
    }
    const first = unique.values().next().value;
    if (!first) break;
    const tier = fitOrder(first.contact);
    const eventLeads = new Map<string, PlannedCandidate>();
    for (const candidate of unique.values()) {
      if (fitOrder(candidate.contact) === tier && !eventLeads.has(candidate.event.id)) eventLeads.set(candidate.event.id, candidate);
    }

    const candidates = [...eventLeads.values()].sort((a, b) =>
      compareConference(a.event, b.event) || compareCandidate(a, b));
    const priorPosition = prior?.tier === tier ? eventPosition.get(prior.eventId) : undefined;
    const next = priorPosition === undefined ? candidates[0] :
      candidates.find(candidate => eventPosition.get(candidate.event.id)! > priorPosition) ||
      candidates.find(candidate => candidate.event.id !== prior?.eventId) || candidates[0];
    rows.push({ ...next, scheduledAt });
    claimed.add(next.identity);
    prior = { eventId: next.event.id, tier, time };
  }

  return { rows: rows.map(({ event, contact, scheduledAt }) => ({ event, contact, scheduledAt })), readyCount, duplicateCount };
}
