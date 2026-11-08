import { useMemo, useState } from 'react';
import { ArrowUpRight, CalendarClock, Clock3, Mail, MessageSquare, Search, Send, TriangleAlert, X } from 'lucide-react';
import { Empty, slotTime } from './components';
import { gmailThreadUrl, TIME_ZONE, type Contact, type QueueItem, type Snapshot } from './model';
import './mailbox.css';

type View = 'pending' | 'sent' | 'replies' | 'cancelled';
type EntryStatus = QueueItem['status'] | 'replied';
type Entry = {
  key: string;
  conferenceId: string;
  conference: string;
  contactId: string;
  name: string;
  email?: string;
  account?: string;
  subject?: string;
  date?: string;
  sentAt?: string;
  status: EntryStatus;
  threadId?: string;
  threadAccount?: string;
  replyCount?: number;
  queueItem?: QueueItem;
};

const dayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, weekday: 'long', month: 'short', day: 'numeric', year: 'numeric',
});
const timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});
const displayStatus: Record<EntryStatus, string> = {
  scheduled: 'Scheduled', sending: 'Sending', failed: 'Held for review', sent: 'Sent', replied: 'Replied', cancelled: 'Cancelled',
};
const pageSize = 24;

function sortTime(date?: string) {
  return date ? Date.parse(date) || 0 : 0;
}

function makeEntries(snapshot: Snapshot) {
  const events = new Map(snapshot.conferences.map(event => [event.id, event]));
  const contacts = new Map<string, Contact>();
  const sentQueue = new Map<string, QueueItem>();
  const history = new Map<string, Entry>();
  const replies = new Map<string, Entry>();
  const output: Record<View, Entry[]> = { pending: [], sent: [], replies: [], cancelled: [] };

  for (const event of snapshot.conferences) {
    for (const person of event.contacts) contacts.set(contactKey(event.id, person.id), person);
  }

  for (const item of snapshot.queue) {
    const event = events.get(item.conferenceId);
    const key = contactKey(item.conferenceId, item.contactId);
    const person = contacts.get(key);
    if (item.status === 'sent') {
      const recorded = sentQueue.get(key);
      if (!recorded || sortTime(item.sendingAt) > sortTime(recorded.sendingAt)) sentQueue.set(key, item);
      continue;
    }
    const list = item.status === 'cancelled' ? output.cancelled : output.pending;
    list.push({
      key: item.id, conferenceId: item.conferenceId, conference: event?.shortTitle || event?.title || 'Conference',
      contactId: item.contactId, name: person?.name || item.email, email: item.email, account: item.account,
      subject: item.subject, date: item.scheduledAt, status: item.status, queueItem: item,
      threadId: item.status === 'failed' ? person?.priorOutreach?.gmailThreadId : undefined,
      threadAccount: item.status === 'failed' ? person?.priorOutreach?.account : undefined,
    });
  }

  for (const event of snapshot.conferences) {
    for (const person of event.contacts) {
      const key = contactKey(event.id, person.id);
      const item = sentQueue.get(key);
      if (!person.sentAt && !person.repliedAt && !item) continue;
      const account = item?.account || person.gmailAccount;
      const messageId = item?.gmailMessageId || person.gmailMessageId;
      const messageKey = account && messageId ? JSON.stringify([account.toLowerCase(), messageId]) : key;
      const sentAt = item?.sentAt || person.sentAt || item?.sendingAt;
      const repliedAt = item?.repliedAt || person.repliedAt;
      const entry: Entry = {
        key: messageKey, conferenceId: event.id, conference: event.shortTitle || event.title, contactId: person.id,
        name: person.name, email: item?.email || person.sentEmail || person.email, account, subject: item?.subject || person.sentSubject,
        date: sentAt, sentAt, threadId: item?.gmailThreadId || person.gmailThreadId,
        replyCount: item?.replyCount ?? person.replyCount, status: repliedAt ? 'replied' : 'sent', queueItem: item,
      };
      const existing = history.get(messageKey);
      const preferred = !existing || (item && !existing.queueItem) ? entry : existing;
      if (repliedAt) {
        const reply = replies.get(messageKey);
        if (!reply || sortTime(reply.date) < sortTime(repliedAt)) replies.set(messageKey, { ...preferred, date: repliedAt, status: 'replied' });
      }
      history.set(messageKey, replies.has(messageKey) ? { ...preferred, status: 'replied' } : preferred);
      sentQueue.delete(key);
    }
  }
  output.sent = [...history.values()];
  output.replies = [...replies.values()];
  for (const item of sentQueue.values()) {
    const event = events.get(item.conferenceId);
    const entry: Entry = {
      key: item.id, conferenceId: item.conferenceId, conference: event?.shortTitle || event?.title || 'Conference',
      contactId: item.contactId, name: item.email, email: item.email, account: item.account,
      subject: item.subject, date: item.sentAt || item.sendingAt, sentAt: item.sentAt || item.sendingAt,
      threadId: item.gmailThreadId, replyCount: item.replyCount, status: item.repliedAt ? 'replied' : 'sent', queueItem: item,
    };
    output.sent.push(entry);
    if (item.repliedAt) output.replies.push({ ...entry, date: item.repliedAt });
  }
  output.pending.sort((a, b) => Number(b.status === 'failed') - Number(a.status === 'failed') || sortTime(a.date) - sortTime(b.date));
  for (const view of ['sent', 'replies', 'cancelled'] as const) {
    output[view].sort((a, b) => sortTime(b.date) - sortTime(a.date));
  }
  return output;
}

