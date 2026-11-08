import assert from 'node:assert/strict';
import { defaultIcp } from '../../../server/default-icp.ts';
import type { Workspace } from '../../../src/model.ts';
import { processResearch, runConferenceSearch } from './providers.ts';
import type { DeskState } from './storage.ts';
import { workspaceAction } from './workspace.ts';

function fixture(keys: DeskState['secrets']['keys']) {
  const workspace: Workspace = {
    conferences: [], queue: [], jobs: [],
    icp: { ...defaultIcp, accounts: ['Target Company'] },
  };
  let saved = structuredClone(workspace);
  const state: DeskState = {
    workspace, secrets: { mailboxes: {}, keys },
    save() { saved = structuredClone(workspace); return Promise.resolve(); },
  };
  return { state, workspace, saved: () => saved };
}

Deno.test('Hosted discovery sends public source links to the private Node crawler', async () => {
  const { state } = fixture({ exa: 'fixture-exa' });
  const site = 'https://desk.example.com/';
  const url = 'https://conference.example.com/';
  const speakers = url + 'speakers/';
  const fetch = globalThis.fetch;
  const env = { DESK_SITE_URL: site, DESK_RESEARCH_SECRET: 'fixture-crawler-secret' };
  const savedEnv = Object.keys(env).map(name => [name, Deno.env.get(name)] as const);
  for (const [name, value] of Object.entries(env)) Deno.env.set(name, value);
  let available = true;
  globalThis.fetch = (input, init) => {
    const target = new URL(String(input));
    if (target.hostname === 'api.exa.ai') {
      return Promise.resolve(Response.json({ results: [{ url: speakers, title: 'Conference speakers' }] }));
    }
    assert.equal(target.href, site + 'api/conference-sources');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-crawler-secret');
    assert.deepEqual(JSON.parse(String(init?.body)), { name: 'Conference 2027', url, seedUrls: [url, speakers] });
    return Promise.resolve(available ? Response.json({
      contacts: [{ name: 'Jamie Lee', attendance: 'speaker', sourceUrl: speakers }],
      sources: [{ url: speakers, label: 'Public speakers' }], notes: [], needsRoster: true,
    }) : new Response(null, { status: 502 }));
  };
  try {
    const input = { name: 'Conference 2027', url };
    assert.equal((await runConferenceSearch(state, input)).contacts[0]?.name, 'Jamie Lee');
    available = false;
    const fallback = await runConferenceSearch(state, input);
    assert.deepEqual(fallback.sources.map(source => source.url), [url, speakers]);
    assert.match(fallback.notes.join(' '), /crawler could not complete/);
  } finally {
    globalThis.fetch = fetch;
    for (const [name, value] of savedEnv) value === undefined ? Deno.env.delete(name) : Deno.env.set(name, value);
  }
});

Deno.test('Hosted conference discovery merges and ranks the complete available roster before starting the top ten Apollo lookups', async () => {
  const { state, workspace, saved } = fixture({ apollo: 'fixture-apollo', autumn: 'fixture-autumn', exa: 'fixture-exa' });
  const fetch = globalThis.fetch;
  const called: string[] = [];
  let autumnState = 'input-required';
  const row = (name: string, title: string, company: string) => ({
    name: { value: name }, title: { value: title }, company: { value: company },
    attendance: { value: 'speaker' }, attendance_source: { value: 'https://conference.example.com/speakers' },
  });
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.exa.ai') {
      called.push('public-search');
      return Promise.resolve(Response.json({ results: [] }));
    }
    const { id, method, params } = JSON.parse(String(init?.body));
    const result = (value: object) => Promise.resolve(Response.json({ jsonrpc: '2.0', id, result: value }));
    const structured = (value: object) => result({ structuredContent: value });
    const tool = params?.name ?? method;
    called.push(tool);
    if (url.hostname === 'api.autumn.ai') {
      assert.equal(new Headers(init?.headers).get('X-API-Key'), 'fixture-autumn');
      if (tool === 'research') {
        assert.equal(saved().jobs[0].stage, 'autumn_starting');
        assert.match(params.arguments.prompt, /2027/);
        return structured({ task_id: 'autumn-task-123' });
      }
      assert.equal(params.arguments.task_id, 'autumn-task-123');
      if (tool === 'get_task') return structured({ state: autumnState, message: autumnState === 'input-required' ? 'Which edition?' : undefined });
      if (tool === 'reply') {
        assert.equal(params.arguments.message, 'The 2027 conference.');
        autumnState = 'completed';
        return structured({ state: autumnState });
      }
      assert.equal(tool, 'get_rows');
      return structured({ rows: [
        row('Avery Best', 'Commissioning Operations Director', 'Target Company'),
        row('Pat Referral', 'Data Center Construction Director', 'Referral Co'),
        row('Jamie Lead', 'Commissioning Manager', 'Public Company'),
        { ...row('Milo Sourced', 'Commissioning Operations Director', 'Target Company'),
          email: { value: 'milo@targetcompany.com' }, email_source: { value: 'https://targetcompany.com/people/milo' } },
        ...Array.from({ length: 10 }, (_, index) => row(`Lead ${String.fromCharCode(65 + index)}`, 'Commissioning Manager', 'Public Company')),
        row('Drew Other', 'Catering Director', 'Other Company'),
      ] });
    }
    assert.equal(url.hostname, 'mcp.apollo.io');
    assert.equal(new Headers(init?.headers).get('X-API-Key'), 'fixture-apollo');
    if (method === 'initialize') return result({ protocolVersion: '2025-03-26' });
    if (method === 'tools/list') return result({ tools: [
      { name: 'apollo_users_api_profile' }, { name: 'apollo_people_match' }, { name: 'apollo_webhook_result_show' },
    ] });
    if (tool === 'apollo_users_api_profile') return structured({ waterfall_email_enabled: true });
    assert.equal(tool, 'apollo_people_match');
    assert.equal(params.arguments.name, 'Avery Best');
    assert.equal(params.arguments.run_waterfall_email, true);
    assert.equal(saved().apolloRuns?.[0].recipients[0].status, 'submitting');
    return structured({ request_id_str: '12345', waterfall: { status: 'accepted' } });
  };
  try {
    const created = await workspaceAction(state, ['conferences'], { input: 'Data Center Summit', startDate: '2027-08-25',
      attendees: 'Name,Title,Company,Email\nJamie Lead,,Public Company\nJordan Imported,Commissioning Manager,Import Company\nMilo Sourced,,Target Company,milo@targetcompany.com' });
    assert.ok(created && 'conferenceId' in created);
    const event = workspace.conferences[0];
    assert.equal(saved().conferences[0].contacts.length, 3);
    assert.deepEqual(called, []);
    assert.equal(workspace.jobs[0].stage, 'public');
    assert.equal(await processResearch(state), true);
    assert.equal(await processResearch(state), true);
    assert.equal(await processResearch(state), true);
    assert.equal(workspace.jobs[0].status, 'needs_input');
    assert.equal(workspace.apolloRuns, undefined);
    await assert.rejects(workspaceAction(state, ['conferences', event.id, 'enrich'], { provider: 'apollo' }), /attendee research to finish/);
    await workspaceAction(state, ['conferences', event.id, 'research', 'autumn-task-123', 'reply'], { message: 'The 2027 conference.' });
    assert.equal(await processResearch(state), true);
    assert.equal(event.contacts.length, 16);
    assert.equal(event.contacts.filter(person => person.name === 'Jamie Lead' && person.bucket === 'direct').length, 1);
    assert.equal(event.contacts.find(person => person.name === 'Pat Referral')?.bucket, 'connector');
    assert.equal(event.contacts.find(person => person.name === 'Drew Other')?.bucket, 'irrelevant');
    assert.equal(event.contacts.find(person => person.name === 'Milo Sourced')?.emailStatus, 'sourced');
    assert.deepEqual(called, ['public-search', 'research', 'get_task', 'reply', 'get_task', 'get_rows']);
    const run = saved().apolloRuns?.[0];
    assert.ok(run?.automatic);
    assert.equal(run.recipients.length, 10);
    assert.deepEqual(run.recipients.slice(0, 3).map(person => person.name), ['Avery Best', 'Jamie Lead', 'Jordan Imported']);
    assert.ok(!run.recipients.some(person => person.name === 'Milo Sourced'));
    assert.ok(run.recipients.every(person => person.status === 'queued'));
    assert.equal(await processResearch(state), true);
    assert.equal(saved().apolloRuns?.[0].recipients[0].requestId, '12345');
  } finally {
    globalThis.fetch = fetch;
  }
});

