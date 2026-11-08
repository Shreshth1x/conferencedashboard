import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';

const basePath = '/ConferenceDashboard/';
const apiBase = 'https://desk-test.example/functions/v1/desk';
let server: ViteDevServer;
let origin: string;

test.beforeAll(async () => {
  process.env.VITE_DESK_API = apiBase;
  process.env.VITE_BASE_PATH = basePath;
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Could not start the hosted frontend test server.');
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await server?.close();
  delete process.env.VITE_DESK_API;
  delete process.env.VITE_BASE_PATH;
});

test('owner session and multiple Gmail senders on a GitHub Pages base path', async ({ page, context }) => {
  const site = origin + basePath;
  const first = 'first@example.test';
  const second = 'second@example.test';
  const callback = apiBase + '/gmail/callback';
  const google = (redirect: string) => 'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=' + encodeURIComponent(redirect);
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const headers = {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
  };
  const calls: { path: string; authorization?: string; body?: { returnUrl?: string; code?: string; email?: string; count?: number; now?: boolean; conferenceIds?: string[] } }[] = [];
  const candidate = { id: 'contact-two', name: 'Jordan Lee', email: 'jordan@example.test', emailStatus: 'verified', attendance: 'attendee', bucket: 'direct', score: 85, reason: 'Role match' };
  let sender = first;
  let mailboxes = [first, second];
  const snapshot = () => ({
    conferences: [{ id: 'one', title: 'Conference One', createdAt: future, contacts: [candidate], sources: [], notes: [], needsRoster: false }],
    queue: [{
      id: 'queued', conferenceId: 'one', contactId: 'contact-one', account: first, email: 'lead@example.test',
      subject: 'Example outreach', body: 'Test', status: 'scheduled', scheduledAt: future,
    }],
    jobs: [], icp: { name: 'Example', description: '', direct: [], connector: [], accounts: [] }, outreachReady: 0,
    connections: { gmailConfigured: true, gmailRedirectUri: callback, gmail: sender, mailboxes, codex: false },
  });

  await context.route(apiBase + '/**', route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const path = request.url().slice(apiBase.length);
    const authorization = request.headers().authorization;
    const body = request.postDataJSON() ?? undefined;
    calls.push({ path, authorization, body });
    const respond = (json: object, status = 200) => route.fulfill({ status, headers, json });
    if (path === '/session/start') return respond({ url: google(apiBase + '/session/callback') });
    if (path === '/session/exchange') return respond({ token: 'mock-session' });
    if (authorization !== 'Bearer mock-session') return respond({ error: 'Unauthorized' }, 401);
    if (path === '/workspace') return respond(snapshot());
    if (path === '/gmail/select') {
      sender = body.email;
      return respond(snapshot());
    }
    if (path === '/schedule/preview') return respond({
      snapshot: snapshot(),
      preview: {
        token: 'mock-preview', account: body.email ?? sender, duplicateCount: 0,
        rows: [{
          conferenceId: 'one', conferenceTitle: 'Conference One', contactId: candidate.id, name: candidate.name,
          email: candidate.email, bucket: candidate.bucket, subject: 'Conference outreach', body: 'Test', scheduledAt: future,
        }],
      },
    });
    if (path === '/gmail/connect') return respond({ url: google(callback) });
    if (path === '/gmail/disconnect') {
      mailboxes = mailboxes.filter(email => email !== body.email);
      sender = mailboxes[0];
      return respond(snapshot());
    }
    if (path === '/session/end') return route.fulfill({ status: 204, headers });
    return respond({ error: 'Unmatched mock endpoint' }, 404);
  });
  await context.route('https://accounts.google.com/**', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><h1>Mock Google consent</h1>',
  }));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(site + '#connections');
  const login = page.getByRole('button', { name: 'Continue with Google' });
  await expect(login).toBeVisible();
  expect(calls).toHaveLength(0);
  await login.click();
  await expect(page.getByRole('heading', { name: 'Mock Google consent' })).toBeVisible();
  expect(calls[0]).toEqual({ path: '/session/start', authorization: undefined, body: { returnUrl: site + '#connections' } });

  await page.goto(site + '?desk_code=one-time#connections');
  await expect(page.getByRole('heading', { name: 'Connections', exact: true })).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
  expect(calls.filter(call => call.path === '/session/exchange')).toEqual([
    { path: '/session/exchange', authorization: undefined, body: { code: 'one-time' } },
  ]);
  expect(calls).toContainEqual({ path: '/workspace', authorization: 'Bearer mock-session', body: undefined });
  await expect(page.getByRole('heading', { name: 'Local Codex', exact: true })).toHaveCount(0);

  await page.getByRole('combobox', { name: 'Default Gmail sender' }).selectOption(second);
  await expect(page.getByText(`Default sender set to ${second}.`, { exact: true })).toBeVisible();
  expect(calls).toContainEqual({ path: '/gmail/select', authorization: 'Bearer mock-session', body: { email: second } });

  await page.goto(site + '#queue');
  await expect(page.getByText('Scheduled', { exact: true })).toBeVisible();
  await expect(page.getByText('Connect sender mailbox', { exact: true })).toHaveCount(0);
  await page.getByLabel('Filter outreach by sender').selectOption(second);
  await expect(page.getByRole('heading', { name: 'No matching outreach' })).toBeVisible();

  await page.getByRole('button', { name: 'Schedule next batch' }).click();
  const schedule = page.getByRole('dialog');
  const sendFrom = schedule.getByRole('combobox', { name: /Send from/ });
  await expect(sendFrom).toHaveValue(second);
  await sendFrom.selectOption(first);
  await schedule.getByRole('button', { name: 'Preview batch' }).click();
  await expect(schedule.getByRole('heading', { name: 'Review your batch' })).toBeVisible();
  await expect(schedule.getByText(`1 email across 1 conference · From ${first}`, { exact: true })).toBeVisible();
  expect(calls).toContainEqual({
    path: '/schedule/preview', authorization: 'Bearer mock-session',
    body: { count: 5, now: false, conferenceIds: ['one'], email: first },
  });
  await schedule.getByRole('button', { name: 'Close dialog' }).click();

  await page.goto(site + '#connections');
  await page.getByRole('button', { name: 'Connect another mailbox' }).click();
  await expect(page.getByRole('heading', { name: 'Mock Google consent' })).toBeVisible();
  expect(calls).toContainEqual({ path: '/gmail/connect', authorization: 'Bearer mock-session', body: { returnUrl: site + '#connections' } });

  await page.goto(site + '?gmail=connected#connections');
  await expect(page.getByText('Gmail connected.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect selected mailbox' }).click();
  await expect(page.getByText(`Disconnected ${second}.`, { exact: true })).toBeVisible();
  expect(calls).toContainEqual({ path: '/gmail/disconnect', authorization: 'Bearer mock-session', body: { email: second } });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);

  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(login).toBeVisible();
  expect(calls).toContainEqual({ path: '/session/end', authorization: 'Bearer mock-session', body: {} });
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);

  await page.evaluate(key => sessionStorage.setItem(key, 'expired-mock-token'), 'conference-desk.session:' + apiBase);
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('session expired');
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
});

