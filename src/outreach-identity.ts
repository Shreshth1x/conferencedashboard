import { localDate, type Conference, type Contact } from './model.ts';

export function outreachEmailKey(email?: string) {
  const address = email?.normalize('NFKC').trim().toLowerCase() || '';
  const gmail = address.match(/^([^@+]+)(?:\+[^@]*)?@(?:gmail|googlemail)\.com$/);
  return gmail ? `${gmail[1].replace(/\./g, '')}@gmail.com` : address;
}

function linkedInKey(link?: string) {
  if (!link) return '';
  try {
    const url = new URL(link);
    if (!['https:', 'http:'].includes(url.protocol) || !/(^|\.)linkedin\.com$/i.test(url.hostname)) return '';
    const slug = url.pathname.match(/^\/in\/([^/]+)\/?$/i)?.[1];
    return slug ? 'linkedin:' + decodeURIComponent(slug).normalize('NFKC').toLowerCase() : '';
  } catch {
    return '';
  }
}

export function outreachContactKeys(person: Pick<Contact, 'email' | 'linkedin'>): string[] {
  return [outreachEmailKey(person.email), linkedInKey(person.linkedin)].filter(Boolean);
}

export function canReachContact(person: Contact): person is Contact & { email: string } {
  return person.bucket !== 'irrelevant' && !person.sentAt && !person.repliedAt && !person.previouslyContacted
    && (person.emailStatus === 'sourced' || person.emailStatus === 'verified')
    && Boolean(person.email && /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(person.email));
}

export function outreachEventCutoff(event: Conference) { return event.startDate || event.endDate; }

export function isOutreachOpen(event: Conference, at: Date) {
  const deadline = outreachEventCutoff(event);
  return !event.example && (!deadline || localDate(at) <= deadline);
}
