import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { callResearchMcp, checkResearchMcp, closeResearchMcp, startResearchMcpLogin } from './research-mcp';

test('scopes Codex research, negotiates an ephemeral thread, and starts OAuth without exposing credentials', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'conference-research-mcp-'));
  const binary = join(folder, 'codex');
  const auditPath = join(folder, 'trace.jsonl');
  const savedBin = process.env.CODEX_BIN;
  const savedKey = process.env.APOLLO_API_KEY;
  process.env.CODEX_BIN = binary;
  process.env.APOLLO_API_KEY = 'fixture-private-key';
  try {
    await writeFile(binary, `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const args = process.argv.slice(2);
const audit = event => appendFileSync(${JSON.stringify(auditPath)}, JSON.stringify(event) + '\\n');
audit({ args, leakedEnvironment: Boolean(process.env.APOLLO_API_KEY) });
if (args[0] === 'mcp') {
  process.stdout.write(JSON.stringify([
    { name: 'exa', enabled: true, transport: { type: 'streamable_http', url: 'https://mcp.exa.ai/mcp?api_key=fixture-url-secret' } },
    { name: 'notion', enabled: true, transport: { type: 'streamable_http', url: 'https://mcp.notion.com/mcp' } },
    { name: 'autumn', enabled: false, transport: { type: 'streamable_http', url: 'https://api.autumn.ai/mcp' } }
  ]));
} else {
  const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
  const isApollo = args.some(arg => arg.includes('https://mcp.apollo.io/mcp'));
  let initialized = false;
  let apolloChecks = 0;
  createInterface({ input: process.stdin }).on('line', line => {
    const frame = JSON.parse(line);
    audit({ frame, isApollo });
    if (frame.method === 'initialized') { initialized = true; return; }
    if (!frame.method) return;
    let result = {};
    if (frame.method === 'mcpServerStatus/list' && initialized) {
      const stages = [
        { name: 'apollo', authStatus: 'notLoggedIn', tools: {} },
        { name: 'apollo', authStatus: 'oAuth', tools: { apollo_users_api_profile: {} } },
        { name: 'apollo', authStatus: 'oAuth', tools: { apollo_users_api_profile: {}, apollo_people_match: {} } },
        { name: 'apollo', authStatus: 'oAuth', tools: { apollo_users_api_profile: {}, apollo_people_match: {}, apollo_webhook_result_show: {} } },
      ];
      result = { data: isApollo ? [stages[Math.min(apolloChecks++, stages.length - 1)]] : [
        { name: 'exa', authStatus: 'notLoggedIn', tools: { web_search_exa: {}, web_fetch_exa: {} } },
        { name: 'notion', authStatus: 'unsupported', tools: {} }
      ] };
    } else if (frame.method === 'thread/start' && initialized) {
      result = { thread: { id: 'ephemeral-fixture' } };
    } else if (frame.method === 'mcpServer/tool/call' && initialized) {
      if (frame.params.tool === 'apollo_webhook_result_show') {
        result = { isError: true, structuredContent: { error_code: 'result_pending', retry_after_seconds: 15 }, content: [] };
      } else if (frame.params.tool === 'apollo_people_match' && frame.params.arguments.run_waterfall_email) {
        result = { isError: true, structuredContent: { error_code: 'waterfall_rejected' }, content: [] };
      } else if (frame.params.tool === 'apollo_people_match') {
        result = { content: [{ type: 'text', text: 'sample work match' }] };
      } else {
        send({ id: 'provider-input', method: 'mcpServer/elicitation/request', params: {} });
        result = { content: [{ type: 'text', text: 'sample search result' }] };
      }
    } else if (frame.method === 'mcpServer/oauth/login' && initialized) {
      result = { authorizationUrl: 'https://accounts.apollo.io/authorize?state=fixture', loginId: 'test-login' };
    }
    send({ id: frame.id, result });
  });
}
`, { mode: 0o700 });

    const status = await checkResearchMcp('exa');
    assert.deepEqual(status, { configured: true, connected: true, authStatus: 'notLoggedIn', tools: ['web_search_exa'], message: undefined });
    assert.deepEqual(await callResearchMcp('exa', 'search', { query: 'test events', objective: 'Find event pages' }),
      { content: [{ type: 'text', text: 'sample search result' }] });
    await assert.rejects(() => callResearchMcp('exa', 'peopleMatch', {}), /outside the research allowlist/);
    const autumn = await checkResearchMcp('autumn');
    assert.equal(autumn.configured, false);
    assert.equal(autumn.connected, false);
    await assert.rejects(() => callResearchMcp('apollo', 'peopleMatch', { reveal_phone_number: true }), /work-email matching only/);
    await assert.rejects(() => callResearchMcp('apollo', 'peopleMatch', { run_waterfall_email: true, webhook_url: 'https://untrusted.test' }), /work-email matching only/);
    await assert.rejects(() => callResearchMcp('apollo', 'webhookResult', {}), /valid waterfall request ID/);
    const apollo = await checkResearchMcp('apollo');
    assert.equal(apollo.authStatus, 'notLoggedIn');
    assert.equal(apollo.connected, false);
    const authLink = { authorizationUrl: 'https://accounts.apollo.io/authorize?state=fixture', loginId: 'test-login' };
    assert.deepEqual(await Promise.all([startResearchMcpLogin('apollo'), startResearchMcpLogin('apollo')]), [authLink, authLink]);
    const partial = await checkResearchMcp('apollo');
    assert.equal(partial.authStatus, 'oAuth');
    assert.equal(partial.connected, false);
    assert.deepEqual(partial.tools, ['apollo_users_api_profile']);
    assert.match(partial.message || '', /did not advertise people enrichment/);

    const standard = await checkResearchMcp('apollo');
    assert.equal(standard.connected, true);
    assert.deepEqual(standard.waterfallEmail, { pollAvailable: false, needsReauthorization: true });
    assert.deepEqual(await callResearchMcp('apollo', 'peopleMatch', { name: 'Fixture Contact' }),
      { content: [{ type: 'text', text: 'sample work match' }] });
    await assert.rejects(() => callResearchMcp('apollo', 'peopleMatch', { run_waterfall_email: true }), /Reauthorize Apollo/);
    await assert.rejects(() => callResearchMcp('apollo', 'webhookResult', { request_id: 'fixture-request' }), /Reauthorize Apollo/);

    const upgraded = await checkResearchMcp('apollo');
    assert.equal(upgraded.connected, true);
    assert.deepEqual(upgraded.waterfallEmail, { pollAvailable: true, needsReauthorization: false });
    assert.deepEqual(await callResearchMcp('apollo', 'peopleMatch', { name: 'Fixture Contact', run_waterfall_email: true }),
      { isError: true, structuredContent: { error_code: 'waterfall_rejected' }, content: [] });
    assert.deepEqual(await callResearchMcp('apollo', 'webhookResult', { request_id: 'fixture-request' }),
      { isError: true, structuredContent: { error_code: 'result_pending', retry_after_seconds: 15 }, content: [] });

    const trace = await readFile(auditPath, 'utf8');
    assert.ok(!trace.includes('fixture-private-key') && !trace.includes('fixture-url-secret'));
    const entries = trace.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(entries.every(entry => !entry.leakedEnvironment));
    const exa = entries.find(entry => entry.args?.[0] === 'app-server' &&
      !entry.args.some((arg: string) => arg.includes('mcp.apollo.io')));
    assert.ok(exa.args.some((arg: string) => arg.includes('"notion"={ enabled=false }')));
    assert.ok(exa.args.some((arg: string) => arg.includes('"autumn"={ enabled=false }')));
    const thread = entries.find(entry => entry.frame?.method === 'thread/start').frame;
    assert.equal(thread.params.ephemeral, true);
    assert.equal(thread.params.approvalPolicy, 'never');
    assert.equal(thread.params.sandbox, 'read-only');
    const tool = entries.find(entry => entry.frame?.method === 'mcpServer/tool/call').frame;
    assert.deepEqual(tool.params, {
      threadId: 'ephemeral-fixture', server: 'exa', tool: 'web_search_exa',
      arguments: { query: 'test events', objective: 'Find event pages' },
    });
    assert.ok(!entries.some(entry => entry.frame?.method === 'turn/start'));
    const logins = entries.filter(entry => entry.frame?.method === 'mcpServer/oauth/login');
    assert.equal(logins.length, 1);
    assert.deepEqual(logins[0].frame.params.scopes, ['read_user_profile', 'people_match', 'webhook_result_read']);
    const apolloServer = entries.find(entry => entry.args?.[0] === 'app-server' &&
      entry.args.some((arg: string) => arg.includes('mcp.apollo.io')));
    assert.ok(apolloServer.args.some((arg: string) => arg.includes('scopes=["read_user_profile","people_match","webhook_result_read"]')));
    assert.equal(entries.find(entry => entry.frame?.id === 'provider-input' && entry.frame.error)?.frame.error.code, -32601);
    const apolloCalls = entries.filter(entry => entry.frame?.method === 'mcpServer/tool/call' && entry.isApollo);
    assert.deepEqual(apolloCalls.map(entry => entry.frame.params.tool),
      ['apollo_people_match', 'apollo_people_match', 'apollo_webhook_result_show']);
  } finally {
    closeResearchMcp();
    if (savedBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = savedBin;
    if (savedKey === undefined) delete process.env.APOLLO_API_KEY;
    else process.env.APOLLO_API_KEY = savedKey;
    await rm(folder, { recursive: true, force: true });
  }
});
