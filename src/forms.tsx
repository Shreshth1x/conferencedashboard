import { useState, type FormEvent } from 'react';
import { hostedDesk } from './api';
import { ArrowRight, CalendarClock, FileUp, LoaderCircle, Mail, Save, Sparkles } from 'lucide-react';
import { gmailThreadUrl, type BatchPreview, type Conference, type Contact } from './model';
import { BucketBadge, dateRange, External, Modal, slotTime } from './components';

export type EventInput = { input: string; title: string; location: string; url: string; startDate: string; endDate: string; attendees: string };

function FilePick({ onText }: { onText: (value: string) => void }) {
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState('');
  return <div className="file-pick">
    <label className="button secondary"><FileUp size={16}/>{fileName || 'Choose CSV or text file'}<input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" onChange={async event => {
      const file = event.currentTarget.files?.[0];
      if (!file) return;
      if (file.size > 2_000_000) { setError('Choose a file smaller than 2 MB.'); return; }
      try { onText(await file.text()); setFileName(file.name); setError(''); }
      catch { setError('The file could not be read. Paste its contents instead.'); }
    }}/></label>
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}

export function EventForm({ event, close, save, busy }: { event?: Conference; close: () => void; save: (data: EventInput) => void; busy: boolean }) {
  const [input, setInput] = useState<EventInput>({ input: '', title: event?.title ?? '', location: event?.location ?? '', url: event?.url ?? '', startDate: event?.startDate ?? '', endDate: event?.endDate ?? '', attendees: '' });
  const bind = (field: keyof EventInput) => ({ value: input[field], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setInput({ ...input, [field]: e.target.value }) });
  return <Modal title={event ? 'Edit conference' : 'Add a conference'} description={event ? 'Update your dates, location, or event link.' : 'Start with whatever you have. A name, link, or event details are enough.'} onClose={close}>
    <form onSubmit={e => { e.preventDefault(); save(input); }}>
      {!event && <label className="field">Conference link or details<textarea rows={3} autoFocus required placeholder="https://event.com or Advancing Data Center Construction East…" {...bind('input')}/></label>}
      {event ? <label className="field">Conference name<input required autoFocus {...bind('title')}/></label> : null}
      {event ? <label className="field">Event link<input type="url" placeholder="https://…" {...bind('url')}/></label> : null}
      <details className="optional-details" open={event ? true : undefined}>
        <summary>{event ? 'Dates and location' : 'Add dates, location, or a roster'}</summary>
        {!event && <label className="field">Conference name<input placeholder="Optional" {...bind('title')}/></label>}
        <label className="field">Location<input placeholder="City or venue" {...bind('location')}/></label>
        <div className="field-row"><label className="field">Start date<input type="date" {...bind('startDate')}/></label><label className="field">End date<input type="date" {...bind('endDate')}/></label></div>
        {!event && <><label className="field">Attendees<textarea rows={4} placeholder="Paste a list of names or CSV rows" {...bind('attendees')}/></label><FilePick onText={attendees => setInput({ ...input, attendees })}/></>}
      </details>
      <div className="form-actions"><button className="button secondary" type="button" onClick={close}>Cancel</button><button className="button primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17}/> : <ArrowRight size={17}/>} {event ? 'Save details' : busy ? 'Researching…' : 'Find attendees'}</button></div>
    </form>
  </Modal>;
}

export function RosterForm({ close, save, busy }: { close: () => void; save: (value: string) => void; busy: boolean }) {
  const [value, setValue] = useState('');
  return <Modal title="Import attendees" description="Paste a list or export the organizer’s roster to CSV. We’ll deduplicate and rank the contacts." onClose={close}>
    <form onSubmit={e => { e.preventDefault(); save(value); }}>
      <label className="field">Attendee list<textarea autoFocus required rows={9} value={value} onChange={e => setValue(e.target.value)} placeholder={'Name,Title,Company,Email\nJamie Lee,Commissioning Manager,Example Company,jamie@example.com'}/></label>
      <FilePick onText={setValue}/>
      <p className="field-note">A name is enough to add someone. Include role and company for a better fit score. Confirm an address before scheduling if its source is uncertain.</p>
      <div className="form-actions"><button className="button secondary" type="button" onClick={close}>Cancel</button><button className="button primary" disabled={!value.trim() || busy}>Import and rank</button></div>
    </form>
  </Modal>;
}

