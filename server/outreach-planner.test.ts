import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Conference, Contact, QueueItem } from '../src/model';
import { localDate } from '../src/model';
import { outreachContactKeys, outreachDraftOwners, outreachEmailKey, outreachReservations, planOutreach } from './outreach-planner';
import { SCHEDULE_GAP_MS } from './schedule';

const now = new Date('2026-11-06T21:00:00Z');
const account = 'me@example.org';

function person(id: string, score: number, fields: Partial<Contact> = {}): Contact {
  return { id, name: id, score, email: `${id}@example.org`, emailStatus: 'verified', attendance: 'speaker', bucket: 'direct', reason: 'ICP', ...fields };
}

function event(id: string, startDate: string, contacts: Contact[]): Conference {
  return { id, title: id, startDate, contacts, createdAt: now.toISOString(), notes: [], sources: [], needsRoster: false };
}

function queued(conferenceId: string, contactId: string, scheduledAt: string, fields: Partial<QueueItem> = {}): QueueItem {
  return { id: contactId, conferenceId, contactId, scheduledAt, account, email: `${contactId}@example.org`, subject: 'Draft', body: 'Draft', status: 'scheduled', ...fields };
}

test('plans one chronological batch by ICP tier and alternates between conferences within a tier', () => {
  const a = event('a', '2026-11-10', [
    person('a-lower', 80), person('a-high', 94),
    person('a-connector', 99, { bucket: 'connector' }),
  ]);
  const b = event('b', '2026-11-12', [
    person('b-high', 98), person('b-lower', 85),
    person('b-connector', 70, { bucket: 'connector' }),
  ]);
  const result = planOutreach({ conferences: [b, a], queue: [], account, now, count: 6 });
  assert.deepEqual(result.rows.map(row => row.contact.id), ['a-high', 'b-high', 'a-lower', 'b-lower', 'a-connector', 'b-connector']);
  assert.ok(result.rows.every(row => localDate(new Date(row.scheduledAt)) === '2026-11-07'));
  assert.ok(result.rows.slice(1).every((row, i) => Date.parse(row.scheduledAt) - Date.parse(result.rows[i].scheduledAt) >= SCHEDULE_GAP_MS));
  assert.equal(result.readyCount, 6);
});

test('resolves a repeat recipient to the strongest eligible conference without flattening work aliases', () => {
  const a = event('a', '2026-11-09', [
    person('duplicate-near', 98, { bucket: 'connector', email: 'Alex.Smith+event@googlemail.com' }),
    person('work-a', 95, { email: 'a.smith+event@example.org' }),
  ]);
  const b = event('b', '2026-11-10', [
    person('duplicate-strong', 87, { email: 'alexsmith@gmail.com' }),
    person('work-b', 86, { email: 'asmith@example.org' }),
  ]);
  const result = planOutreach({ conferences: [a, b], queue: [], account, now, count: 5 });
  assert.equal(result.duplicateCount, 1);
  assert.deepEqual(result.rows.map(row => row.contact.id), ['work-a', 'duplicate-strong', 'work-b']);
  assert.equal(outreachEmailKey('Alex.Smith+event@googlemail.com'), 'alexsmith@gmail.com');
  assert.notEqual(outreachEmailKey('a.smith+event@example.org'), outreachEmailKey('asmith@example.org'));
});

test('deduplicates across historical aliases, including old rosters outside the selection', () => {
  const historical = event('old', '2026-10-31', [
    person('sent', 90, { email: 'historic@example.org', linkedin: 'https://www.linkedin.com/in/alex-smith/', sentAt: now.toISOString() }),
  ]);
  const upcoming = event('next', '2026-11-11', [
    person('new-role', 99, { email: 'new-address@example.org', linkedin: 'https://uk.linkedin.com/in/Alex-Smith?trk=whatever' }),
    person('another-copy', 99, { email: 'new-address@example.org' }),
    person('different', 90, { linkedin: 'https://other.example.org/in/alex-smith' }),
  ]);
  const reservations = outreachReservations([historical, upcoming], []);
  assert.ok(outreachContactKeys(upcoming.contacts[1]).every(key => reservations.has(key)));
  const result = planOutreach({ conferences: [upcoming, historical], queue: [], selectedConferenceIds: ['next'], account, now, count: 5 });
  assert.deepEqual(result.rows.map(row => row.contact.id), ['different']);
  assert.equal(result.duplicateCount, 2);
});

