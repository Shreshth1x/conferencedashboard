import type { Contact, Snapshot } from './model';
import { outreachContactKeys, outreachEmailKey } from './outreach-identity';

type OutreachReference = {
  conferenceId: string;
  contactId: string;
  title: string;
  kind: 'sent' | 'scheduled' | 'held' | 'gmail-draft' | 'prior';
};

const priority: Record<OutreachReference['kind'], number> = { sent: 0, scheduled: 1, held: 2, 'gmail-draft': 3, prior: 4 };

export function outreachReferences(snapshot: Pick<Snapshot, 'conferences' | 'queue' | 'connections'>): Map<string, OutreachReference> {
  const references = new Map<string, OutreachReference>();
  const timestamps = new Map<string, number>();
  const mailbox = outreachEmailKey(snapshot.connections.gmail);
  const contactsByEvent = new Map<string, Map<string, Contact>>();
  const eventTitles = new Map<string, string>();
  function add(keys: string[], reference: OutreachReference, time?: string) {
    const parsed = time ? Date.parse(time) : 0;
    const timestamp = Number.isFinite(parsed) ? parsed : 0;
    for (const key of keys) {
      if (!key) continue;
      const existing = references.get(key);
      if (existing && (priority[existing.kind] < priority[reference.kind] ||
          (priority[existing.kind] === priority[reference.kind] && (timestamps.get(key) || 0) >= timestamp))) continue;
      references.set(key, reference);
      timestamps.set(key, timestamp);
    }
  }

  for (const event of snapshot.conferences) {
    const title = event.shortTitle || event.title;
    eventTitles.set(event.id, title);
    contactsByEvent.set(event.id, new Map(event.contacts.map(person => [person.id, person])));
    for (const person of event.contacts) {
      const keys = outreachContactKeys(person);
      const reference = { conferenceId: event.id, contactId: person.id, title };
      if (person.sentAt || person.repliedAt) add([...keys, outreachEmailKey(person.sentEmail)], { ...reference, kind: 'sent' }, person.sentAt || person.repliedAt);
      else if (person.previouslyContacted) add([...keys, outreachEmailKey(person.priorOutreach?.email)], { ...reference, kind: 'prior' }, person.priorOutreach?.sentAt);
      else if (mailbox && person.draft?.gmailId && outreachEmailKey(person.draft.gmailAccount) === mailbox) {
        add([...keys, outreachEmailKey(person.draft.gmailExportedEmail)], { ...reference, kind: 'gmail-draft' }, person.draft.gmailExportedAt);
      }
    }
  }

  for (const item of snapshot.queue) {
    if (item.status === 'cancelled') continue;
    const title = eventTitles.get(item.conferenceId);
    if (!title) continue;
    const person = contactsByEvent.get(item.conferenceId)?.get(item.contactId);
    const keys = [outreachEmailKey(item.email), ...(person ? outreachContactKeys(person) : [])];
    const kind = item.status === 'sent' ? 'sent' : item.status === 'failed' ? 'held' : 'scheduled';
    add(keys, { conferenceId: item.conferenceId, contactId: item.contactId, title, kind },
      person?.sentAt || item.sendingAt || item.scheduledAt);
  }
  return references;
}
