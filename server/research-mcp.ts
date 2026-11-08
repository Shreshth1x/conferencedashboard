import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';

export type ResearchMcpProvider = 'apollo' | 'autumn' | 'exa';
export type ResearchMcpOperation = 'search' | 'profile' | 'peopleMatch' | 'webhookResult' | 'research' | 'getTask' | 'getRows' | 'reply';
export type ResearchMcpStatus = {
  configured: boolean;
  connected: boolean;
  authStatus: string;
  tools: string[];
  message?: string;
  waterfallEmail?: { pollAvailable: boolean; needsReauthorization: boolean };
};

type ToolMap = Partial<Record<ResearchMcpOperation, readonly string[]>>;
const tools: Record<ResearchMcpProvider, ToolMap> = {
  apollo: {
    profile: ['apollo_users_api_profile'], peopleMatch: ['apollo_people_match'],
    webhookResult: ['apollo_webhook_result_show'],
  },
  autumn: { research: ['research'], getTask: ['get_task'], getRows: ['get_rows'], reply: ['reply'] },
  exa: { search: ['web_search_exa'] },
};
const labels = { apollo: 'Apollo', autumn: 'Autumn', exa: 'Exa' } as const;
const operationLabels: Record<ResearchMcpOperation, string> = {
  search: 'web search', profile: 'profile access', peopleMatch: 'people enrichment', webhookResult: 'waterfall results',
  research: 'research tasks', getTask: 'task status', getRows: 'research results', reply: 'task clarification',
};
const providerHosts = { apollo: 'mcp.apollo.io', autumn: 'api.autumn.ai', exa: 'mcp.exa.ai' } as const;
const apolloScopes = ['read_user_profile', 'people_match', 'webhook_result_read'] as const;
const executable = () => process.env.CODEX_BIN || join(homedir(), '.local', 'bin', 'codex');
const execute = promisify(execFile);
const stdioFlags = ['app-server', '--listen', 'stdio://', '--disable', 'apps', '--disable', 'plugins', '--disable', 'hooks',
  '-c', 'web_search="disabled"', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"'];
const maxFrameChars = 8_000_000;
const loginTimeoutSeconds = 300;
const idleMilliseconds = 90_000;
const startupMilliseconds = 25_000;

function environment() {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'USERPROFILE', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'CODEX_HOME', 'SYSTEMROOT',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CODEX_CA_CERTIFICATE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validProvider(provider: ResearchMcpProvider) {
  if (!Object.hasOwn(labels, provider)) throw new Error('Choose Apollo, Autumn, or Exa.');
}

class BridgeError extends Error {
  constructor(message: string, readonly code: 'missing' | 'unavailable' | 'timeout' | 'request') {
    super(message);
  }
}

type PendingCall = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

class AppServer {
  private child: ChildProcessByStdio<Writable, Readable, null>;
  private calls = new Map<number, PendingCall>();
  private nextId = 0;
  private stopped = false;
  private lines: ReturnType<typeof createInterface>;
  onNotification?: (method: string, params: Record<string, unknown> | undefined) => void;

  constructor(args: string[], private provider: ResearchMcpProvider) {
    this.child = spawn(executable(), [...stdioFlags, ...args], {
      cwd: tmpdir(), env: environment(), stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.lines.on('line', line => this.receive(line));
    this.child.on('error', () => this.stop(new BridgeError('Codex App Server is unavailable. Check the local Codex installation.', 'unavailable')));
    this.child.on('exit', () => this.stop(new BridgeError('Codex App Server stopped. Try checking the connection again.', 'unavailable')));
    this.child.stdin.on('error', () => this.stop(new BridgeError('Codex App Server disconnected.', 'unavailable')));
    this.child.stdout.on('error', () => this.stop(new BridgeError('Codex App Server disconnected.', 'unavailable')));
  }

  get closed() { return this.stopped; }

  private receive(line: string) {
    if (this.stopped) return;
    if (line.length > maxFrameChars) {
      this.stop(new BridgeError(`${labels[this.provider]} MCP returned more data than Conference Desk can process in one request.`, 'request'));
      return;
    }
    let frame: Record<string, unknown> | undefined;
    try { frame = record(JSON.parse(line)); } catch { return; }
    if (!frame) return;

    if (typeof frame.method === 'string') {
      if (frame.id !== undefined) {
        this.write({ id: frame.id, error: { code: -32601, message: 'This client does not accept interactive tool requests.' } });
      } else {
        this.onNotification?.(frame.method, record(frame.params));
      }
      return;
    }
    if (typeof frame.id !== 'number') return;
    const call = this.calls.get(frame.id);
    if (!call) return;
    this.calls.delete(frame.id);
    clearTimeout(call.timer);
    if (frame.error) {
      call.reject(new BridgeError(`${labels[this.provider]} MCP declined the request. Check its connection or access in Connections.`, 'request'));
    } else {
      call.resolve(frame.result);
    }
  }

  private write(frame: object) {
    if (!this.stopped && this.child.stdin.writable) this.child.stdin.write(JSON.stringify(frame) + '\n');
  }

  request(method: string, params: object, timeout = startupMilliseconds): Promise<unknown> {
    if (this.stopped) return Promise.reject(new BridgeError('Codex App Server is disconnected.', 'unavailable'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => this.stop(new BridgeError(`${labels[this.provider]} MCP did not respond in time.`, 'timeout')), timeout);
      this.calls.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'conference-desk', title: 'Conference Desk', version: '1.0.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, 8_000);
    this.write({ method: 'initialized', params: {} });
  }

  stop(error = new BridgeError('The Codex App Server connection closed.', 'unavailable')) {
    if (this.stopped) return;
    this.stopped = true;
    this.lines.close();
    this.child.stdin.end();
    this.child.kill();
    for (const call of this.calls.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.calls.clear();
  }
}

type ConfiguredServer = { name: string; enabled?: boolean; transport?: { type?: string; url?: string } };

async function providerFlags(provider: ResearchMcpProvider) {
  let listed: ConfiguredServer[];
  try {
    const { stdout } = await execute(executable(), ['mcp', 'list', '--json', '--disable', 'apps', '--disable', 'plugins'],
      { cwd: tmpdir(), env: environment(), timeout: 8_000, maxBuffer: 2_000_000 });
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) throw new Error('Unexpected MCP inventory');
    listed = parsed.filter(row => typeof record(row)?.name === 'string');
  } catch {
    throw new BridgeError('Codex MCP configuration could not be read. Check the local Codex installation.', 'unavailable');
  }

  const configured = listed.find(row => row.name === provider);
  if (provider !== 'apollo') {
    if (!configured || configured.enabled === false) {
      throw new BridgeError(`Enable the ${labels[provider]} server in local Codex MCP settings.`, 'missing');
    }
    if (!officialEndpoint(configured.transport, provider)) {
      throw new BridgeError(`Point the local ${labels[provider]} MCP configuration at its official HTTPS endpoint.`, 'missing');
    }
  } else if (configured && !officialEndpoint(configured.transport, provider)) {
    throw new BridgeError('The local Apollo MCP name points to a different endpoint. Use the official Apollo server to connect it.', 'missing');
  }

  // The installed App Server may ignore serverName on inventory requests.
  // An inline TOML table disables unrelated servers before discovery or thread startup.
  const overrides = listed.filter(row => row.name !== provider)
    .map(({ name }) => `${JSON.stringify(name)}={ enabled=false }`);
  if (provider === 'apollo') {
    overrides.push(`apollo={ url="https://mcp.apollo.io/mcp", enabled=true, startup_timeout_sec=12, scopes=${JSON.stringify(apolloScopes)} }`);
  }
  return ['-c', `mcp_servers={${overrides.join(',')}}`];
}

function officialEndpoint(transport: ConfiguredServer['transport'], provider: ResearchMcpProvider) {
  try {
    const url = new URL(transport?.url || '');
    return transport?.type === 'streamable_http' && url.protocol === 'https:' && url.hostname === providerHosts[provider]
      && !url.username && !url.password;
  } catch { return false; }
}

class ProviderSession {
  private idle?: NodeJS.Timeout;
  private calls = 0;
  private authUntil = 0;
  private activeLogin?: { authorizationUrl: string; loginId?: string };
  private pendingLogin?: Promise<{ authorizationUrl: string; loginId?: string }>;
  private thread?: Promise<string>;
  private inventory?: Promise<ResearchMcpStatus>;

  constructor(readonly provider: ResearchMcpProvider, readonly rpc: AppServer) {
    rpc.onNotification = (method, params) => {
      if (method === 'mcpServer/oauthLogin/completed' && params?.name === provider) {
        this.activeLogin = undefined;
        this.authUntil = 0;
        this.thread = undefined;
        this.inventory = undefined;
        // Reconnect once OAuth has committed new credentials to the local Codex store.
        this.rpc.stop();
      }
    };
    this.armIdle();
  }

  private armIdle() {
    if (this.idle) clearTimeout(this.idle);
    if (this.calls) return;
    const interval = Math.max(idleMilliseconds, this.authUntil - Date.now() + 1_000);
    this.idle = setTimeout(() => this.rpc.stop(), interval);
    this.idle.unref();
  }

  async use<T>(task: () => Promise<T>): Promise<T> {
    this.calls++;
    this.armIdle();
    try { return await task(); }
    finally {
      this.calls--;
      this.armIdle();
    }
  }

  status(refresh = false): Promise<ResearchMcpStatus> {
    if (refresh || !this.inventory) {
      this.inventory = this.readStatus().catch(error => {
        this.inventory = undefined;
        throw error;
      });
    }
    return this.inventory;
  }

  private async readStatus(): Promise<ResearchMcpStatus> {
    const response = record(await this.rpc.request('mcpServerStatus/list', {
      serverName: this.provider, detail: 'toolsAndAuthOnly', limit: 100,
    }));
    const rows = Array.isArray(response?.data) ? response.data : [];
    const entry = rows.map(record).find(row => row?.name === this.provider);
    const names = new Set(Object.keys(record(entry?.tools) || {}));
    const advertised: string[] = [];
    const missing: string[] = [];
    for (const [operation, aliases] of Object.entries(tools[this.provider])) {
      const found = aliases.filter(name => names.has(name));
      advertised.push(...found);
      // A previously authorized standard Apollo connection still works without the poll tool.
      if (!found.length && operation !== 'webhookResult') missing.push(operationLabels[operation as ResearchMcpOperation]);
    }
    const authStatus = typeof entry?.authStatus === 'string' ? entry.authStatus : 'unknown';
    const connected = missing.length === 0;
    const message = connected ? undefined : authStatus === 'notLoggedIn' && !advertised.length
      ? `Authorize ${labels[this.provider]} in Connections.`
      : `${labels[this.provider]} MCP did not advertise ${missing.join(', ')}. Check its configuration or permissions.`;
    const pollAvailable = Boolean(tools.apollo.webhookResult?.some(name => names.has(name)));
    return {
      configured: true, connected, authStatus, tools: advertised, message,
      ...(this.provider === 'apollo' ? { waterfallEmail: { pollAvailable, needsReauthorization: connected && !pollAvailable } } : {}),
    };
  }

  threadId() {
    this.thread ||= this.rpc.request('thread/start', { cwd: tmpdir(), ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only' })
      .then(result => {
        const id = record(record(result)?.thread)?.id;
        if (typeof id !== 'string' || !id) throw new BridgeError('Codex App Server could not open a research connection.', 'unavailable');
        return id;
      })
      .catch(error => {
        this.thread = undefined;
        throw error;
      });
    return this.thread;
  }

  login() {
    if (this.activeLogin && this.authUntil > Date.now()) return Promise.resolve(this.activeLogin);
    this.pendingLogin ||= this.requestLogin().finally(() => { this.pendingLogin = undefined; });
    return this.pendingLogin;
  }

  private async requestLogin() {
    const response = record(await this.rpc.request('mcpServer/oauth/login', {
      name: this.provider, timeoutSecs: loginTimeoutSeconds,
      ...(this.provider === 'apollo' ? { scopes: apolloScopes } : {}),
    }));
    const href = typeof response?.authorizationUrl === 'string' ? response.authorizationUrl : '';
    let url: URL;
    try { url = new URL(href); } catch { throw new BridgeError('Codex did not return a usable authorization link.', 'unavailable'); }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new BridgeError('Codex did not return a usable HTTPS authorization link.', 'unavailable');
    }
    this.authUntil = Date.now() + loginTimeoutSeconds * 1000;
    this.activeLogin = { authorizationUrl: url.href, ...(typeof response?.loginId === 'string' ? { loginId: response.loginId } : {}) };
    return this.activeLogin;
  }
}

const sessions = new Map<ResearchMcpProvider, Promise<ProviderSession>>();
const opened = new Set<AppServer>();

async function getSession(provider: ResearchMcpProvider): Promise<ProviderSession> {
  validProvider(provider);
  const current = sessions.get(provider);
  if (current) {
    const session = await current;
    if (!session.rpc.closed) return session;
    opened.delete(session.rpc);
    if (sessions.get(provider) === current) sessions.delete(provider);
    return getSession(provider);
  }
  const creating = (async () => {
    const flags = await providerFlags(provider);
    const rpc = new AppServer(flags, provider);
    opened.add(rpc);
    try {
      await rpc.initialize();
      return new ProviderSession(provider, rpc);
    } catch (error) {
      rpc.stop();
      opened.delete(rpc);
      throw error;
    }
  })();
  sessions.set(provider, creating);
  try { return await creating; }
  catch (error) {
    if (sessions.get(provider) === creating) sessions.delete(provider);
    throw error;
  }
}

export async function checkResearchMcp(provider: ResearchMcpProvider): Promise<ResearchMcpStatus> {
  validProvider(provider);
  try {
    const session = await getSession(provider);
    return await session.use(() => session.status(true));
  } catch (error) {
    return {
      configured: !(error instanceof BridgeError && error.code === 'missing'), connected: false, authStatus: 'unknown', tools: [],
      message: error instanceof BridgeError ? error.message : `${labels[provider]} MCP is unavailable.`,
    };
  }
}

export async function callResearchMcp(provider: ResearchMcpProvider, operation: ResearchMcpOperation, args: Record<string, unknown>): Promise<unknown> {
  validProvider(provider);
  const allowlist = Object.hasOwn(tools[provider], operation) ? tools[provider][operation] : undefined;
  if (!allowlist || !record(args)) throw new BridgeError('This MCP operation is outside the research allowlist.', 'request');
  const waterfallMatch = provider === 'apollo' && operation === 'peopleMatch' && args.run_waterfall_email === true;
  if (provider === 'apollo' && operation === 'peopleMatch' &&
      (['reveal_personal_emails', 'reveal_phone_number', 'run_waterfall_phone', 'webhook_url'].some(key => args[key]) ||
        (args.run_waterfall_email !== undefined && typeof args.run_waterfall_email !== 'boolean'))) {
    throw new BridgeError('Conference Desk uses Apollo for work-email matching only.', 'request');
  }
  if (operation === 'webhookResult' && (typeof args.request_id !== 'string' || !args.request_id.trim() || args.request_id.length > 256)) {
    throw new BridgeError('Apollo needs a valid waterfall request ID to retrieve results.', 'request');
  }
  const session = await getSession(provider);
  return session.use(async () => {
    const status = await session.status();
    if ((waterfallMatch || operation === 'webhookResult') && !status.waterfallEmail?.pollAvailable) {
      throw new BridgeError('Reauthorize Apollo in Connections before using waterfall email enrichment.', 'request');
    }
    const name = allowlist.find(tool => status.tools.includes(tool));
    if (!name) throw new BridgeError(status.message || `${labels[provider]} MCP does not expose this research operation.`, 'request');
    const threadId = await session.threadId();
    const response = record(await session.rpc.request('mcpServer/tool/call', { threadId, server: provider, tool: name, arguments: args }, 90_000));
    const preserveWaterfallStatus = waterfallMatch || operation === 'webhookResult';
    if (!response || !Array.isArray(response.content) || (response.isError === true && !preserveWaterfallStatus)) {
      throw new BridgeError(`${labels[provider]} MCP could not complete this operation. Check its connection and access.`, 'request');
    }
    return response;
  });
}

export async function startResearchMcpLogin(provider: 'apollo' | 'autumn') {
  if (provider !== 'apollo' && provider !== 'autumn') throw new Error('This provider does not use interactive OAuth.');
  const session = await getSession(provider);
  return session.use(() => session.login());
}

export function closeResearchMcp() {
  for (const rpc of opened) rpc.stop();
  opened.clear();
  sessions.clear();
}

process.once('exit', closeResearchMcp);