export function ContactForm({ person, disabled, busy, codex, close, save, polish }: {
  person: Contact; disabled: boolean; busy: boolean; codex: boolean; close: () => void;
  save: (data: { email: string; subject: string; body: string; confirmEmail: boolean; approved: boolean }) => void;
  polish: () => void;
}) {
  const [email, setEmail] = useState(person.sentEmail || person.email || '');
  const [subject, setSubject] = useState(person.sentSubject || person.draft?.subject || '');
  const [body, setBody] = useState(person.draft?.body ?? '');
  const [confirmEmail, setConfirmEmail] = useState(false);
  const unchanged = email === (person.email ?? '') && subject === (person.draft?.subject ?? '') && body === (person.draft?.body ?? '');
  return <Modal title={person.name} description={[person.title, person.company].filter(Boolean).join(' at ') || 'Contact details'} onClose={close} wide>
    <div className="contact-evidence">
      <BucketBadge bucket={person.bucket}/><strong>{person.score}/100</strong><span>{person.reason}</span>
      <div><External url={person.sourceUrl}>Attendance source</External><External url={person.hookSource}>Personalization source</External><External url={person.linkedin}>LinkedIn</External>
        <External url={gmailThreadUrl(person.gmailAccount, person.gmailThreadId)}>Gmail conversation</External>
        <External url={gmailThreadUrl(person.priorOutreach?.account, person.priorOutreach?.gmailThreadId)}>Earlier Gmail outreach</External>
      </div>
      {person.sentAt && <p>Sent {slotTime(person.sentAt)}{person.gmailAccount ? ' from ' + person.gmailAccount : ''}.</p>}
      {person.repliedAt && <p>{person.replyCount && person.replyCount > 1 ? `${person.replyCount} replies. First reply` : 'Replied'} {slotTime(person.repliedAt)}.</p>}
      {person.hook && <p>{person.hook}</p>}
    </div>
    <form onSubmit={e => { e.preventDefault(); save({ email, subject, body, confirmEmail, approved: true }); }}>
      <label className="field">Recipient email<input type="email" value={email} disabled={disabled} onChange={e => { setEmail(e.target.value); setConfirmEmail(false); }} placeholder="name@company.com"/></label>
      {person.emailSource && <p className="field-note">{person.emailStatus === 'verified' ? 'Verified' : 'Email source'} · {/^https?:\/\//i.test(person.emailSource) ? <External url={person.emailSource}>Open evidence</External> : person.emailSource}</p>}
      {!disabled && email && (person.emailStatus === 'unverified' || !person.emailStatus || email !== person.email) && <label className="checkbox"><input type="checkbox" checked={confirmEmail} onChange={e => setConfirmEmail(e.target.checked)}/> I confirmed this address belongs to {person.name}.</label>}
      <label className="field">Subject<input value={subject} disabled={disabled} onChange={e => setSubject(e.target.value)} placeholder="Write a subject or generate drafts from the conference"/></label>
      <label className="field">Draft<textarea rows={9} value={body} disabled={disabled} onChange={e => setBody(e.target.value)} placeholder="Your outreach draft will appear here."/></label>
      <div className="form-actions spread">
        <div>{codex && person.draft && !disabled && person.bucket !== 'irrelevant' && <button className="button secondary" type="button" disabled={busy || !unchanged} onClick={polish}><Sparkles size={16}/> Polish with Codex</button>}</div>
        {disabled ? <button className="button secondary" type="button" onClick={close}>Close</button> : <button className="button primary" disabled={busy}><Save size={16}/> Save changes</button>}
      </div>
    </form>
  </Modal>;
}

export function ScheduleForm({ event, conferences, account, mailboxes, preview, close, back, connect, load, confirm, busy }: {
  event?: Conference; conferences: Conference[]; account?: string; mailboxes?: string[]; preview?: BatchPreview; close: () => void;
  back: () => void; connect: () => void; load: (count: number, now: boolean, conferenceIds: string[], sender?: string) => void;
  confirm: (token: string) => void; busy: boolean;
}) {
  const [count, setCount] = useState(5);
  const [now, setNow] = useState(false);
  const [sender, setSender] = useState(account);
  const sendingAccount = sender && mailboxes?.includes(sender) ? sender : account;
  const [selected, setSelected] = useState(() => new Set((event ? [event] : conferences).map(candidate => candidate.id)));
  const chosen = event ? [event.id] : conferences.filter(candidate => selected.has(candidate.id)).map(candidate => candidate.id);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (preview) {
      if (preview.account) confirm(preview.token);
      else connect();
    } else load(count, now, chosen, sendingAccount);
  };
  const eventCount = preview ? new Set(preview.rows.map(row => row.conferenceId)).size : chosen.length;
  const description = preview
    ? [`${preview.rows.length} ${preview.rows.length === 1 ? 'email' : 'emails'} across ${eventCount} ${eventCount === 1 ? 'conference' : 'conferences'}`, preview.account && `From ${preview.account}`].filter(Boolean).join(' · ')
    : event?.title || 'Plan one batch for your shared inbox.';
  return <Modal title={preview ? 'Review your batch' : event ? 'Schedule outreach' : 'Schedule next batch'} description={description} onClose={close} wide={Boolean(preview)}>
    <form onSubmit={submit}>
      {preview ? <>
        {preview.duplicateCount > 0 && <p className="batch-note">{preview.duplicateCount} overlapping or already covered {preview.duplicateCount === 1 ? 'roster entry skipped' : 'roster entries skipped'}.</p>}
        <div className="batch-list">{preview.rows.map(row => <details key={row.conferenceId + ':' + row.contactId}>
          <summary><span className="batch-row-title"><strong>{row.name}</strong><span>{slotTime(row.scheduledAt)}</span></span>
            <span className="batch-row-meta"><span>{row.conferenceTitle}</span><BucketBadge bucket={row.bucket}/></span></summary>
          <p>{row.email}</p><p className="batch-subject">{row.subject}</p><p className="message-preview">{row.body}</p>
        </details>)}</div>
      </> : <>
        <p className="schedule-explainer">Direct fits go first, then potential introducers. Within each group, the queue alternates conferences when it can. Batches start tomorrow in Central time, with at least five minutes between emails.</p>
        {!event && <fieldset className="schedule-events">
          <legend>Conferences to include</legend>
          {conferences.length ? conferences.map(candidate => <label key={candidate.id} className="schedule-event-option">
            <input type="checkbox" checked={selected.has(candidate.id)} onChange={e => setSelected(current => {
              const next = new Set(current);
              if (e.target.checked) next.add(candidate.id);
              else next.delete(candidate.id);
              return next;
            })}/>
            <span><strong>{candidate.shortTitle || candidate.title}</strong><small>{dateRange(candidate)}</small></span>
          </label>) : <p>Add an upcoming conference with sourced email addresses to start.</p>}
        </fieldset>}
        {mailboxes && mailboxes.length > 1 && <label className="field">Send from<select value={sendingAccount} onChange={e => setSender(e.target.value)}>
          {mailboxes.map(email => <option key={email} value={email}>{email}</option>)}
        </select></label>}
        <div className="field-row schedule-controls">
          <label className="field">Batch size<select value={count} disabled={now} onChange={e => setCount(Number(e.target.value))}>{[5, 6, 7, 8, 9, 10].map(n => <option key={n} value={n}>{n} emails</option>)}</select></label>
          {account && <label className="checkbox"><input type="checkbox" checked={now} onChange={e => setNow(e.target.checked)}/> Send the next eligible email now</label>}
        </div>
      </>}
      <p className="field-note">{preview && !preview.account ? 'Connect Gmail when you’re ready to confirm a batch.' : hostedDesk
        ? 'Scheduled emails run in the cloud. You can close this page or turn off your Mac.'
        : 'Keep Conference Desk running through the send times. You can cancel pending emails from the queue.'}</p>
      <div className="form-actions">
        <button className="button secondary" type="button" onClick={preview ? back : close} disabled={busy}>{preview ? 'Edit batch' : 'Cancel'}</button>
        <button className="button primary" disabled={busy || (!preview && !chosen.length)}>
          {preview?.account ? <CalendarClock size={17}/> : <Mail size={17}/>}
          {busy ? 'Working…' : !preview ? 'Preview batch' : !preview.account ? 'Connect Gmail' : now ? 'Send now' : `Schedule ${preview.rows.length} ${preview.rows.length === 1 ? 'email' : 'emails'}`}
        </button>
      </div>
    </form>
  </Modal>;
}