function contactKey(conferenceId: string, contactId: string) {
  return JSON.stringify([conferenceId, contactId]);
}

function groupEntries(entries: Entry[]) {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const date = sortTime(entry.date);
    const title = entry.status === 'failed' ? 'Needs review' : date ? dayFormatter.format(date) : 'Date unavailable';
    const group = groups.get(title);
    if (group) group.push(entry);
    else groups.set(title, [entry]);
  }
  return groups;
}

function entryTime(date?: string) {
  return date && sortTime(date) ? slotTime(date) : 'Date unavailable';
}

type MailboxProps = {
  snapshot: Snapshot;
  navigate: (route: string) => void;
  onCancel: (id: string, release?: boolean) => void;
  onSync: () => void;
  busy: boolean;
  onSchedule: () => void;
  onOpenContact?: (conferenceId: string, contactId: string) => void;
};

function MailboxRow({ entry, view, mailboxes, busy, onCancel, navigate, onOpenContact }: {
  entry: Entry;
  view: View;
  mailboxes: Set<string>;
} & Pick<MailboxProps, 'busy' | 'onCancel' | 'navigate' | 'onOpenContact'>) {
  const item = entry.queueItem;
  const link = gmailThreadUrl(entry.threadAccount || entry.account, entry.threadId);
  const Icon = entry.status === 'failed' ? TriangleAlert : entry.status === 'replied' ? MessageSquare : entry.status === 'sent' ? Send : Clock3;
  const paused = view === 'pending' && entry.status === 'scheduled' && entry.account && !mailboxes.has(entry.account.toLowerCase());
  const status = paused ? 'Connect sender mailbox' : entry.status === 'replied' && (entry.replyCount ?? 0) > 1 ? `${entry.replyCount} replies` : displayStatus[entry.status];
  return <li className="mailbox-row">
    <div className="mailbox-contact">
      <span className={`mailbox-mark ${entry.status}`}><Icon size={16} aria-hidden="true"/></span>
      <div className="mailbox-person">
        {onOpenContact ? <button className="mailbox-person-link" onClick={() => onOpenContact(entry.conferenceId, entry.contactId)}>{entry.name}</button> : <strong>{entry.name}</strong>}
        <div className="mailbox-address"><span>To</span> {entry.email || 'Address unavailable'}</div>
        {entry.subject && <div className="mailbox-subject">{entry.subject}</div>}
        {item?.error && entry.status === 'failed' && <div className="mailbox-error">{item.error}</div>}
      </div>
    </div>
    <button className="mailbox-event" onClick={() => navigate('event/' + entry.conferenceId)}>{entry.conference}</button>
    <div className="mailbox-address mailbox-sender"><span>From</span> {entry.account || 'Sender unavailable'}</div>
    <div className="mailbox-timing">
      <span className={`mailbox-status ${paused ? 'failed' : entry.status}`}><span className="dot"/>{status}</span>
      <time dateTime={entry.date} title={entryTime(entry.date)}>{view === 'sent' && entry.status === 'replied' ? 'Sent ' : view === 'cancelled' ? 'Slot was ' : ''}
        {entry.status === 'failed' || !sortTime(entry.date) ? entryTime(entry.date) : timeFormatter.format(sortTime(entry.date))}
      </time>
      {view === 'replies' && entry.sentAt && <time className="mailbox-original-time" dateTime={entry.sentAt}>Sent {entryTime(entry.sentAt)}</time>}
    </div>
    <div className="mailbox-row-action">
      {entry.status === 'scheduled' && item && <button className="button secondary" disabled={busy} onClick={() => onCancel(item.id)} aria-label={`Cancel send to ${entry.name}`}>Cancel</button>}
      {entry.status === 'failed' && item && !item.sendingAt && <button className="button secondary" disabled={busy} onClick={() => onCancel(item.id, true)}>Release hold</button>}
      {link && <a className="button secondary" href={link} target="_blank" rel="noreferrer" aria-label={`Open Gmail thread with ${entry.name}`}>Thread <ArrowUpRight size={13}/></a>}
    </div>
  </li>;
}

