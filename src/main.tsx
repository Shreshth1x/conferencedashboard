import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowDown, ArrowUpRight, CalendarDays, CalendarClock, Check, CircleHelp,
  Clock3, Globe2, Inbox, LayoutGrid, Link2, LoaderCircle, Mail, Maximize2, Menu, MessageSquare,
  Minimize2, PanelLeftClose, PanelLeftOpen, Plus, ScanSearch, Search, Send, Sparkles, Target, Users, X,
} from 'lucide-react';
import '@fontsource-variable/dm-sans';
import './styles.css';
import {
  type ApolloPreview, type BatchPreview, type Bucket, type Conference, type Contact, type Provider, type Snapshot,
  BUCKETS, TIME_ZONE, campaignCounts, gmailDraftsUrl, isGmailSchedulePending, isPast, rankContacts, scheduledCount, target,
} from './model';
import { api, deskSessionEvent, getDeskSession, hostedDesk, setDeskSession } from './api';
import { gmailConnectRoute, startGmailConnection, startOwnerSignIn } from './gmail-connect';
import { ActionBanner, Breadcrumb, BucketBadge, ConferenceCard, dateRange, DeskArt, DialogError, Empty, eventColor, External, Mark, Modal, timeUntil } from './components';
import { ContactForm, EventForm, RosterForm, ScheduleForm, type EventInput } from './forms';
import { ConnectionsView, IcpView } from './settings';
import { ApolloReviewModal, ApolloWaterfallResults } from './apollo-waterfall';
import { MailboxView } from './mailbox';
import { canReachContact, isOutreachOpen, outreachContactKeys, outreachEmailKey } from './outreach-identity';
import { outreachReferences } from './outreach-summary';

type Filter = 'upcoming' | 'all' | 'past';
type Dialog = { kind: 'add' } | { kind: 'edit' | 'roster'; eventId: string }
  | { kind: 'schedule'; eventId?: string } | { kind: 'contact'; eventId: string; personId: string }
  | { kind: 'apollo'; eventId: string; preview: ApolloPreview } | { kind: 'autumn-discovery'; eventId: string }
  | { kind: 'autumn-reply'; eventId: string; jobId: string };
type Notice = { message: string; kind: 'success' | 'error' };
type Navigate = (view: string) => void;

const currentRoute = () => window.location.hash.slice(1) || 'conferences';
const initialNotice = (): Notice | undefined => {
  const gmail = new URLSearchParams(window.location.search).get('gmail');
  if (!gmail) return undefined;
  return gmail === 'connected' ? { message: 'Gmail connected.', kind: 'success' } : { message: gmail, kind: 'error' };
};
const getDate = () => new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());

function initialSidebarCollapsed() {
  try { return localStorage.getItem('conference-desk.sidebar-collapsed') === 'true'; }
  catch { return false; }
}

function Sidebar({ snapshot, route, navigate, mobileOpen, collapsed, close }: { snapshot: Snapshot; route: string; navigate: Navigate; mobileOpen: boolean; collapsed: boolean; close: () => void }) {
  const nav = [
    { name: 'Conferences', key: 'conferences', icon: LayoutGrid },
    { name: 'Send queue', key: 'queue', icon: CalendarClock },
    { name: 'Your ICP', key: 'icp', icon: Target },
    { name: 'Connections', key: 'connections', icon: Link2 },
  ];
  const upcoming = [...snapshot.conferences].filter(e => !isPast(e)).sort((a, b) => (a.startDate || '9999').localeCompare(b.startDate || '9999')).slice(0, 5);
  const activeCount = scheduledCount(snapshot.conferences, snapshot.queue);
  return <>
    {mobileOpen && <button className="sidebar-overlay" aria-label="Close navigation" onClick={close}/>}
    <aside id="workspace-sidebar" className={`sidebar ${mobileOpen ? 'shown' : ''}`} aria-label="Sidebar">
      <button className="brand" aria-label="Conference Desk home" title={collapsed ? 'Conference Desk' : undefined} onClick={() => navigate('conferences')}><span className="brand-mark"><Mark size={23}/></span><span className="brand-text"><strong>Conference Desk</strong><small>Oasis Simulations</small></span></button>
      <nav aria-label="Workspace" className="nav-list">
        {nav.map(({ name, key, icon: Icon }) => {
          const active = route === key || (key === 'conferences' && route.startsWith('event/'));
          return <button key={key} className={`nav-link ${active ? 'active' : ''}`} aria-label={name} title={collapsed ? name : undefined} aria-current={active ? 'page' : undefined} onClick={() => navigate(key)}><Icon size={17}/><span className="nav-text">{name}</span>{key === 'queue' && activeCount > 0 && <span className="nav-count">{activeCount}</span>}</button>;
        })}
      </nav>
      {upcoming.length > 0 && <div className="sidebar-events"><div className="sidebar-label">Coming up</div>
        {upcoming.map(event => <button className={`side-event ${route === 'event/' + event.id ? 'selected' : ''}`} key={event.id} onClick={() => navigate('event/' + event.id)}>
          <span className={`event-dot ${eventColor(event.id)}`}/><span>{event.shortTitle || event.title}</span>
        </button>)}
      </div>}
      <div className="sidebar-foot"><span className="avatar" title="Shreshth Saride">SS</span><span className="sidebar-profile"><strong>Shreshth Saride</strong><small>Local workspace</small></span><button className="icon-button" aria-label="Workspace connections" title="Workspace connections" onClick={() => navigate('connections')}><CircleHelp size={16}/></button></div>
    </aside>
  </>;
}

