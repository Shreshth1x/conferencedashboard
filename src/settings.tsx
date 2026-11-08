import { useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Cable, Check, CircleHelp, KeyRound, Mail, RefreshCw, Search, Sparkles, Target, Users } from 'lucide-react';
import { api } from './api';
import { defaultGmailCallback } from './gmail-connect';
import { BucketBadge, External } from './components';
import { type ICP, type Snapshot, gmailDraftsUrl } from './model';

type SettingsProps = {
  snapshot: Snapshot;
  refresh: (snapshot: Snapshot) => void;
  notify: (message: string, kind?: 'success' | 'error') => void;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Try again.';
}

function ConnectionStatus({ ready, children }: { ready: boolean; children: ReactNode }) {
  return <span className={`connection-status ${ready ? 'ready' : ''}`}><span className="dot"/>{children}</span>;
}

function ConnectionHeader({ icon, tone, title, detail, ready, status }: {
  icon: ReactNode;
  tone: string;
  title: string;
  detail: string;
  ready: boolean;
  status: string;
}) {
  return <div className="connection-row">
    <span className={`event-mark ${tone}`}>{icon}</span>
    <div className="connection-meta"><h3>{title}</h3><p>{detail}</p></div>
    <ConnectionStatus ready={ready}>{status}</ConnectionStatus>
  </div>;
}

const providers = [
  { id: 'apollo', label: 'Apollo', detail: 'Find work emails for your shortlisted contacts.', tone: 'yellow', icon: Users },
  { id: 'autumn', label: 'Autumn', detail: 'Research public conference rosters and enrich target contacts.', tone: 'rose', icon: Sparkles },
  { id: 'exa', label: 'Exa', detail: 'Search the web for event pages and evidence of attendance.', tone: 'blue', icon: Search },
] as const;

const mcpStatusLabel = {
  connected: 'MCP connected',
  needs_login: 'Sign-in needed',
  unavailable: 'MCP unavailable',
  unchecked: 'MCP unchecked',
} as const;