Deno.test('Hosted discovery uses available contacts and offers a connection fallback when research providers are missing', async () => {
  const { state, workspace, saved } = fixture({ exa: 'fixture-exa' });
  const fetch = globalThis.fetch;
  const env = ['AUTUMN_API_KEY', 'APOLLO_API_KEY'].map(key => [key, Deno.env.get(key)] as const);
  for (const [key] of env) Deno.env.delete(key);
  globalThis.fetch = () => Promise.resolve(Response.json({ results: [] }));
  try {
    await workspaceAction(state, ['conferences'], { input: 'Data Center Summit 2027',
      attendees: 'Name,Title,Company\nJordan Imported,Commissioning Manager,Import Company' });
    assert.equal(await processResearch(state), true);
    assert.equal(saved().jobs[0].status, 'done');
    assert.match(saved().jobs[0].message ?? '', /Ranked 1 contact.*Connect Apollo/);
    assert.equal(saved().apolloRuns, undefined);
    state.secrets.keys!.apollo = 'fixture-apollo';
    await workspaceAction(state, ['conferences', workspace.conferences[0].id, 'enrich'], { provider: 'apollo' });
    assert.equal(saved().apolloRuns?.[0].recipients[0].name, 'Jordan Imported');
    await assert.rejects(workspaceAction(state, ['conferences', workspace.conferences[0].id, 'enrich'], { provider: 'apollo' }),
      /no eligible contacts left/);
  } finally {
    globalThis.fetch = fetch;
    for (const [key, value] of env) if (value !== undefined) Deno.env.set(key, value);
  }
});

Deno.test('Restarting after interrupted paid submissions records ambiguity without spending twice', async () => {
  const { state, workspace, saved } = fixture({ apollo: 'fixture-apollo', autumn: 'fixture-autumn' });
  const fetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('An interrupted submission must not call a provider again'); };
  try {
    await workspaceAction(state, ['conferences'], { input: 'Data Center Summit 2027',
      attendees: 'Name,Title,Company\nJordan Imported,Commissioning Manager,Import Company' });
    const [job] = workspace.jobs;
    job.stage = 'autumn_starting';
    assert.equal(await processResearch(state), true);
    assert.equal(saved().jobs[0].status, 'failed');
    assert.match(saved().jobs[0].message ?? '', /before a task ID was saved/);
    assert.equal(saved().apolloRuns, undefined);
    await workspaceAction(state, ['conferences', workspace.conferences[0].id, 'enrich'], { provider: 'apollo' });
    workspace.apolloRuns![0].recipients[0].status = 'submitting';
    assert.equal(await processResearch(state), true);
    assert.equal(saved().apolloRuns?.[0].recipients[0].status, 'uncertain');
    assert.equal(await processResearch(state), false);
  } finally {
    globalThis.fetch = fetch;
  }
});