test('preserves existing mailbox slots and rotates away from the preceding same-tier conference', () => {
  const a = event('a', '2026-11-09', [person('a-already-booked', 99), person('a-next', 96)]);
  const b = event('b', '2026-11-10', [person('b-next', 91)]);
  const occupied = queued('a', 'a-already-booked', '2026-11-07T15:10:00Z');
  const result = planOutreach({ conferences: [a, b], queue: [occupied], account, now, count: 5 });
  assert.equal(result.rows[0].contact.id, 'b-next');
  assert.equal(Date.parse(result.rows[0].scheduledAt), Date.parse(occupied.scheduledAt) + SCHEDULE_GAP_MS);
  assert.equal(result.rows[1].contact.id, 'a-next');
  assert.equal(result.duplicateCount, 1);
});

test('honors event cutoffs, with a later eligible conference as fallback for a repeated recipient', () => {
  const a = event('a', '2026-11-07', [person('early-version', 99, { email: 'shared@example.org' })]);
  const b = event('b', '2026-11-10', [person('later-version', 80, { email: 'shared@example.org' })]);
  const dayIsFull = ['2026-11-07T15:10:00Z', '2026-11-07T19:20:00Z'].flatMap((block, i) =>
    Array.from({ length: 15 }, (_, slot) => queued('other', `occupied-${i}-${slot}`, new Date(Date.parse(block) + slot * SCHEDULE_GAP_MS).toISOString())));
  const result = planOutreach({ conferences: [a, b], queue: dayIsFull, account, now, count: 5 });
  assert.deepEqual(result.rows.map(row => row.contact.id), ['later-version']);
  assert.equal(localDate(new Date(result.rows[0].scheduledAt)), '2026-11-08');
  assert.deepEqual(planOutreach({ conferences: [a, b], queue: dayIsFull, selectedConferenceIds: ['a'], account, now, count: 5 }).rows, []);
});

test('keeps reserved email identities until cancellation and accounts for recent attempts', () => {
  const a = event('a', '2026-11-09', [person('a-held', 99), person('a-eligible', 85)]);
  const held = queued('another-event', 'pending', now.toISOString(), { email: 'a-held@example.org', status: 'failed', sendingAt: now.toISOString() });
  assert.deepEqual(planOutreach({ conferences: [a], queue: [held], account, now, count: 5, sendNow: true }).rows, []);
  const later = new Date(+now + SCHEDULE_GAP_MS);
  const open = planOutreach({ conferences: [a], queue: [held], account, now: later, count: 5, sendNow: true });
  assert.deepEqual(open.rows.map(row => row.contact.id), ['a-eligible']);
  assert.ok(!outreachReservations([a], [held], held.id).has('a-held@example.org'));
  const released = planOutreach({ conferences: [a], queue: [{ ...held, status: 'cancelled' }], account, now: later, count: 5, sendNow: true });
  assert.deepEqual(released.rows.map(row => row.contact.id), ['a-held']);
});

test('uses the original and current address of a Gmail draft to reserve the existing contact', () => {
  const a = event('a', '2026-11-09', [person('owner', 80, {
    draft: { subject: 'Existing', body: 'Draft', gmailId: 'existing-draft', gmailAccount: account, gmailExportedEmail: 'original@example.org' },
  })]);
  const b = event('b', '2026-11-10', [
    person('duplicate-owner', 99, { email: a.contacts[0].email }),
    person('duplicate-original', 97, { email: 'original@example.org' }),
  ]);
  const owners = outreachDraftOwners([a, b], account);
  assert.deepEqual(owners.get('original@example.org'), { conferenceId: 'a', contactId: 'owner' });
  const result = planOutreach({ conferences: [a, b], queue: [], account, now, count: 5 });
  assert.deepEqual(result.rows.map(row => row.contact.id), ['owner']);
  assert.equal(result.duplicateCount, 2);
});