function ProviderCard({ provider, snapshot, refresh, notify }: SettingsProps & { provider: (typeof providers)[number] }) {
  const [editing, setEditing] = useState(false);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState<'check' | 'connect' | 'key'>();
  const [approvalLink, setApprovalLink] = useState<string>();
  const keyConfigured = snapshot.connections[provider.id];
  const mcp = snapshot.connections.mcp?.[provider.id];
  const mcpStatus = mcp?.status ?? 'unchecked';
  const reconnect = provider.id === 'apollo' && mcpStatus === 'connected' && mcp?.canLogin;
  const canAuthorize = mcp?.canLogin && (mcpStatus !== 'connected' || reconnect);
  const status = mcpStatus === 'connected' || !keyConfigured ? mcpStatusLabel[mcpStatus] : 'API key configured';
  const Icon = provider.icon;
  const formId = `${provider.id}-key-form`;

  async function checkMcp() {
    setBusy('check');
    try {
      const { snapshot: next } = await api<{ snapshot: Snapshot }>('/connections/mcp/check', { provider: provider.id });
      refresh(next);
      const checked = next.connections.mcp?.[provider.id];
      if (checked?.status === 'connected' && !(provider.id === 'apollo' && checked.canLogin)) {
        setApprovalLink(undefined);
        notify(`${provider.label} MCP is connected.`);
      }
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      setBusy(undefined);
    }
  }

  async function connectMcp() {
    // Open the tab before awaiting the server so popup blockers see the user click.
    let approvalTab: Window | null = null;
    setApprovalLink(undefined);
    setBusy('connect');
    try {
      approvalTab = window.open('about:blank', '_blank');
      if (approvalTab) {
        approvalTab.opener = null;
        approvalTab.document.title = `Connect ${provider.label}`;
        approvalTab.document.body.textContent = `Opening ${provider.label} sign-in…`;
      }
      const { url } = await api<{ url: string }>('/connections/mcp/connect', { provider: provider.id });
      let approval: URL;
      try {
        approval = new URL(url);
        if (approval.protocol !== 'https:' || approval.username || approval.password) throw new Error();
      } catch {
        throw new Error('The provider returned an invalid authorization link. Try connecting again.');
      }
      setApprovalLink(approval.href);
      if (approvalTab && !approvalTab.closed) approvalTab.location.replace(approval.href);
    } catch (error) {
      approvalTab?.close();
      notify(errorMessage(error), 'error');
    } finally {
      setBusy(undefined);
    }
  }

  async function save(value: string) {
    setBusy('key');
    try {
      const next = await api<Snapshot>(`/connections/${provider.id}`, { key: value });
      refresh(next);
      setSecret('');
      setEditing(false);
      notify(value
        ? `${provider.label} key saved.`
        : next.connections[provider.id]
          ? 'Saved key cleared. An environment key is still configured.'
          : `${provider.label} key removed.`);
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      setBusy(undefined);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (secret.trim() && !busy) void save(secret.trim());
  }

  return <article className="panel connection-panel">
    <ConnectionHeader icon={<Icon size={20}/>} tone={provider.tone} title={provider.label} detail={provider.detail}
      ready={mcpStatus === 'connected' || keyConfigured} status={status}/>
    <div className="connection-actions">
      {canAuthorize && <button type="button" className="button primary" disabled={Boolean(busy)}
        onClick={() => { void connectMcp(); }}>
        <Cable size={15}/>{busy === 'connect' ? 'Opening sign-in…' : reconnect ? 'Reconnect with MCP' : 'Connect with MCP'}
      </button>}
      <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => { void checkMcp(); }}>
        <RefreshCw size={15}/>{busy === 'check' ? 'Checking…' : 'Check MCP connection'}
      </button>
    </div>
    {mcp?.detail && <p aria-live="polite">{mcp.detail}</p>}
    {approvalLink && canAuthorize && <p role="status"><External url={approvalLink}>Open {provider.label} approval</External> and approve access, then return here and click Check MCP connection.</p>}
    <details className="connection-setup">
      <summary>API key fallback{keyConfigured ? ' · configured' : ''}</summary>
      <div className="connection-actions">
        <button type="button" className="button secondary" aria-controls={editing ? formId : undefined} aria-expanded={editing}
          disabled={Boolean(busy)} onClick={() => { setEditing(!editing); setSecret(''); }}>
          <KeyRound size={15}/>{editing ? 'Cancel' : keyConfigured ? 'Replace key' : 'Add key'}
        </button>
        {keyConfigured && <button type="button" className="button secondary" disabled={Boolean(busy)}
          onClick={() => { void save(''); }}>Remove saved key</button>}
      </div>
      {editing && <form id={formId} className="connection-key-form" onSubmit={submit} autoComplete="off">
        <label className="field"><span>{provider.label} API key</span>
          <input value={secret} onChange={event => setSecret(event.target.value)} type="password"
            autoComplete="off" spellCheck={false} autoCapitalize="none" required minLength={10} maxLength={4096} autoFocus/>
        </label>
        <button className="button primary" disabled={Boolean(busy) || secret.trim().length < 10}>
          {busy === 'key' ? 'Saving…' : 'Save key'}
        </button>
      </form>}
    </details>
  </article>;
}

type ConnectionsProps = SettingsProps & {
  connectGmail: () => Promise<void>;
  gmailConnecting: boolean;
};