function Dashboard({ snapshot, readyEvents, onAdd, navigate, onSchedule, onSync, busy }: {
  snapshot: Snapshot; readyEvents: Conference[]; onAdd: () => void; navigate: Navigate; onSchedule: () => void; onSync: () => void; busy: boolean;
}) {
  const [filter, setFilter] = useState<Filter>('upcoming');
  const [query, setQuery] = useState('');
  const { conferences, queue } = snapshot;
  const upcoming = conferences.filter(event => !isPast(event));
  const stats = upcoming.map(event => campaignCounts(event, queue));
  const sum = (key: 'sent' | 'replies') => stats.reduce((n, stat) => n + stat[key], 0);
  const sent = sum('sent');
  const replies = sum('replies');
  const visible = conferences.filter(event => {
    return (filter === 'all' || (filter === 'past' ? isPast(event) : !isPast(event))) &&
      `${event.title} ${event.location || ''}`.toLowerCase().includes(query.toLowerCase().trim());
  }).sort((a, b) => filter === 'past' ? (b.startDate || '').localeCompare(a.startDate || '') : (a.startDate || '9999').localeCompare(b.startDate || '9999'));
  const activeCount = scheduledCount(conferences, queue);
  const metricTiles = [
    { label: 'Upcoming', value: upcoming.length, note: 'Conferences on your radar', icon: CalendarDays, color: 'peach' },
    { label: 'Sent', value: sent, note: 'Across upcoming conferences', icon: Send, color: 'yellow' },
    { label: 'Replies', value: replies, note: sent ? `${Math.round(100 * replies / sent)}% reply rate` : 'Across upcoming conferences', icon: MessageSquare, color: 'rose' },
    { label: 'Ready to email', value: snapshot.outreachReady, note: activeCount ? `${activeCount} already scheduled` : 'Unique contacts with sourced email', icon: Inbox, color: 'blue' },
  ];
  return <>
    <header className="hero">
      <div><div className="hero-date">{getDate()}</div><h1>Conference outreach</h1><p>Find the right people. Get the next few emails out.</p></div>
      <DeskArt/>
      <button className="button primary add-hero" onClick={onAdd}><Plus size={18}/> Add conference</button>
    </header>
    <section className="metrics-grid" aria-label="Outreach at a glance">
      {metricTiles.map(({ label, value, note, icon: Icon, color }) => <div className={`metric ${color}`} key={label}>
        <div className="metric-label"><Icon size={16}/><span>{label}</span></div><div className="metric-value">{value}</div><div className="metric-note">{note}</div>
      </div>)}
    </section>
    {snapshot.outreachReady > 0 && readyEvents.length > 0 && <ActionBanner title="Ready for the next batch"
      detail={readyEvents.length > 1 ? `One inbox across ${readyEvents.length} conferences` : readyEvents[0].shortTitle || readyEvents[0].title}
      action="Schedule next batch" onAction={onSchedule}/>}
    <section className="dashboard-list">
      <div className="section-title"><div><h2>Your conferences</h2><p>Dates and outreach progress in one place.</p></div>
        {snapshot.connections.gmail && <button className="button secondary" disabled={busy} onClick={onSync}><Mail size={16}/> Sync Gmail</button>}
      </div>
      <div className="list-toolbar">
        <div className="segments" aria-label="Filter conferences">{(['upcoming', 'all', 'past'] as const).map(tab => <button key={tab} aria-pressed={filter === tab} className={filter === tab ? 'chosen' : ''} onClick={() => setFilter(tab)}>{tab === 'all' ? 'All conferences' : tab === 'upcoming' ? 'Upcoming' : 'Past'}</button>)}</div>
        <label className="search"><Search size={16}/><input aria-label="Search conferences" placeholder="Search conferences" value={query} onChange={e => setQuery(e.target.value)}/></label>
      </div>
      {visible.length ? <div className="conference-grid">{visible.map(event => <ConferenceCard key={event.id} event={event} queue={queue} onOpen={() => navigate('event/' + event.id)}/>)}</div> :
        <Empty title={query ? 'No matches' : filter === 'past' ? 'No past conferences' : 'Add your first conference'} detail={query ? 'Try a different conference name or location.' : filter === 'past' ? 'Completed conferences and their outreach history will appear here.' : 'Drop in an event link or a name to start finding the people you want to meet.'} action={!query && filter !== 'past' ? 'Add conference' : undefined} onAction={onAdd}/>}
    </section>
  </>;
}

function attendeeStatus(person: Contact, scheduled: string | undefined) {
  if (person.repliedAt) return { label: 'Replied', color: 'green' };
  if (person.sentAt) return { label: 'Sent', color: 'blue' };
  if (scheduled) return { label: scheduled, color: scheduled === 'Held' || scheduled === 'Check in Gmail' ? 'yellow' : 'blue' };
  if (person.previouslyContacted) return { label: 'Prior outreach', color: 'gray' };
  if (!target(person)) return { label: 'Outside queue', color: 'gray' };
  if (!person.email) return { label: 'Needs email', color: 'gray' };
  if (!person.emailStatus || person.emailStatus === 'unverified') return { label: 'Check email', color: 'yellow' };
  if (person.draft?.gmailId) return { label: 'In Gmail drafts', color: 'green' };
  if (person.draft) return { label: 'Draft ready', color: 'green' };
  return { label: 'Ready to draft', color: 'gray' };
}
function providerReady(snapshot: Snapshot | undefined, provider: Provider) {
  return Boolean(snapshot?.connections[provider] || snapshot?.connections.mcp?.[provider]?.status === 'connected');
}

function AutumnReplyForm({ message, busy, close, onSubmit }: {
  message?: string; busy: boolean; close: () => void; onSubmit: (answer: string) => void;
}) {
  const [answer, setAnswer] = useState('');
  return <Modal title="Autumn needs more information" description={message} onClose={close}>
    <form onSubmit={event => { event.preventDefault(); if (answer.trim()) onSubmit(answer.trim()); }}>
      <label className="field">Your answer<textarea rows={4} maxLength={4000} value={answer} onChange={event => setAnswer(event.target.value)} /></label>
      <div className="form-actions">
        <button type="button" className="button secondary" onClick={close}>Cancel</button>
        <button className="button primary" disabled={busy || !answer.trim()}>{busy ? 'Sending…' : 'Send to Autumn'}</button>
      </div>
    </form>
  </Modal>;
}

