import { expect, test } from '@playwright/test';

const eventName = 'Commissioning Field Operations Forum';
const roster = [
  'Name,Title,Company,Email,Attendance',
  'Jamie Lee,Commissioning Manager,Example Test Systems,jamie@example.org,attendee',
  'Taylor Chen,Partnerships Manager,Example Industry Group,taylor@example.org,attendee',
  'Morgan Diaz,Bakery Manager,Example Bakery,morgan@example.org,attendee',
].join('\n');

test('anonymous conference intake, ranking, drafts, settings, and queue', async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  await page.goto('/');
  const workspace = page.getByRole('navigation', { name: 'Workspace' });
  await expect(page.getByRole('heading', { name: 'Conference outreach' })).toBeVisible();
  await page.getByRole('button', { name: 'Add conference', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Conference link or details').fill(eventName);
  await dialog.getByRole('button', { name: 'Find attendees' }).click();
  await expect(page.getByRole('heading', { name: eventName, exact: true })).toBeVisible();
  const eventUrl = page.url();
  await expect(page.getByText('The public roster may be incomplete')).toBeVisible();

  await page.getByRole('button', { name: 'Import attendees', exact: true }).first().click();
  await dialog.getByLabel('Attendee list').fill(roster);
  await dialog.getByRole('button', { name: 'Import and rank' }).click();

  const jamie = page.getByRole('row', { name: /Jamie Lee/ });
  const taylor = page.getByRole('row', { name: /Taylor Chen/ });
  const morgan = page.getByRole('row', { name: /Morgan Diaz/ });
  await expect(jamie).toContainText('Direct ICP');
  await expect(taylor).toContainText('Could introduce me');
  await expect(morgan).toContainText('Low relevance');
  await expect(page.locator('tbody tr').first()).toContainText('Jamie Lee');
  await page.getByRole('button', { name: 'Write drafts' }).click();
  await expect(page.getByRole('status')).toContainText('Wrote 2 outreach drafts.');
  await jamie.getByRole('button', { name: 'Open Jamie Lee' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Draft', exact: true })).toHaveValue(/Hey Jamie,.*Oasis Simulations/s);
  await dialog.getByRole('textbox', { name: 'Subject', exact: true }).fill('Meet at the commissioning forum?');
  await dialog.getByRole('checkbox', { name: /I confirmed this address/ }).check();
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(jamie).toContainText('Draft ready');
  await page.reload();
  await jamie.getByRole('button', { name: 'Open Jamie Lee' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Subject', exact: true })).toHaveValue('Meet at the commissioning forum?');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await morgan.getByRole('button', { name: 'Open Morgan Diaz' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Draft', exact: true })).toHaveValue('');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();

  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await dialog.getByRole('button', { name: 'Preview batch' }).click();
  await expect(dialog.getByRole('heading', { name: 'Review your batch' })).toBeVisible();
  await expect(dialog.getByText('Jamie Lee')).toBeVisible();
  await dialog.getByText('Jamie Lee').click();
  await expect(dialog.getByText('Meet at the commissioning forum?')).toBeVisible();
  await dialog.getByRole('button', { name: 'Connect Gmail' }).click();
  await expect(page.getByRole('heading', { name: 'Connections', exact: true })).toBeVisible();
  await expect(page.getByText('http://127.0.0.1:4175/api/gmail/callback', { exact: true })).toBeVisible();
  const apollo = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Apollo', exact: true }) });
  await apollo.getByText('API key fallback', { exact: true }).click();
  await apollo.getByRole('button', { name: 'Add key' }).click();
  await apollo.getByLabel('Apollo API key').fill('test-key-only-example');
  await apollo.getByRole('button', { name: 'Save key' }).click();
  await expect(apollo.getByText('API key configured', { exact: true })).toBeVisible();
  await expect(apollo.getByLabel('Apollo API key')).toHaveCount(0);
  await apollo.getByRole('button', { name: 'Remove saved key' }).click();
  await expect(apollo.getByText(/MCP unchecked|MCP unavailable/)).toBeVisible();

  await workspace.getByRole('button', { name: 'Your ICP' }).click();
  await expect(page.getByRole('heading', { name: 'Your ICP' })).toBeVisible();
  await page.getByRole('textbox', { name: /Direct fit signals/ }).fill('bakery manager');
  await page.getByRole('button', { name: 'Save and rescore' }).click();
  await expect(page.getByRole('status')).toContainText('ICP saved and contacts rescored.');
  await page.goto(eventUrl);
  await expect(morgan).toContainText('Direct ICP');
  await expect(jamie).toContainText('Low relevance');

  await workspace.getByRole('button', { name: 'Send queue' }).click();
  await expect(page.getByRole('heading', { name: 'Send queue' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Nothing scheduled yet' })).toBeVisible();
  await page.getByRole('button', { name: /^Sent/ }).click();
  await expect(page.getByRole('heading', { name: 'No send history yet' })).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});


test('previews one mixed batch offline with one copy of the shared contact', async ({ page, request }) => {
  const profile = await request.post('/api/icp', { data: { name: 'Test', direct: ['bakery manager'] } });
  expect(profile.ok()).toBeTruthy();
  const events = [
    { title: 'North Mission Critical Week', startDate: '2099-04-12' },
    { title: 'South Mission Critical Week', startDate: '2099-04-14' },
  ];
  for (const [index, event] of events.entries()) {
    const created = await request.post('/api/conferences', { data: { input: event.title, startDate: event.startDate,
      attendees: ['Name,Title,Company,Email', `Shared Person,Bakery Manager,Example Company,shared@example.net`,
        `${index ? 'Taylor Blue' : 'Jamie Green'},Bakery Manager,Example Company,unique-${index + 1}@example.net`].join('\n') } });
    expect(created.ok()).toBeTruthy();
    const { conferenceId, snapshot } = await created.json();
    for (const person of snapshot.conferences.find(candidate => candidate.id === conferenceId).contacts) {
      const confirmed = await request.post(`/api/conferences/${conferenceId}/contacts/${person.id}`, { data: { email: person.email, confirmEmail: true } });
      expect(confirmed.ok()).toBeTruthy();
    }
  }

  await page.goto('/');
  await page.getByRole('button', { name: 'Schedule next batch' }).click();
  const dialog = page.getByRole('dialog');
  for (const event of events) await expect(dialog.getByRole('checkbox', { name: new RegExp(event.title) })).toBeChecked();
  await dialog.getByRole('button', { name: 'Preview batch' }).click();
  await expect(dialog.getByRole('heading', { name: 'Review your batch' })).toBeVisible();
  await expect(dialog.getByText('3 emails across 2 conferences')).toBeVisible();
  await expect(dialog.getByText('Shared Person', { exact: true })).toHaveCount(1);
  await expect(dialog.getByText('1 overlapping or already covered roster entry skipped.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Connect Gmail' })).toBeVisible();
  const saved = await (await request.get('/api/workspace')).json();
  expect(saved.queue).toEqual([]);
});