test('adding a hosted conference shows background discovery and keeps Apollo behind the ranked roster', async ({ page, context }) => {
  const headers = {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
  };
  const conference = { id: 'new-event', title: 'Example Conference', createdAt: new Date().toISOString(),
    contacts: [{ id: 'contact', name: 'Jamie Lee', title: 'Commissioning lead', bucket: 'direct', score: 90, reason: 'Role match', attendance: 'attendee' }],
    sources: [], notes: [], needsRoster: true };
  let added = false;
  let searched = false;
  let apolloQueued = false;
  const snapshot = () => ({
    conferences: added ? [conference] : [], queue: [], outreachReady: 0,
    icp: { name: 'Example', description: '', direct: [], connector: [], accounts: [] },
    connections: { gmailConfigured: true, apollo: true, autumn: true, exa: true, codex: false },
    jobs: added ? [{ id: 'job', conferenceId: conference.id, kind: 'discovery', automatic: true,
      status: searched ? 'done' : 'running', message: searched ? 'Attendee research complete.' : 'Searching public sources.' }] : [],
  });

  await context.route(apiBase + '/**', route => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const path = request.url().slice(apiBase.length);
    const respond = (json: object, status = 200) => route.fulfill({ status, headers, json });
    if (path === '/session/exchange') return respond({ token: 'mock-session' });
    if (path === '/workspace') return respond(snapshot());
    if (path === '/conferences') {
      expect(request.postDataJSON().input).toBe(conference.title);
      added = true;
      return respond({ conferenceId: conference.id, snapshot: snapshot() });
    }
    if (path === '/conferences/new-event/enrich') {
      expect(request.postDataJSON()).toEqual({ provider: 'apollo', limit: 10 });
      apolloQueued = true;
      return respond({ ...snapshot(), enrichmentNotes: ['Apollo email lookups queued.'] });
    }
    return respond({ error: 'Unmatched mock endpoint' }, 404);
  });

  await page.goto(origin + basePath + '?desk_code=one-time');
  await page.getByRole('button', { name: 'Add conference', exact: true }).first().click();
  await page.getByLabel('Conference link or details').fill(conference.title);
  await page.getByRole('button', { name: 'Add and find attendees' }).click();
  await expect(page.getByText('Finding and ranking attendees', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'View research' }).click();
  const apollo = page.getByRole('button', { name: 'Find work emails with Apollo' });
  await expect(apollo).toBeDisabled();

  searched = true;
  await page.reload();
  await page.getByRole('button', { name: 'Research & sources' }).click();
  await expect(apollo).toBeEnabled();
  await apollo.click();
  await expect(page.getByText('Apollo email lookups queued.', { exact: true })).toBeVisible();
  expect(apolloQueued).toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
