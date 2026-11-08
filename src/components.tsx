import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { ArrowDownRight, ArrowRight, ArrowUpRight, CalendarDays, ChevronRight, Clock3, Compass, ExternalLink, Mail, MapPin, Plus, X } from 'lucide-react';
import { type Conference, type QueueItem, type Bucket, BUCKETS, TIME_ZONE, campaignCounts, isPast, localDate, safeLink } from './model';

export function dateRange(event: Conference) {
  if (!event.startDate) return 'Dates to be confirmed';
  const start = new Date(event.startDate + 'T12:00:00Z');
  const end = event.endDate ? new Date(event.endDate + 'T12:00:00Z') : start;
  if (Number.isNaN(start.valueOf()) || Number.isNaN(end.valueOf())) return 'Dates to be confirmed';
  const format = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (+start === +end) return format.format(start) + ', ' + start.getUTCFullYear();
  return format.formatRange(start, end) + ', ' + end.getUTCFullYear();
}

export function slotTime(value: string) {
  return new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(value));
}

export function timeUntil(event: Conference) {
  if (isPast(event)) return 'Past event';
  if (!event.startDate) return 'Date pending';
  const days = Math.round((Date.parse(event.startDate) - Date.parse(localDate())) / 86_400_000);
  if (days <= 0) return 'Happening now';
  return days === 1 ? 'Tomorrow' : `In ${days} days`;
}