function AutumnDiscoveryForm({ event, busy, close, onSubmit }: {
  event: Conference; busy: boolean; close: () => void; onSubmit: (notes: string) => void;
}) {
  const [notes, setNotes] = useState('');
  return <Modal title="Expand attendee research" description={`Autumn will look for people publicly associated with ${event.title} and save sources for each lead.`}
    onClose={() => { if (!busy) close(); }}>
    <form onSubmit={event => { event.preventDefault(); onSubmit(notes.trim()); }}>
      <label className="field">What should Autumn look for? <span className="field-note">Optional</span>
        <textarea rows={4} maxLength={500} value={notes} onChange={event => setNotes(event.target.value)}
          placeholder="Prioritize data-center commissioning leaders and people who own technician hiring or training. Find a public source connecting each person to this edition."/>
      </label>
      <p className="field-note">You can leave this blank for a broad search. Any leads found will be ranked against your ICP.</p>
      <div className="form-actions">
        <button type="button" className="button secondary" onClick={close} disabled={busy}>Cancel</button>
        <button className="button primary" disabled={busy}>{busy ? 'Starting…' : 'Start research'}</button>
      </div>
    </form>
  </Modal>;
}

type EventAction = 'drafts' | 'gmail-drafts' | 'public' | 'autumn-discovery' | 'apollo' | 'autumn';
function EventView({ event, snapshot, references, navigate, open, onSchedule, onAction, onRefreshApollo, busy }: {
  event: Conference; snapshot: Snapshot; references: ReturnType<typeof outreachReferences>; navigate: Navigate; open: (dialog: Dialog) => void;
  onSchedule: (event: Conference) => void; onAction: (event: Conference, action: EventAction) => void; onRefreshApollo: (runId: string) => void; busy: boolean;
}) {
  const [bucket, setBucket] = useState<'all' | Bucket>('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState<'attendees' | 'research'>('attendees');
  const stats = campaignCounts(event, snapshot.queue);
  const past = isPast(event);
  const contacts = rankContacts(event.contacts);
  const scoped = contacts.filter(person => (bucket === 'all' || person.bucket === bucket) &&
    [person.name, person.company, person.title, person.email].filter(Boolean).join(' ').toLowerCase().includes(query.toLowerCase().trim()));
  const statuses = new Map(snapshot.queue.filter(item => item.conferenceId === event.id && ['scheduled', 'sending', 'failed'].includes(item.status))
    .map(item => [item.contactId, item.status === 'failed' ? 'Held' : item.status === 'sending' ? 'Sending' : 'Scheduled']));
  for (const item of event.gmailScheduled ?? []) {
    const contactId = item.contactId || event.contacts.find(person => outreachEmailKey(person.email) === outreachEmailKey(item.email))?.id;
    if (contactId) statuses.set(contactId, isGmailSchedulePending(item) ? 'Scheduled in Gmail' : 'Check in Gmail');
  }
  const pageSize = 30;
  const shown = scoped.slice((page - 1) * pageSize, page * pageSize);
  const jobs = snapshot.jobs.filter(job => job.conferenceId === event.id);
  const discovery = jobs.find(job => job.kind === 'discovery' && (job.status === 'running' || job.status === 'needs_input'));
  const automaticDiscovery = discovery?.automatic ? discovery : undefined;
  return <>
    <Breadcrumb label={event.shortTitle || event.title} back={() => navigate('conferences')}/>
    <header className="view-head event-head"><div className="title-block">
      <div className="event-kicker"><span className={`event-mark ${eventColor(event.id)}`}><CalendarDays size={20}/></span><span className="date-chip"><span className="dot"/>{timeUntil(event)}</span></div>
      <h1>{event.title}</h1><p>{dateRange(event)}{event.location ? ' · ' + event.location : ''} <External url={event.url}>Event website</External></p>
    </div><div className="view-actions">
      <button className="button secondary" onClick={() => open({ kind: 'edit', eventId: event.id })}>Edit details</button>
      {isOutreachOpen(event, new Date()) && <button className="button primary" onClick={() => onSchedule(event)}><CalendarClock size={17}/> Schedule</button>}
    </div></header>
    <div className="event-overview">
      <div className="overview-stat"><Users size={16}/><span>On roster</span><strong>{stats.total}</strong></div>
      <div className="overview-stat"><Send size={16}/><span>Sent</span><strong>{stats.sent}</strong></div>
      <div className="overview-stat"><MessageSquare size={16}/><span>Replies</span><strong>{stats.replies}</strong><small>{stats.replyRate}% of sent</small></div>
      <div className="overview-stat"><Clock3 size={16}/><span>Left to schedule</span><strong>{stats.left}</strong>{stats.scheduled > 0 && <small>{stats.scheduled} scheduled</small>}</div>
      <div className="overview-progress"><div><span>Outreach progress</span><strong>{stats.progress}%</strong></div><div className="progress"><span style={{ width: `${stats.progress}%` }}/></div></div>
    </div>
    {automaticDiscovery ? <ActionBanner
      title={automaticDiscovery.status === 'needs_input' ? 'Attendee research needs your input' : 'Finding and ranking attendees'}
      detail={automaticDiscovery.message || 'Research runs in the background. The roster updates as results come in.'}
      action={automaticDiscovery.status === 'needs_input' ? 'Answer Autumn' : 'View research'}
      onAction={() => automaticDiscovery.status === 'needs_input' ? open({ kind: 'autumn-reply', eventId: event.id, jobId: automaticDiscovery.id }) : setTab('research')}/>
      : event.needsRoster && !past && <ActionBanner title="The public roster may be incomplete" detail="Add the organizer’s roster or attendee export for fuller coverage." action="Import attendees" onAction={() => open({ kind: 'roster', eventId: event.id })}/>}
    <div className="event-tabs" aria-label="Conference sections">
      <button aria-pressed={tab === 'attendees'} onClick={() => setTab('attendees')}><Users size={17}/> Attendees <span>{contacts.length}</span></button>
      <button aria-pressed={tab === 'research'} onClick={() => setTab('research')}><Globe2 size={17}/> Research & sources {jobs.some(job => job.status === 'running') && <LoaderCircle className="spin" size={14}/>}</button>
    </div>
    {tab === 'attendees' ? <section>
      <div className="section-title event-list-title"><div><h2>People to meet</h2><p>Ranked by your {snapshot.icp.name} ICP.</p></div>
        <div className="view-actions">
          <button className="button secondary" onClick={() => open({ kind: 'roster', eventId: event.id })}><Plus size={16}/> Import</button>
          {!past && <button className="button secondary" disabled={busy || !contacts.some(person => target(person) && !person.draft && !person.sentAt && !person.previouslyContacted)} onClick={() => onAction(event, 'drafts')}><Sparkles size={16}/> Write drafts</button>}
          {!past && <button className="button primary" disabled={busy || !contacts.some(person => target(person) && person.email && !person.sentAt && !person.previouslyContacted)} onClick={() => onAction(event, 'gmail-drafts')}><Mail size={16}/> Populate Gmail drafts</button>}
        </div>
      </div>
      <div className="list-toolbar">
        <div className="segments attendee-filters" aria-label="Filter by fit">{(['all', 'direct', 'connector', 'irrelevant'] as const).map(key => <button key={key} aria-pressed={bucket === key} className={bucket === key ? 'chosen' : ''} onClick={() => { setBucket(key); setPage(1); }}>
          {key !== 'all' && <span className={`filter-dot ${key}`}/>} {key === 'all' ? 'All' : BUCKETS[key]} <small>{key === 'all' ? contacts.length : contacts.filter(person => person.bucket === key).length}</small>
        </button>)}</div>
        <label className="search"><Search size={16}/><input aria-label="Search attendees" placeholder="Search attendees" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }}/></label>
      </div>
      {shown.length ? <div className="table-shell"><table className="attendee-table"><thead><tr><th>Person</th><th>Fit <ArrowDown size={13}/></th><th>Attendance</th><th>Outreach</th><th><span className="sr-only">Open contact</span></th></tr></thead>
        <tbody>{shown.map(person => {
          const status = attendeeStatus(person, statuses.get(person.id));
          const related = person.sentAt || person.repliedAt || statuses.has(person.id) ? undefined :
            outreachContactKeys(person).map(key => references.get(key)).find(ref => ref && (ref.conferenceId !== event.id || ref.contactId !== person.id));
          const relatedLabel = related && ({ sent: 'Sent for', scheduled: 'Queued for', 'gmail-scheduled': 'Gmail schedule for', held: 'Held for', 'gmail-draft': 'Drafted for', prior: 'Prior outreach found in' }[related.kind]);
          const attendance = { attendee: 'Attendee', speaker: 'Speaker', organizer: 'Organizer', unconfirmed: 'Unconfirmed' }[person.attendance];
          return <tr key={person.id}><td><button className="person-button" onClick={() => open({ kind: 'contact', eventId: event.id, personId: person.id })}><span className={`person-avatar ${eventColor(person.id)}`}>{person.name.split(/\s+/).slice(0, 2).map(part => part[0]).join('')}</span><span><strong>{person.name}</strong><small>{[person.title, person.company].filter(Boolean).join(' · ') || 'Role to research'}</small></span></button></td>
            <td><div className="fit-cell"><BucketBadge bucket={person.bucket}/><small>{person.score}</small></div></td>
            <td><span className="attendance">{attendance}</span></td><td>{related ? <button className="outreach-status gray related-outreach" title={`${relatedLabel} ${related.title}`}
              onClick={() => related.contactId ? open({ kind: 'contact', eventId: related.conferenceId, personId: related.contactId }) : navigate('event/' + related.conferenceId)}><span className="dot"/>{relatedLabel} {related.title}</button> :
              <span className={`outreach-status ${status.color}`}><span className="dot"/>{status.label}</span>}</td>
            <td><button className="icon-button" aria-label={`Open ${person.name}`} onClick={() => open({ kind: 'contact', eventId: event.id, personId: person.id })}><ArrowUpRight size={16}/></button></td></tr>;
        })}</tbody></table>
        {scoped.length > pageSize && <div className="pagination"><span>{(page - 1) * pageSize + 1}–{Math.min(page * pageSize, scoped.length)} of {scoped.length}</span><button className="button secondary" onClick={() => setPage(n => n - 1)} disabled={page === 1}>Previous</button><button className="button secondary" onClick={() => setPage(n => n + 1)} disabled={page * pageSize >= scoped.length}>Next</button></div>}
      </div> : <Empty title={contacts.length ? 'No matching attendees' : 'No attendees yet'} detail={contacts.length ? 'Try another search or change the fit filter.' : 'Add names from the organizer roster, or look for public attendees and speakers.'} action={!contacts.length ? 'Import attendees' : undefined} onAction={() => open({ kind: 'roster', eventId: event.id })}/>}
    </section> : <section className="research-grid">
      <div className="panel">
        <h2>Research & enrichment</h2><p>Find public speakers and attendees, then enrich direct fits and likely introducers.</p>
        <div className="research-actions">
          <button className="button secondary" disabled={busy} onClick={() => onAction(event, 'public')}><ScanSearch size={17}/> Search event pages</button>
          <button className="button secondary" disabled={busy || Boolean(discovery)} onClick={() => onAction(event, 'autumn-discovery')}><Globe2 size={17}/> Expand with Autumn</button>
          {!past && <><button className="button secondary" disabled={busy || !contacts.length || (hostedDesk && Boolean(discovery))} onClick={() => onAction(event, 'apollo')}><Users size={17}/> {hostedDesk ? 'Find work emails with Apollo' : 'Review Apollo enrichment'}</button>
          <button className="button secondary" disabled={busy || !contacts.length || jobs.some(job => job.kind === 'enrichment' && (job.status === 'running' || job.status === 'needs_input'))} onClick={() => onAction(event, 'autumn')}><Sparkles size={17}/> Enrich next 10 with Autumn</button></>}
        </div>
        {jobs.length > 0 && <div className="job-list">{jobs.slice().reverse().map(job => <div key={job.id}>
          {job.status === 'running' ? <LoaderCircle className="spin" size={14}/> : job.status === 'failed' ? <X size={16}/> : job.status === 'needs_input' ? <CircleHelp size={16}/> : <Check size={16}/>}
          <span><strong>{job.automatic ? 'Automatic attendee research' : job.kind === 'discovery' ? 'Autumn roster research' : 'Autumn contact enrichment'}</strong>
            <small>{job.message || (job.status === 'running' ? 'Running in the background' : job.status)}</small>
            {job.status === 'needs_input' && <button className="button secondary" onClick={() => open({ kind: 'autumn-reply', eventId: event.id, jobId: job.id })}>Answer Autumn</button>}
          </span>
        </div>)}</div>}
        <ApolloWaterfallResults runs={(snapshot.apolloRuns ?? []).filter(run => run.conferenceId === event.id)} onRefresh={onRefreshApollo} busy={busy}/>
      </div>
      <div className="panel"><h2>Sources & coverage</h2><ul className="source-list">{event.sources.map(source => <li key={source.url}><External url={source.url}>{source.label}</External></li>)}{event.notes.map((note, i) => <li key={i}>{note}</li>)}{!event.notes.length && !event.sources.length && <li>Research sources will appear here.</li>}</ul></div>
    </section>}
  </>;
}