export function MailboxView({ snapshot, navigate, onCancel, onSync, busy, onSchedule, onOpenContact }: MailboxProps) {
  const [view, setView] = useState<View>('pending');
  const [query, setQuery] = useState('');
  const [eventId, setEventId] = useState('');
  const [sender, setSender] = useState('');
  const [limit, setLimit] = useState(pageSize);
  const entries = useMemo(() => makeEntries(snapshot), [snapshot]);
  const matched = entries[view].filter(entry => {
    if (eventId && entry.conferenceId !== eventId) return false;
    if (sender && entry.account?.toLowerCase() !== sender) return false;
    return [entry.name, entry.email, entry.account, entry.conference, entry.subject].join(' ').toLowerCase().includes(query.trim().toLowerCase());
  });
  const results = groupEntries(matched.slice(0, limit));
  const mailbox = snapshot.connections.gmail;
  const connected = snapshot.connections.mailboxes ?? (mailbox ? [mailbox] : []);
  const mailboxes = new Set(connected.map(email => email.toLowerCase()));
  const senderOptions = [...new Set([...connected, ...Object.values(entries).flatMap(items => items.flatMap(item => item.account ? [item.account] : []))].map(email => email.toLowerCase()))].sort();
  const next = entries.pending.find(entry => entry.status === 'scheduled' && entry.account && mailboxes.has(entry.account.toLowerCase()));
  const views: { key: View; name: string }[] = [{ key: 'pending', name: 'Pending & held' }, { key: 'sent', name: 'Sent' }, { key: 'replies', name: 'Replies' }];
  if (entries.cancelled.length) views.push({ key: 'cancelled', name: 'Cancelled' });
  const eventOptions = [...snapshot.conferences].sort((a, b) => (a.shortTitle || a.title).localeCompare(b.shortTitle || b.title));
  const noResults = Boolean(query.trim() || eventId || sender);

  return <div className="mailbox">
    <header className="view-head mailbox-head">
      <div><h1>Send queue</h1><p>Scheduled emails, sent history, and replies across all your conferences.</p></div>
      <div className="view-actions">
        <button className="button secondary" onClick={mailbox ? onSync : () => navigate('connections')} disabled={busy}><Mail size={16}/> {mailbox ? 'Sync Gmail' : 'Connect Gmail'}</button>
        <button className="button primary" onClick={onSchedule} disabled={busy}><CalendarClock size={16}/> Schedule next batch</button>
      </div>
    </header>
    {mailbox && <div className="mailbox-account"><span><span className="connection-dot connected"/> {connected.length > 1 ? 'Default sender' : 'Sending from'} <strong>{mailbox}</strong></span>
      {next?.date && <span><Clock3 size={14}/> Next send {entryTime(next.date)}{connected.length > 1 && <> from <strong>{next.account}</strong></>}</span>}
    </div>}
    <div className="list-toolbar mailbox-toolbar">
      <div className="segments" aria-label="Outreach status">
        {views.map(({ key, name }) => <button key={key} aria-pressed={view === key} className={view === key ? 'chosen' : ''} onClick={() => { setView(key); setLimit(pageSize); }}>
          {name} <small>{entries[key].length}</small>
        </button>)}
      </div>
      <div className="mailbox-filters">
        <select aria-label="Filter outreach by conference" value={eventId} onChange={event => { setEventId(event.target.value); setLimit(pageSize); }}>
          <option value="">All conferences</option>
          {eventOptions.map(event => <option key={event.id} value={event.id}>{event.shortTitle || event.title}</option>)}
        </select>
        {(senderOptions.length > 1 || sender) && <select aria-label="Filter outreach by sender" value={sender} onChange={event => { setSender(event.target.value); setLimit(pageSize); }}>
          <option value="">All senders</option>
          {senderOptions.map(email => <option key={email} value={email}>{email}</option>)}
        </select>}
        <div className="search"><Search size={16} aria-hidden="true"/><input aria-label="Search outreach" placeholder="Find a person or email" value={query} onChange={event => { setQuery(event.target.value); setLimit(pageSize); }}/>
          {query && <button className="icon-button mailbox-clear" onClick={() => { setQuery(''); setLimit(pageSize); }} aria-label="Clear search"><X size={14}/></button>}
        </div>
      </div>
    </div>
    {results.size > 0 ? <div className="mailbox-timeline">
      {[...results].map(([day, rows]) => <section className="mailbox-day" key={day}>
        <h2>{day}{day === 'Needs review' && <small>{rows.length} shown</small>}</h2>
        <ul>{rows.map(entry => <MailboxRow key={entry.key} entry={entry} view={view} mailboxes={mailboxes} busy={busy} onCancel={onCancel} navigate={navigate} onOpenContact={onOpenContact}/>)}</ul>
      </section>)}
      {matched.length > limit && <div className="mailbox-pagination"><span>Showing {limit} of {matched.length}</span><button className="button secondary" onClick={() => setLimit(limit + pageSize)}>Show more</button></div>}
    </div> : noResults ?
      <Empty icon="mail" title="No matching outreach" detail="Try another search or conference filter."/> :
      <Empty icon="mail" title={view === 'pending' ? 'Nothing scheduled yet' : view === 'sent' ? 'No send history yet' : view === 'replies' ? 'No replies yet' : 'No cancelled sends'}
        detail={view === 'pending' ? 'Schedule a batch to see the order, send times, and recipients here.' : view === 'sent' ? 'Sent outreach will appear here with the conference and recipient.' : view === 'replies' ? 'Replies from tracked Gmail threads appear here after a sync.' : 'Cancelled sends will appear here.'}/>}
  </div>;
}