export function Mark({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <path d="M7 13.5 16 7l9 6.5v10.2L16 29l-9-5.3V13.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"/>
    <path d="m7 13.5 9 5.8 9-5.8M16 19.3v9.3M12.2 11.5l7.7 5.1M16 3v2.2M5 7l2 2M27 7l-2 2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>;
}

export function DeskArt() {
  return <svg className="desk-art" viewBox="0 0 240 155" fill="none" aria-hidden="true">
    <path d="M63 131c16-5 41-6 66-3 29 3 59 2 76-4" stroke="#ddd5cb" strokeWidth="1.7" strokeLinecap="round"/>
    <path d="M157 38c12 2 28 13 31 26 4 17-14 20-19 10-6-10 8-16 18-15 17 1 27 13 25 25" stroke="#24221e" strokeWidth="1.8" strokeDasharray="2.8 5" strokeLinecap="round"/>
    <path d="m205 84 18-1-9 12-2-6-7-5Z" fill="#F7E3A3" stroke="#24221e" strokeWidth="1.6" strokeLinejoin="round"/>
    <path d="m212 89 11-6" stroke="#24221e" strokeWidth="1.5"/>
    <path d="M46 92c12-13 16-30 28-38 18-13 30-1 49-1 22 0 34 13 38 28 8 28-8 46-36 50-22 3-43 0-62-5-16-4-30-18-17-34Z" fill="#f5dfeb"/>
    <path d="M100 32c0-8 6-14 13-14 7 0 13 6 13 14v23h-10V32c0-3-1-5-3-5s-3 2-3 5v24h-10V32Z" fill="#BFD4EF" stroke="#24221e" strokeWidth="2" strokeLinejoin="round"/>
    <g transform="rotate(-11 108 85)">
      <rect x="75" y="49" width="70" height="77" rx="10" fill="#fffef9" stroke="#24221e" strokeWidth="2.3"/>
      <path d="M76 65h68" stroke="#24221e" strokeWidth="2"/>
      <path d="M102 57h14" stroke="#24221e" strokeWidth="2" strokeLinecap="round"/>
      <circle cx="110" cy="86" r="10" fill="#f4b8a1" stroke="#24221e" strokeWidth="1.8"/>
      <path d="M104.6 86c.7 2.8 2.9 4.2 5.4 4.2 2.6 0 4.7-1.4 5.4-4.2M106 82.5v.8m8-.8v.8" stroke="#24221e" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M92 107h35m-30 7h25" stroke="#24221e" strokeWidth="1.9" strokeLinecap="round"/>
    </g>
    <path d="M58 40v13m-6-6.5h12M151 109v13m-6-6.5h12M173 110l4 5m-5 0 6-5" stroke="#24221e" strokeWidth="1.65" strokeLinecap="round"/>
  </svg>;
}

export const DialogError = createContext<string | undefined>(undefined);

export function Modal({ title, description, onClose, children, wide = false }: { title: string; description?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const error = useContext(DialogError);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'wide' : ''}`} onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }} aria-labelledby="dialog-title">
    <div className="modal-inner">
      <header className="modal-head"><div><h2 id="dialog-title">{title}</h2>{description && <p>{description}</p>}</div>
        <button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={19}/></button></header>
      {error && <p className="dialog-error" role="alert">{error}</p>}
      {children}
    </div>
  </dialog>;
}

export function BucketBadge({ bucket }: { bucket: Bucket }) {
  return <span className={`bucket ${bucket}`}><span className="dot"/>{BUCKETS[bucket]}</span>;
}

const themes = ['peach', 'blue', 'rose', 'yellow'];
export function eventColor(id: string) {
  return themes[[...id].reduce((total, ch) => total + ch.charCodeAt(0), 0) % themes.length];
}

export function ConferenceCard({ event, queue, onOpen }: { event: Conference; queue: QueueItem[]; onOpen: () => void }) {
  const stats = campaignCounts(event, queue);
  const state = timeUntil(event);
  return <button className="conference-card" onClick={onOpen}>
    <div className="card-top">
      <span className={`event-mark ${eventColor(event.id)}`}><CalendarDays size={19}/></span>
      <span className={`date-chip ${state === 'Past event' ? 'past' : ''}`}><span className="dot"/>{state}</span>
      <ArrowUpRight className="card-arrow" size={18}/>
    </div>
    <div className="event-title">{event.title}</div>
    <div className="event-meta"><span>{dateRange(event)}</span>{event.location && <span><MapPin size={13}/>{event.location}</span>}</div>
    <div className="card-progress-label"><span>Outreach progress</span><strong>{stats.progress}%</strong></div>
    <div className="progress" role="progressbar" aria-label="Outreach progress" aria-valuenow={stats.progress} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${stats.progress}%` }}/></div>
    <div className="event-metrics">
      <span><strong>{stats.sent}</strong> Sent</span>
      <span><strong>{stats.replies}</strong> Replies</span>
      <span><strong>{stats.left}</strong> Left</span>
      {stats.scheduled > 0 && <span className="scheduled-chip"><Clock3 size={12}/>{stats.scheduled} queued</span>}
    </div>
  </button>;
}

export function Empty({ icon = 'compass', title, detail, action, onAction }: { icon?: 'compass' | 'mail'; title: string; detail: string; action?: string; onAction?: () => void }) {
  const Icon = icon === 'mail' ? Mail : Compass;
  return <div className="empty"><div className="empty-mark"><Icon size={24}/></div><h3>{title}</h3><p>{detail}</p>
    {action && <button className="button primary" onClick={onAction}><Plus size={17}/>{action}</button>}</div>;
}

export function External({ url, children }: { url?: string; children: ReactNode }) {
  const href = safeLink(url);
  return href ? <a className="text-link" href={href} target="_blank" rel="noreferrer">{children}<ExternalLink size={13}/></a> : null;
}

export function Breadcrumb({ label, back }: { label: string; back: () => void }) {
  return <div className="breadcrumb"><button onClick={back}>Conferences</button><ChevronRight size={14}/><span>{label}</span></div>;
}

export function ActionBanner({ title, detail, action, onAction, disabled }: { title: string; detail: string; action: string; onAction: () => void; disabled?: boolean }) {
  return <div className="action-banner"><div className="banner-icon"><ArrowDownRight size={21}/></div><div><strong>{title}</strong><p>{detail}</p></div><button className="button primary" onClick={onAction} disabled={disabled}>{action}<ArrowRight size={16}/></button></div>;
}