function App() {
  const [snapshot, writeSnapshot] = useState<Snapshot>();
  const snapshotRevision = useRef(0);
  const setSnapshot = useCallback((next?: Snapshot) => {
    snapshotRevision.current++;
    writeSnapshot(next);
  }, []);
  const [sessionCode] = useState(() => hostedDesk ? new URLSearchParams(window.location.search).get('desk_code') : null);
  const [sessionReady, setSessionReady] = useState(() => !hostedDesk || Boolean(getDeskSession()));
  const [sessionBusy, setSessionBusy] = useState(Boolean(sessionCode));
  const [sessionError, setSessionError] = useState(() => hostedDesk ? new URLSearchParams(window.location.search).get('desk_error') ?? '' : '');
  const codeExchange = useRef<Promise<void> | null>(null);
  const [loadingError, setLoadingError] = useState('');
  const [route, setRoute] = useState(currentRoute);
  const [dialog, setDialog] = useState<Dialog>();
  const [preview, setPreview] = useState<BatchPreview>();
  const [notice, setNotice] = useState<Notice | undefined>(initialNotice);
  const [busy, setBusy] = useState(false);
  const [gmailConnecting, setGmailConnecting] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed);
  const [compactViewport, setCompactViewport] = useState(() => window.matchMedia('(max-width: 700px)').matches);
  const [fullscreen, setFullscreen] = useState(() => Boolean(document.fullscreenElement));
  const [polishVersion, setPolishVersion] = useState(0);
  const notify = useCallback((message: string, kind: Notice['kind'] = 'success') => setNotice({ message, kind }), []);
  const gmailConfigured = snapshot?.connections.gmailConfigured;
  const gmailRedirectUri = snapshot?.connections.gmailRedirectUri;
  const connectGmail = useCallback(async () => {
    setNotice(undefined);
    if (!gmailConfigured) {
      window.location.hash = 'connections';
      return;
    }
    setGmailConnecting(true);
    try {
      await startGmailConnection(gmailRedirectUri);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Gmail connection could not start. Open Connections and try again.', 'error');
      setGmailConnecting(false);
    }
  }, [gmailConfigured, gmailRedirectUri, notify]);

  useEffect(() => {
    const location = new URL(window.location.href);
    if (location.searchParams.has('gmail') || (hostedDesk && location.searchParams.has('desk_error'))) {
      location.searchParams.delete('gmail');
      if (hostedDesk) location.searchParams.delete('desk_error');
      window.history.replaceState(null, '', location);
    }
    const resetAfterBack = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setGmailConnecting(false);
      setSessionBusy(false);
    };
    window.addEventListener('pageshow', resetAfterBack);
    return () => window.removeEventListener('pageshow', resetAfterBack);
  }, []);
  useEffect(() => {
    if (!hostedDesk) return;
    const updateSession = (event?: Event) => {
      const ready = Boolean(getDeskSession());
      setSessionReady(ready);
      if (!ready) {
        setSnapshot(undefined);
        setDialog(undefined);
        setPreview(undefined);
        setLoadingError('');
        if (event instanceof CustomEvent && event.detail?.expired) setSessionError('Your workspace session expired. Continue with Google to sign in again.');
      }
    };
    updateSession();
    window.addEventListener(deskSessionEvent, updateSession);
    return () => window.removeEventListener(deskSessionEvent, updateSession);
  }, [setSnapshot]);
  useEffect(() => {
    if (!sessionCode) return;
    const location = new URL(window.location.href);
    location.searchParams.delete('desk_code');
    window.history.replaceState(null, '', location);
    // React development mode can rerun effects. Exchange the single-use code once.
    const request = codeExchange.current ??= api<{ token: string }>('/session/exchange', { code: sessionCode }, true).then(({ token }) => {
      if (typeof token !== 'string' || !token) throw new Error('Google sign-in did not create a workspace session.');
      setDeskSession(token);
    });
    let active = true;
    void request.catch(error => {
      if (active) setSessionError(error instanceof Error ? error.message : 'Sign-in expired. Try signing in again.');
    }).finally(() => {
      if (active) setSessionBusy(false);
    });
    return () => { active = false; };
  }, [sessionCode]);
  useEffect(() => {
    if (window.location.hash !== '#' + gmailConnectRoute || gmailConfigured === undefined) return;
    window.history.replaceState(null, '', '#connections');
    setRoute('connections');
    void connectGmail();
  }, [route, gmailConfigured, connectGmail]);

  useEffect(() => {
    try { localStorage.setItem('conference-desk.sidebar-collapsed', String(sidebarCollapsed)); }
    catch { /* The layout remains usable when browser storage is unavailable. */ }
  }, [sidebarCollapsed]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 700px)');
    const changeViewport = () => { setCompactViewport(media.matches); setMobileOpen(false); };
    const changeFullscreen = () => setFullscreen(Boolean(document.fullscreenElement));
    media.addEventListener('change', changeViewport);
    document.addEventListener('fullscreenchange', changeFullscreen);
    return () => {
      media.removeEventListener('change', changeViewport);
      document.removeEventListener('fullscreenchange', changeFullscreen);
    };
  }, []);
  useEffect(() => {
    if (!mobileOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobileOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [mobileOpen]);
  useEffect(() => {
    const updateRoute = () => { setRoute(currentRoute()); setMobileOpen(false); setDialog(undefined); window.scrollTo({ top: 0 }); };
    window.addEventListener('hashchange', updateRoute);
    return () => window.removeEventListener('hashchange', updateRoute);
  }, []);
  useEffect(() => {
    if (!sessionReady || sessionBusy) return;
    let active = true;
    const refresh = async () => {
      const revision = ++snapshotRevision.current;
      try {
        const data = await api<Snapshot>('/workspace');
        if (!active || revision !== snapshotRevision.current) return;
        writeSnapshot(data);
        setLoadingError('');
      } catch (error) {
        if (active && revision === snapshotRevision.current) setLoadingError(error instanceof Error ? error.message : 'The workspace could not load.');
      }
    };
    void refresh();
    const timer = setInterval(refresh, 12_000);
    return () => { active = false; clearInterval(timer); };
  }, [sessionReady, sessionBusy]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(undefined), notice.kind === 'error' ? 13_000 : 6_000);
    return () => clearTimeout(timer);
  }, [notice]);

  const signIn = async () => {
    setSessionBusy(true);
    setSessionError('');
    try { await startOwnerSignIn(); }
    catch (error) {
      setSessionError(error instanceof Error ? error.message : 'Sign-in could not start. Try again.');
      setSessionBusy(false);
    }
  };
  const signOut = async () => {
    setSessionBusy(true);
    setSessionError('');
    try { await api('/session/end', {}); }
    catch {
      setSessionError('This tab signed out. The hosted server could not confirm that the session ended.');
    } finally {
      setDeskSession();
      setSessionBusy(false);
    }
  };
  const navigate: Navigate = view => {
    window.location.hash = view;
    setRoute(view);
    setMobileOpen(false);
    setDialog(undefined);
    window.scrollTo({ top: 0 });
  };
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { notify('Full screen is unavailable in this browser window.', 'error'); }
  };
  const open = (value: Dialog) => { setNotice(undefined); setPreview(undefined); setDialog(value); };
  const close = () => { setNotice(undefined); setPreview(undefined); setDialog(undefined); };
  const run = async (task: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setNotice(undefined);
    try { await task(); }
    catch (error) { notify(error instanceof Error ? error.message : 'The request failed. Try again.', 'error'); }
    finally { setBusy(false); }
  };
  const sync = () => void run(async () => {
    const result = await api<{ synced: number; snapshot: Snapshot }>('/gmail/sync', {});
    setSnapshot(result.snapshot);
    notify(`Gmail synced. Checked ${result.synced} outreach ${result.synced === 1 ? 'thread' : 'threads'}.`);
  });
  const goConnect = (provider: string) => { navigate('connections'); notify(`Connect ${provider} to continue.`, 'error'); };
  const schedule = (event?: Conference) => open({ kind: 'schedule', eventId: event?.id });
  const eventAction = (event: Conference, action: EventAction) => {
    const base = '/conferences/' + event.id;
    if (action === 'gmail-drafts') {
      if (!snapshot?.connections.gmail) { goConnect('Gmail'); return; }
      const gmailTab = window.open('about:blank', '_blank');
      if (gmailTab) gmailTab.opener = null;
      void run(async () => {
        try {
          const result = await api<{ synced: number; held: number; error?: string; snapshot: Snapshot }>(base + '/gmail-drafts', {});
          setSnapshot(result.snapshot);
          if (result.synced && gmailTab) gmailTab.location.replace(gmailDraftsUrl(result.snapshot.connections.gmail));
          else gmailTab?.close();
          const message = result.synced ? `${result.synced} in Gmail drafts.` : 'No drafts were added. Check for sourced addresses and existing outreach.';
          notify([message, result.held ? `${result.held} skipped because they were already covered.` : '', result.error || ''].filter(Boolean).join(' '), result.error ? 'error' : 'success');
        } catch (error) { gmailTab?.close(); throw error; }
      });
      return;
    }
    if (action === 'apollo' && !providerReady(snapshot, 'apollo')) { goConnect('Apollo'); return; }
    if ((action === 'autumn' || action === 'autumn-discovery') && !providerReady(snapshot, 'autumn')) { goConnect('Autumn'); return; }
    if (action === 'autumn-discovery') { open({ kind: 'autumn-discovery', eventId: event.id }); return; }
    void run(async () => {
      if (action === 'drafts') {
        const result = await api<{ count: number; snapshot: Snapshot }>(base + '/drafts', {});
        setSnapshot(result.snapshot);
        notify(`Wrote ${result.count} outreach ${result.count === 1 ? 'draft' : 'drafts'}.`);
      } else if (action === 'public') {
        setSnapshot(await api<Snapshot>(base + '/research', {}));
        notify('Public research updated.');
      } else if (action === 'apollo') {
        if (hostedDesk) {
          const result = await api<Snapshot & { enrichmentNotes?: string[] }>(base + '/enrich', { provider: 'apollo', limit: 10 });
          setSnapshot(result);
          notify(result.enrichmentNotes?.join(' ') || 'Apollo email lookups queued.');
        } else {
          const preview = await api<ApolloPreview>(base + '/enrich/apollo-preview', {});
          open({ kind: 'apollo', eventId: event.id, preview });
        }
      } else {
        setSnapshot(await api<Snapshot>(base + '/enrich', { provider: action, limit: 10 }));
        notify('Autumn enrichment started.');
      }
    });
  };
  const saveEvent = (input: EventInput, existing?: Conference) => void run(async () => {
    if (existing) {
      setSnapshot(await api<Snapshot>('/conferences/' + existing.id + '/details', input));
      close();
      notify('Conference details saved.');
    } else {
      const result = await api<{ conferenceId: string; snapshot: Snapshot }>('/conferences', input);
      setSnapshot(result.snapshot);
      navigate('event/' + result.conferenceId);
      notify(hostedDesk ? 'Conference added. Attendee research is queued.' : 'Conference added.');
    }
  });

  const references = useMemo(() => snapshot ? outreachReferences(snapshot) : new Map(), [snapshot]);
  const event = useMemo(() => route.startsWith('event/') ? snapshot?.conferences.find(candidate => candidate.id === route.slice(6)) : undefined, [route, snapshot]);
  if (hostedDesk && (!sessionReady || sessionBusy)) return <main className="loading-state" style={{ padding: 24, textAlign: 'center', overflowWrap: 'anywhere' }}>
    <Mark size={37}/><h1>Conference Desk</h1>
    <p>Sign in with the workspace owner’s Google account.</p>
    {sessionError && <p className="dialog-error" role="alert">{sessionError}</p>}
    <button className="button primary" onClick={() => void signIn()} disabled={sessionBusy}>
      {sessionBusy ? <LoaderCircle className="spin" size={16}/> : <Mail size={16}/>}
      {sessionBusy ? 'Working…' : 'Continue with Google'}
    </button>
  </main>;
  if (!snapshot) return <div className="loading-state"><Mark size={37}/><h1>Conference Desk</h1>{loadingError ? <p>{loadingError}</p> : <LoaderCircle className="spin" size={22}/>}</div>;
  const dialogEvent = dialog && 'eventId' in dialog ? snapshot.conferences.find(candidate => candidate.id === dialog.eventId) : undefined;
  const person = dialog?.kind === 'contact' ? dialogEvent?.contacts.find(candidate => candidate.id === dialog.personId) : undefined;
  const now = new Date();
  const scheduleEvents = snapshot.conferences.filter(event => isOutreachOpen(event, now) && event.contacts.some(person =>
    canReachContact(person) && outreachContactKeys(person).every(key => {
      const prior = references.get(key);
      return !prior || (prior.kind === 'gmail-draft' && prior.conferenceId === event.id && prior.contactId === person.id);
    }))).sort((a, b) => (a.startDate || '9999').localeCompare(b.startDate || '9999'));
  const schedulePath = dialog?.kind === 'schedule' && dialog.eventId ? `/conferences/${dialog.eventId}/schedule` : '/schedule';
  const lockDraft = Boolean(person && (person.sentAt || snapshot.queue.some(item => item.contactId === person.id && ['scheduled', 'sending', 'failed'].includes(item.status))));
  const sidebarToggleLabel = compactViewport ? (mobileOpen ? 'Close navigation' : 'Open navigation') : sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
  return <DialogError.Provider value={dialog && notice?.kind === 'error' ? notice.message : undefined}><div className={`shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    <Sidebar snapshot={snapshot} route={route} navigate={navigate} mobileOpen={mobileOpen} collapsed={sidebarCollapsed && !compactViewport} close={() => setMobileOpen(false)}/>
    <div className="workspace">
      <header className="topbar">
        <div className="topbar-title"><button className="icon-button sidebar-toggle" aria-label={sidebarToggleLabel} title={sidebarToggleLabel} aria-controls="workspace-sidebar" aria-expanded={compactViewport ? mobileOpen : !sidebarCollapsed} onClick={() => compactViewport ? setMobileOpen(!mobileOpen) : setSidebarCollapsed(!sidebarCollapsed)}>{compactViewport ? <Menu size={20}/> : sidebarCollapsed ? <PanelLeftOpen size={18}/> : <PanelLeftClose size={18}/>}</button><span className="topbar-workspace">Workspace</span><span className="topbar-slash">/</span><strong>{route === 'queue' ? 'Send queue' : route === 'icp' ? 'Your ICP' : route === 'connections' ? 'Connections' : 'Conferences'}</strong></div>
        <div className="topbar-actions">
          {document.fullscreenEnabled && <button className="icon-button fullscreen-toggle" aria-label={fullscreen ? 'Exit full screen' : 'Enter full screen'} title={fullscreen ? 'Exit full screen' : 'Enter full screen'} aria-pressed={fullscreen} onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}</button>}
          {snapshot.connections.gmail && <a className="button quiet topbar-drafts" target="_blank" rel="noreferrer" href={gmailDraftsUrl(snapshot.connections.gmail)}><Mail size={16}/> Gmail drafts <ArrowUpRight size={13}/></a>}
          <button className="button connection-pill" title={snapshot.connections.gmail ? `Default sender ${snapshot.connections.gmail}` : undefined} disabled={gmailConnecting} onClick={() => snapshot.connections.gmail ? navigate('connections') : void connectGmail()}>
            <span className={`connection-dot ${snapshot.connections.gmail ? 'connected' : ''}`}/>{gmailConnecting ? 'Connecting…' : snapshot.connections.gmail ? 'Gmail connected' : 'Connect Gmail'}
          </button>
        </div>
      </header>
      <main className="main" id="main">
        {route === 'queue' ? <MailboxView snapshot={snapshot} navigate={navigate} busy={busy} onSync={sync} onSchedule={() => schedule()}
          onOpenContact={(eventId, personId) => open({ kind: 'contact', eventId, personId })} onCancel={(id, release) => void run(async () => {
          setSnapshot(await api<Snapshot>('/queue/' + id + (release ? '/review' : '/cancel'), {}));
          notify(release ? 'Hold released. Review the draft before scheduling again.' : 'Scheduled send cancelled.');
        })}/> :
          route === 'icp' ? <IcpView snapshot={snapshot} refresh={setSnapshot} notify={notify}/> :
          route === 'connections' ? <ConnectionsView snapshot={snapshot} refresh={setSnapshot} notify={notify} connectGmail={connectGmail} gmailConnecting={gmailConnecting} signOut={hostedDesk ? signOut : undefined}/> :
          event ? <EventView key={event.id} event={event} snapshot={snapshot} references={references} navigate={navigate} open={open}
            onSchedule={schedule} onAction={eventAction} busy={busy} onRefreshApollo={runId => void run(async () => {
              setSnapshot(await api<Snapshot>(`/conferences/${event.id}/enrich/apollo-runs/${runId}/check`, {}));
              notify('Checking Apollo for existing results.');
            })}/> :
          <Dashboard snapshot={snapshot} readyEvents={scheduleEvents} onAdd={() => open({ kind: 'add' })} navigate={navigate} onSchedule={schedule} onSync={sync} busy={busy}/>}
      </main>
    </div>
    {dialog?.kind === 'add' && <EventForm close={close} save={saveEvent} busy={busy}/>}
    {dialog?.kind === 'edit' && dialogEvent && <EventForm event={dialogEvent} close={close} save={input => saveEvent(input, dialogEvent)} busy={busy}/>}
    {dialog?.kind === 'roster' && dialogEvent && <RosterForm close={close} busy={busy} save={attendees => void run(async () => {
      const result = await api<{ added: number; snapshot: Snapshot }>('/conferences/' + dialogEvent.id + '/roster', { attendees });
      setSnapshot(result.snapshot);
      close();
      notify(result.added ? `Imported and ranked ${result.added} new contacts.` : 'Updated the existing roster.');
    })}/>}
    {dialog?.kind === 'contact' && dialogEvent && person && <ContactForm key={person.id + ':' + polishVersion} person={person} disabled={lockDraft} busy={busy} codex={snapshot.connections.codex} close={close}
      save={data => void run(async () => {
        setSnapshot(await api<Snapshot>(`/conferences/${dialogEvent.id}/contacts/${person.id}`, data));
        close();
        notify('Contact and draft saved.');
      })} polish={() => void run(async () => {
        setSnapshot(await api<Snapshot>(`/conferences/${dialogEvent.id}/contacts/${person.id}/polish`, {}));
        setPolishVersion(n => n + 1);
        notify('Polished the personalization paragraph. Review it before sending.');
      })}/>}
    {dialog?.kind === 'apollo' && dialogEvent && <ApolloReviewModal preview={dialog.preview} busy={busy} close={close}
      onResize={limit => void run(async () => {
        const preview = await api<ApolloPreview>(`/conferences/${dialogEvent.id}/enrich/apollo-preview`, { limit });
        setDialog({ kind: 'apollo', eventId: dialogEvent.id, preview });
      })} onApprove={token => void run(async () => {
        const result = await api<Snapshot & { enrichmentNotes: string[]; apolloRunId?: string }>(`/conferences/${dialogEvent.id}/enrich`, {
          provider: 'apollo', token, approvedMode: dialog.preview.mode,
        });
        setSnapshot(result);
        close();
        notify(result.apolloRunId ? 'Apollo lookup approved. Results will appear below.' : result.enrichmentNotes.join(' ') || 'Apollo enrichment complete.');
      })}/>}
    {dialog?.kind === 'autumn-discovery' && dialogEvent && <AutumnDiscoveryForm event={dialogEvent} busy={busy} close={close}
      onSubmit={notes => void run(async () => {
        setSnapshot(await api<Snapshot>(`/conferences/${dialogEvent.id}/research`, { autumn: true, notes }));
        close();
        notify('Autumn started looking for public attendees.');
      })}/>}
    {dialog?.kind === 'autumn-reply' && dialogEvent && <AutumnReplyForm
      message={snapshot.jobs.find(job => job.id === dialog.jobId)?.message} busy={busy} close={close}
      onSubmit={message => void run(async () => {
        setSnapshot(await api<Snapshot>(`/conferences/${dialogEvent.id}/research/${encodeURIComponent(dialog.jobId)}/reply`, { message }));
        close();
        notify('Autumn received your answer.');
      })}/>}
    {dialog?.kind === 'schedule' && <ScheduleForm event={dialogEvent} conferences={scheduleEvents} account={snapshot.connections.gmail} mailboxes={snapshot.connections.mailboxes}
      preview={preview} close={close} back={() => { setNotice(undefined); setPreview(undefined); }} connect={() => void connectGmail()} busy={busy || gmailConnecting}
      load={(count, now, conferenceIds, email) => void run(async () => {
        const result = await api<{ preview: BatchPreview; snapshot: Snapshot }>(schedulePath + '/preview', { count, now, conferenceIds, ...(hostedDesk && email ? { email } : {}) });
        setSnapshot(result.snapshot);
        setPreview(result.preview);
      })}
      confirm={token => void run(async () => {
        const result = await api<{ count: number; snapshot: Snapshot }>(schedulePath, { token });
        setSnapshot(result.snapshot);
        navigate('queue');
        notify(`${result.count} ${result.count === 1 ? 'email' : 'emails'} added to the send queue.`);
      })}/>}
    {notice && (!dialog || notice.kind !== 'error') && <div className={`toast ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}>{notice.kind === 'error' ? <CircleHelp size={18}/> : <Check size={18}/>}<span>{notice.message}</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setNotice(undefined)}><X size={17}/></button></div>}
  </div></DialogError.Provider>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>);