function GmailConnection({ snapshot, refresh, notify, connectGmail, gmailConnecting }: ConnectionsProps) {
  const [busy, setBusy] = useState(false);
  const { gmail, gmailConfigured, gmailRedirectUri } = snapshot.connections;
  const callback = gmailRedirectUri || defaultGmailCallback();

  async function disconnect() {
    setBusy(true);
    try {
      refresh(await api<Snapshot>('/gmail/disconnect', {}));
      notify('Gmail disconnected.');
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  return <article className="panel connection-panel">
    <ConnectionHeader icon={<Mail size={20}/>} tone="peach" title="Gmail"
      detail={gmail ?? 'Send approved drafts and track replies in your mailbox.'} ready={Boolean(gmail)}
      status={gmail ? 'Connected' : gmailConfigured ? 'Ready to connect' : 'Setup needed'}/>
    {(gmailConfigured || gmail) && <div className="connection-actions">
      {gmail && <a className="button secondary" href={gmailDraftsUrl(gmail)} target="_blank" rel="noreferrer">
        Open Gmail drafts <ArrowRight size={15}/>
      </a>}
      {gmailConfigured && <button type="button" className={`button ${gmail ? 'secondary' : 'primary'}`} disabled={busy || gmailConnecting}
        onClick={() => { void connectGmail(); }}>
        {gmailConnecting ? 'Connecting…' : gmail ? 'Reconnect Gmail' : 'Connect Gmail'}
      </button>}
      {gmail && <button type="button" className="button secondary" disabled={busy || gmailConnecting}
        onClick={() => { void disconnect(); }}>Disconnect</button>}
    </div>}
    {!gmailConfigured && <div className="connection-setup">
      <strong><CircleHelp size={16}/> Set up Google OAuth</strong>
      <ol>
        <li>Enable the Gmail API in your Google Cloud project.</li>
        <li>Create a Web application OAuth client. Add <code>{callback}</code> as an authorized redirect URI.</li>
        <li>Add <code>GMAIL_CLIENT_ID</code>, <code>GMAIL_CLIENT_SECRET</code>, and <code>GMAIL_REDIRECT_URI</code> to the local <code>.env</code> file. Restart Conference Desk and click Connect Gmail.</li>
      </ol>
      <p>For a Google OAuth app in Testing, add your mailbox as a test user. The Gmail connection expires after seven days.</p>
      <External url="https://developers.google.com/workspace/gmail/api/auth/web-server">Google’s Gmail OAuth guide</External>
    </div>}
  </article>;
}

function CodexConnection({ snapshot, refresh, notify }: SettingsProps) {
  const [busy, setBusy] = useState(false);
  const connected = snapshot.connections.codex;
  async function check() {
    setBusy(true);
    try {
      const result = await api<{ connected: boolean; snapshot: Snapshot }>('/connections/codex', {});
      refresh(result.snapshot);
      notify(result.connected ? 'Local Codex is signed in.' : 'Sign in with ChatGPT in your local Codex CLI, then check again.',
        result.connected ? 'success' : 'error');
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  }
  return <article className="panel connection-panel">
    <ConnectionHeader icon={<Sparkles size={20}/>} tone="rose" title="Local Codex"
      detail={connected ? 'Your ChatGPT sign-in is ready for draft polish.' : 'Sign in with ChatGPT in Codex to refine individual drafts.'} ready={connected}
      status={connected ? 'Signed in' : 'Optional'}/>
    <div className="connection-actions">
      <button type="button" className="button secondary" disabled={busy} onClick={() => { void check(); }}>
        {busy ? 'Checking…' : 'Check local sign-in'}
      </button>
    </div>
    {!connected && <div className="connection-setup">
      <p>Run <code>codex login</code> in Terminal and choose ChatGPT. Then click Check local sign-in. If Codex is installed in a custom location, set <code>CODEX_BIN</code> in <code>.env</code> and restart.</p>
    </div>}
  </article>;
}

export function ConnectionsView(props: ConnectionsProps) {
  return <div className="settings-stack">
    <header className="view-head">
      <div><div className="eyebrow"><Cable size={15}/> WORKSPACE</div><h1>Connections</h1>
        <p>Connect your mailbox and the tools you use to research attendees.</p></div>
    </header>
    <section className="settings-section" aria-labelledby="outreach-connections">
      <div className="section-title"><h2 id="outreach-connections">Outreach</h2></div>
      <div className="connection-list"><GmailConnection {...props}/><CodexConnection {...props}/></div>
    </section>
    <section className="settings-section" aria-labelledby="research-connections">
      <div className="section-title"><h2 id="research-connections">Research providers</h2></div>
      <p className="settings-note">Each provider manages its own access. Research and enrichment can use provider credits.</p>
      <div className="connection-list">{providers.map(provider => <ProviderCard key={provider.id} provider={provider} {...props}/>)}</div>
    </section>
  </div>;
}

function editorValues(icp: ICP) {
  return { name: icp.name, description: icp.description, direct: icp.direct.join('\n'),
    connector: icp.connector.join('\n'), accounts: icp.accounts.join('\n') };
}

function lines(value: string) {
  return [...new Set(value.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
}

function IcpEditor({ icp, refresh, notify }: Pick<SettingsProps, 'refresh' | 'notify'> & { icp: ICP }) {
  const [form, setForm] = useState(() => editorValues(icp));
  const [busy, setBusy] = useState(false);
  const direct = lines(form.direct);
  const connector = lines(form.connector);
  const accounts = lines(form.accounts);
  const changed = JSON.stringify(form) !== JSON.stringify(editorValues(icp));
  const termsValid = [direct, connector, accounts].every(terms => terms.length <= 500 && terms.every(term => term.length <= 180));

  function update(field: keyof typeof form, value: string) {
    setForm(current => ({ ...current, [field]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !changed || !form.name.trim() || !direct.length || !termsValid) return;
    setBusy(true);
    try {
      const next = await api<Snapshot>('/icp', {
        name: form.name.trim(), description: form.description.trim(), direct, connector, accounts,
      });
      refresh(next);
      setForm(editorValues(next.icp));
      notify('ICP saved and contacts rescored.');
    } catch (error) {
      notify(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  }

  return <form className="panel icp-form" onSubmit={submit}>
    <div className="section-title"><h2>Profile details</h2></div>
    <label className="field"><span>Profile name</span>
      <input value={form.name} onChange={event => update('name', event.target.value)} required maxLength={400}/>
    </label>
    <label className="field"><span>Who you want to meet</span>
      <textarea value={form.description} onChange={event => update('description', event.target.value)} rows={3} maxLength={3000}/>
    </label>
    <div className="field-row icp-rules">
      <label className="field"><span>Direct fit signals <small>{direct.length}</small></span>
        <textarea value={form.direct} onChange={event => update('direct', event.target.value)} rows={7}
          placeholder={'commissioning\ncritical facilities'} required aria-describedby="direct-fit-help"/>
        <small id="direct-fit-help">One role or company phrase per line.</small>
      </label>
      <label className="field"><span>Introduction signals <small>{connector.length}</small></span>
        <textarea value={form.connector} onChange={event => update('connector', event.target.value)} rows={7}
          placeholder={'data center construction\npartnerships'} aria-describedby="introduction-fit-help"/>
        <small id="introduction-fit-help">One adjacent role, industry, or relationship per line.</small>
      </label>
    </div>
    <label className="field"><span>Target company names and aliases <small>{accounts.length}</small></span>
      <textarea value={form.accounts} onChange={event => update('accounts', event.target.value)} rows={6}
        placeholder={'DLB Associates\nHorizon Engineering Associates'} aria-describedby="target-company-help"/>
      <small id="target-company-help">One company or alias per line. Matching an account gives the contact more weight.</small>
    </label>
    {!termsValid && <p className="settings-note" role="alert">Use up to 500 entries per list and 180 characters per entry.</p>}
    <div className="form-actions">
      <button type="button" className="button secondary" disabled={busy || !changed} onClick={() => setForm(editorValues(icp))}>Discard edits</button>
      <button className="button primary" disabled={busy || !changed || !form.name.trim() || !direct.length || !termsValid}>
        <Check size={16}/>{busy ? 'Saving…' : 'Save and rescore'}
      </button>
    </div>
  </form>;
}

export function IcpView({ snapshot, refresh, notify }: SettingsProps) {
  return <div className="settings-stack">
    <header className="view-head">
      <div><div className="eyebrow"><Target size={15}/> WORKSPACE</div><h1>Your ICP</h1>
        <p>Define the people you want to meet. Conference Desk uses these signals to rank each roster.</p></div>
    </header>
    <div className="panel icp-summary">
      <div><BucketBadge bucket="direct"/><p>People who fit your target roles and companies.</p></div>
      <div><BucketBadge bucket="connector"/><p>People who may know the right person.</p></div>
      <div><BucketBadge bucket="irrelevant"/><p>People with little evidence of a fit. They stay out of outreach.</p></div>
    </div>
    <IcpEditor key={JSON.stringify(snapshot.icp)} icp={snapshot.icp} refresh={refresh} notify={notify}/>
  </div>;
}
