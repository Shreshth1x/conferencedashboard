import type { ApolloPreview, Conference, Contact, Provider, ResearchJob } from "../../../src/model.ts";
import { isPast, rankContacts, target } from "../../../src/model.ts";
import {
  canEnrichWithApollo, planApolloMcpEnrichment, pollApolloWaterfall, pollAutumnDiscovery, pollAutumnEnrichment, replyAutumn,
  researchConference, startAutumnDiscovery, startAutumnEnrichment, submitApolloWaterfall, scoreContact,
  type ResearchContact, type ResearchInput, type ResearchMcp,
} from "../../../server/conference-research.ts";
import type { DeskState } from "./storage.ts";
import { active, applyResearch, hosted, mergeContacts } from "./workspace.ts";
import { clean, DeskError, expire, token } from "./shared.ts";

const keyNames = { apollo: "APOLLO_API_KEY", autumn: "AUTUMN_API_KEY", exa: "EXA_API_KEY" } as const;
export const providerKey = (state: Pick<DeskState, "secrets">, provider: Provider) => state.secrets.keys?.[provider] || Deno.env.get(keyNames[provider]);

type RpcResult = { result?: unknown; error?: unknown; id?: unknown };
function mcpEnvelope(text: string, format: string): RpcResult {
  if (format.includes("application/json")) return JSON.parse(text);
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const envelope = JSON.parse(line.slice(5)) as RpcResult;
    if (envelope.id === 1) return envelope;
  }
  return {};
}
async function mcpRequest(url: string, method: string, params: object, key?: string, session?: string) {
  const headers = new Headers({ "content-type": "application/json", accept: "application/json, text/event-stream" });
  if (key) headers.set("X-Api-Key", key);
  if (session) {
    headers.set("Mcp-Session-Id", session);
    headers.set("MCP-Protocol-Version", "2025-03-26");
  }
  const response = await fetch(url, { method: "POST", headers, redirect: "error", signal: AbortSignal.timeout(12_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!response.ok) throw new DeskError("The research provider rejected the request. Check its connection and permissions.");
  const body = mcpEnvelope(await response.text(), response.headers.get("content-type") || "");
  if (body.error || !body.result) throw new DeskError("The research provider did not return a result.");
  return { value: body.result, session: response.headers.get("Mcp-Session-Id") || undefined };
}
const exaMcp: ResearchMcp = async (provider, operation, args) => {
  if (provider !== "exa" || operation !== "search") throw new DeskError("Unsupported web search operation.");
  return (await mcpRequest("https://mcp.exa.ai/mcp", "tools/call", { name: "web_search_exa", arguments: args })).value;
};
export function runConferenceSearch(state: Pick<DeskState, "secrets">, input: ResearchInput) {
  const exaKey = providerKey(state, "exa");
  return researchConference(input, { exaKey, mcp: exaKey ? undefined : exaMcp, sourceLinksOnly: true });
}

function apolloMcp(key: string): ResearchMcp {
  const url = "https://mcp.apollo.io/mcp";
  const catalog = { profile: "apollo_users_api_profile", peopleMatch: "apollo_people_match", webhookResult: "apollo_webhook_result_show" } as const;
  let ready: Promise<string | undefined> | undefined;
  return async (provider, operation, args) => {
    if (provider !== "apollo" || !Object.hasOwn(catalog, operation)) throw new DeskError("Unsupported Apollo operation.");
    ready ??= (async () => {
      const initialized = await mcpRequest(url, "initialize", { protocolVersion: "2025-03-26", capabilities: {},
        clientInfo: { name: "conference-desk", version: "1.0.0" } }, key);
      if (initialized.session) {
        const response = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "X-Api-Key": key,
            "Mcp-Session-Id": initialized.session, "MCP-Protocol-Version": "2025-03-26" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
        if (!response.ok) throw new DeskError("Could not start an Apollo MCP session.");
      }
      const listed = await mcpRequest(url, "tools/list", {}, key, initialized.session);
      const tools = (listed.value as { tools?: { name: string }[] }).tools || [];
      if (!tools.some(tool => tool.name === catalog.webhookResult)) throw new DeskError("This Apollo connection cannot retrieve waterfall results.");
      return initialized.session;
    })();
    return (await mcpRequest(url, "tools/call", { name: catalog[operation as keyof typeof catalog], arguments: args }, key, await ready)).value;
  };
}

const jobOpen = (job: ResearchJob) => job.status === "running" || job.status === "needs_input";
function autumnKey(state: DeskState) {
  const key = providerKey(state, "autumn");
  if (!key) throw new DeskError("Add an Autumn API key in Connections.");
  return { key };
}
export async function discovery(state: DeskState, event: Conference, input: Record<string, unknown>, jobId?: string, action?: string) {
  if (jobId && action === "reply") {
    const job = state.workspace.jobs.find(item => item.conferenceId === event.id && item.id === jobId && item.status === "needs_input");
    const message = clean(input.message, 4000);
    if (!job || !message) throw new DeskError("Choose a research task waiting for a reply and enter your answer.");
    await replyAutumn(jobId, message, autumnKey(state));
    job.status = "running";
    delete job.message;
  } else if (input.autumn === true) {
    if (state.workspace.jobs.some(job => job.conferenceId === event.id && job.kind === "discovery" && jobOpen(job))) {
      throw new DeskError("Autumn is already looking for attendees.");
    }
    const { taskId } = await startAutumnDiscovery({ name: event.title, url: event.url, notes: clean(input.notes, 500) }, autumnKey(state));
    state.workspace.jobs.push({ id: taskId, conferenceId: event.id, kind: "discovery", status: "running", transport: "api" });
  } else {
    applyResearch(state.workspace, event, await runConferenceSearch(state, { name: event.title, url: event.url }));
  }
}

function eligible(state: DeskState, event: Conference, provider: "apollo" | "autumn") {
  const locked = new Set(state.workspace.queue.filter(item => item.conferenceId === event.id && active(item)).map(item => item.contactId));
  const attempted = new Set(state.workspace.apolloRuns?.filter(run => run.conferenceId === event.id)
    .flatMap(run => run.recipients.filter(row => row.status !== "skipped").map(row => row.contactId)));
  return rankContacts(event.contacts).filter(person => {
    if (!target(person) || person.sentAt || person.previouslyContacted || locked.has(person.id)) return false;
    return provider === "apollo" ? !attempted.has(person.id) && canEnrichWithApollo(person) :
      !person.autumnChecked && (!person.hook || !person.hookSource || !person.email || person.emailStatus === "unverified");
  });
}

export async function enrichment(state: DeskState, event: Conference, input: Record<string, unknown>) {
  const people = eligible(state, event, "autumn").slice(0, Math.min(25, Math.max(1, Math.trunc(Number(input.limit) || 10))));
  if (!people.length) throw new DeskError("There are no eligible contacts left to enrich.");
  if (state.workspace.jobs.some(job => job.conferenceId === event.id && job.kind === "enrichment" && jobOpen(job))) {
    throw new DeskError("Autumn is already enriching this roster.");
  }
  const { taskId } = await startAutumnEnrichment(people, event.title, autumnKey(state));
  state.workspace.jobs.push({ id: taskId, conferenceId: event.id, kind: "enrichment", status: "running", transport: "api", contactIds: people.map(person => person.id) });
}

function applyEnrichment(state: DeskState, event: Conference, people: Contact[]) {
  for (const row of people) {
    const person = event.contacts.find(current => current.id === row.id);
    if (!person || person.sentAt || state.workspace.queue.some(item => item.conferenceId === event.id && item.contactId === row.id && active(item))) continue;
    for (const field of ["title", "company", "linkedin", "hook", "hookSource"] as const) if (row[field]) person[field] = row[field];
    if (row.email && person.emailStatus !== "verified" && (!person.draft?.gmailId || person.email === row.email)) {
      person.email = row.email;
      person.emailStatus = row.emailStatus;
      person.emailSource = row.emailSource;
    }
    person.apolloChecked ||= row.apolloChecked;
    person.autumnChecked ||= row.autumnChecked;
    Object.assign(person, scoreContact(person, state.workspace.icp));
  }
}
function apolloFingerprint(person: Contact) {
  return JSON.stringify([person.id, person.name, person.company, person.linkedin, person.email, person.emailStatus, person.bucket]);
}
export async function apolloAction(state: DeskState, event: Conference, input: Record<string, unknown>, preview: boolean) {
  const key = providerKey(state, "apollo");
  if (!key) throw new DeskError("Add an Apollo MCP master key in Connections.");
  const records = hosted(state).apolloPreviews ??= {};
  const candidates = eligible(state, event, "apollo").slice(0, 10);
  if (preview) {
    if (!candidates.length) throw new DeskError("There are no eligible contacts left to enrich.");
    const count = Math.min(candidates.length, Math.max(1, Math.trunc(Number(input.limit) || 1)));
    const plan = await planApolloMcpEnrichment(apolloMcp(key), count);
    if (plan.mode !== "waterfall") throw new DeskError("Enable email waterfall for this Apollo workspace.");
    const people = candidates.slice(0, count);
    const id = token();
    expire(records, item => item.expiresAt <= Date.now());
    if (Object.keys(records).length >= 20) throw new DeskError("Too many open Apollo previews.", 429);
    records[id] = { conferenceId: event.id, contactIds: people.map(person => person.id), fingerprints: people.map(apolloFingerprint), expiresAt: Date.now() + 600_000 };
    await state.save();
    return { token: id, people: people.map(person => person.company ? `${person.name} · ${person.company}` : person.name),
      mode: "waterfall", estimate: plan.confirmation, available: candidates.length } satisfies ApolloPreview;
  }
  const id = clean(input.token);
  const approval = records[id];
  const selected = approval?.contactIds.map(contactId => candidates.find(person => person.id === contactId)) || [];
  if (!approval || approval.conferenceId !== event.id || approval.expiresAt <= Date.now() || input.approvedMode !== "waterfall" ||
      selected.some((person, index) => !person || apolloFingerprint(person) !== approval.fingerprints[index])) {
    throw new DeskError("Review and approve the current Apollo batch before using credits.");
  }
  const people = selected.filter((person): person is Contact => Boolean(person));
  delete records[id];
  (state.workspace.apolloRuns ??= []).push({ id: crypto.randomUUID(), conferenceId: event.id, approvedAt: new Date().toISOString(),
    costLabel: "Apollo waterfall charges vary by source and result.",
    recipients: people.map(person => ({ contactId: person.id, name: person.name, company: person.company, linkedin: person.linkedin,
      status: "queued", fingerprint: apolloFingerprint(person), notes: [] })) });
  await state.save();
}

export function refreshApollo(state: DeskState, event: Conference, runId: string) {
  const run = state.workspace.apolloRuns?.find(item => item.id === runId && item.conferenceId === event.id);
  if (!run) throw new DeskError("Apollo run not found.", 404);
  const now = Date.now();
  for (const row of run.recipients) if (row.requestId && (row.status === "waiting" || row.status === "uncertain")) {
    row.status = "pending";
    row.nextCheckAt = now;
    row.checkUntil = now + 300_000;
  }
}

async function processApollo(state: DeskState) {
  const key = providerKey(state, "apollo");
  if (!key) return false;
  for (const run of state.workspace.apolloRuns || []) {
    const event = state.workspace.conferences.find(item => item.id === run.conferenceId);
    for (const row of run.recipients) {
      const now = Date.now();
      const current = event?.contacts.find(person => person.id === row.contactId);
      if (row.status === "submitting") {
        row.status = "uncertain";
        row.notes.push("The previous submission ended before a receipt was recorded. Review Apollo’s enrichment history.");
      } else if (row.status === "queued") {
        if (!event || !current || isPast(event) || !target(current) || !canEnrichWithApollo(current) || current.sentAt || current.previouslyContacted ||
            row.fingerprint !== apolloFingerprint(current) || state.workspace.queue.some(item => item.conferenceId === event.id && item.contactId === current.id && active(item))) {
          row.status = "skipped";
          row.notes.push("The contact changed or no longer needs a lookup.");
        } else {
          row.status = "submitting";
          await state.save();
          const result = await submitApolloWaterfall(current, apolloMcp(key));
          Object.assign(row, { status: result.status, requestId: result.requestId, personId: result.personId, creditsUsed: result.creditsUsed, notes: result.notes });
          if (result.status === "pending") {
            row.nextCheckAt = Date.now() + (result.retryAfterSeconds || 30) * 1000;
            row.checkUntil = Date.now() + 300_000;
          }
        }
      } else if (row.status === "pending" && (row.nextCheckAt ?? 0) <= now) {
        if (!row.requestId || (row.checkUntil ?? 0) <= now) {
          row.status = row.requestId ? "waiting" : "uncertain";
        } else {
          const result = await pollApolloWaterfall<ResearchContact>({ name: row.name, company: row.company, linkedin: row.linkedin, attendance: "unconfirmed" },
            { requestId: row.requestId, personId: row.personId }, apolloMcp(key));
          row.notes = [...new Set([...row.notes, ...result.notes])];
          row.creditsUsed = result.creditsUsed ?? row.creditsUsed;
          if (result.status === "pending") row.nextCheckAt = Date.now() + (result.retryAfterSeconds || 30) * 1000;
          else if (result.status === "failed") row.status = "failed";
          else {
            row.email = result.contact.email;
            row.status = row.email ? "matched" : "no_match";
            if (event && current && row.fingerprint === apolloFingerprint(current)) {
              applyEnrichment(state, event, [{ ...current, email: row.email ?? current.email,
                emailStatus: result.contact.emailStatus ?? current.emailStatus, emailSource: result.contact.emailSource ?? current.emailSource, apolloChecked: true }]);
            }
          }
        }
      } else continue;
      await state.save();
      return true;
    }
  }
  return false;
}

export async function processResearch(state: DeskState) {
  const key = providerKey(state, "autumn");
  const job = key && state.workspace.jobs.find(item => item.status === "running" && item.transport !== "mcp");
  const event = job && state.workspace.conferences.find(item => item.id === job.conferenceId);
  if (!key || !job || !event) return processApollo(state);
  try {
    if (job.kind === "discovery") {
      const result = await pollAutumnDiscovery(job.id, { key });
      if (!result.done && result.state !== "input-required") return false;
      if (result.done) {
        mergeContacts(state.workspace, event, result.contacts);
        for (const person of result.contacts) if (person.sourceUrl && !event.sources.some(source => source.url === person.sourceUrl)) {
          event.sources.push({ url: person.sourceUrl, label: person.sourceLabel || "Autumn public research" });
        }
      }
      job.message = result.message;
      job.status = result.state === "input-required" ? "needs_input" : /fail|cancel/i.test(result.state) ? "failed" : "done";
    } else {
      const people = event.contacts.filter(person => job.contactIds?.includes(person.id));
      const result = await pollAutumnEnrichment(job.id, people, { key });
      if (!result.done && result.state !== "input-required") return false;
      if (result.done) applyEnrichment(state, event, result.contacts);
      job.message = result.message;
      job.status = result.state === "input-required" ? "needs_input" : /fail|cancel/i.test(result.state) ? "failed" : "done";
    }
    await state.save();
    return true;
  } catch {
    return false;
  }
}
