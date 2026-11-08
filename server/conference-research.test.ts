import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import https, { type RequestOptions } from "node:https";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import {
  checkApolloMcpEnrichment, enrichApollo, parseAttendeeList, planApolloMcpEnrichment, pollApolloWaterfall,
  pollAutumnDiscovery, pollAutumnEnrichment, replyAutumn, researchConference, scoreContact, startAutumnDiscovery,
  submitApolloWaterfall, type ResearchContact, type ResearchMcp,
} from "./conference-research";

test("preserves quoted CSV fields, deduplicates names by employer, and marks imported addresses unverified", () => {
  const rows = parseAttendeeList([
    "First Name,Last Name,Job Title,Employer,Work Email,Attendance,Session Title",
    'Ana,Casey,"Director, Commissioning",Sample Engineering,ana@sample-engineering.com,Speaker,Test readiness',
    "Ana,Casey,,Sample Engineering,,,",
    "Ana,Casey,Operations Lead,Other Company,,Unconfirmed,",
  ].join("\n"));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, "Director, Commissioning");
  assert.equal(rows[0].attendance, "speaker");
  assert.equal(rows[0].sessionTitle, "Test readiness");
  assert.equal(rows[0].emailStatus, "unverified");
  assert.equal(rows[1].attendance, "unconfirmed");
});

test("uses target-account role fit and ignores email availability in scoring", () => {
  const icp = { accounts: ["Example & Company"], direct: ["commissioning"], connector: ["data center"] };
  const lead = { name: "Ana Casey", company: "Example and Company, LLC", title: "Director of Commissioning", attendance: "speaker" as const };
  const result = scoreContact(lead, icp);
  assert.equal(result.bucket, "direct");
  assert.equal(result.score, 88);
  assert.deepEqual(scoreContact({ ...lead, email: "ana@company.com", emailStatus: "verified" }, icp), result);
  assert.equal(scoreContact({ ...lead, title: "Director of Marketing" }, icp).bucket, "connector");
  assert.equal(scoreContact({ ...lead, company: "Catering Co", title: "Chef" }, icp).bucket, "irrelevant");
});

test("blocks private and metadata URLs while preserving user-provided contacts", async () => {
  for (const url of ["http://2130706433", "http://169.254.169.254", "http://[::ffff:127.0.0.1]", "https://localhost", "file:///etc/passwd"]) {
    const result = await researchConference({ url, attendees: "Ana Casey | Director | Example" }, { exaKey: "" });
    assert.equal(result.contacts.length, 1);
    assert.equal(result.sources.length, 0);
    assert.match(result.notes.join(" "), /public HTTP or HTTPS/);
    assert.equal(result.needsRoster, false);
  }
});

test("Apollo accepts verified work addresses for matched identities and does not repeat completed checks", async ({ mock }) => {
  const contacts: ResearchContact[] = [
    { name: "Ana Casey", company: "Sample Engineering", attendance: "attendee", email: "uncertain@example.com", emailStatus: "unverified" },
    { name: "Mina Sample", company: "Sample Engineering", attendance: "attendee" },
    { name: "Test Account", company: "Sample Engineering", attendance: "attendee", apolloChecked: true },
  ];
  const provider = mock.method(globalThis, "fetch", async (input: URL) => {
    const name = input.searchParams.get("name");
    assert.equal(input.searchParams.get("reveal_personal_emails"), "false");
    assert.equal(input.searchParams.get("reveal_phone_number"), "false");
    return Response.json({
      match_confidence: "high",
      person: { name, title: "Commissioning Director", organization: { name: name === "Ana Casey" ? "Sample Engineering" : "Other Company" },
        email: "ana@sample-engineering.com", email_status: "verified" },
    });
  });
  const result = await enrichApollo(contacts, { key: "test" });
  assert.equal(provider.mock.callCount(), 2);
  assert.equal(result.contacts[0].email, "ana@sample-engineering.com");
  assert.equal(result.contacts[0].emailStatus, "verified");
  assert.equal(result.contacts[1].email, undefined);
  assert.equal(result.contacts[1].apolloChecked, true);
});

test("Autumn requires evidence URLs for contacts and claims, preserving the roster's attendance classification", async ({ mock }) => {
  const rows = [
    {
      name: { value: "Ana Casey" }, company: { value: "Sample Engineering" }, attendance: { value: "speaker", source_id: "agenda" },
      hook: { value: "She spoke about field readiness", source_id: "agenda" },
      email: { value: "ana@sample-engineering.com" },
      _sources: { agenda: "https://event.example.com/speakers" },
    },
    { name: { value: "No Evidence" }, attendance: { value: "attendee" } },
  ];
  mock.method(globalThis, "fetch", async (input: string) => Response.json(input.includes("/output?")
    ? { rows } : { state: "completed", done: true }));
  const discovery = await pollAutumnDiscovery("test-id", "test");
  assert.equal(discovery.contacts.length, 1);
  assert.equal(discovery.contacts[0].sourceUrl, "https://event.example.com/speakers");
  assert.equal(discovery.contacts[0].email, undefined);
  assert.equal(discovery.needsRoster, true);
  const enriched = await pollAutumnEnrichment<ResearchContact>("test-id", [
    { name: "Ana Casey", company: "Sample Engineering", attendance: "unconfirmed" },
  ], "test");
  assert.equal(enriched.contacts[0].attendance, "unconfirmed");
  assert.equal(enriched.contacts[0].hook, "She spoke about field readiness");
  assert.equal(enriched.contacts[0].email, undefined);
});

test("Exa MCP accepts labeled text and applies the same URL and edition filters", async ({ mock }) => {
  const rest = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected fallback"); });
  let calls = 0;
  const mcp: ResearchMcp = async (provider, operation, args) => {
    assert.equal(provider, "exa");
    assert.equal(operation, "search");
    assert.match(String(args.query), /Sample Commissioning Summit 2026/);
    assert.equal(args.numResults, 8);
    calls++;
    return { content: [{ type: "text", text: [
      "Title: Sample Commissioning Summit 2025", "URL: https://example.com/2025/speakers",
      "Title: Sample Commissioning Summit 2026", "URL: http://127.0.0.1/",
    ].join("\n") }] };
  };
  const result = await researchConference({ name: "Sample Commissioning Summit 2026" }, { exaKey: "test", mcp });
  assert.equal(calls, 1);
  assert.equal(rest.mock.callCount(), 0);
  assert.deepEqual(result.sources, []);
  assert.match(result.notes[0], /no matching event pages/i);
});

test("hosted conference discovery crawls public sources and preserves attendance evidence", async (t) => {
  const hostname = "summit.example.com";
  const source = `https://${hostname}/2026`;
  const blocked = "https://private.example.com/speakers";
  const unavailable = `${source}/agenda`;
  const fixtures: Record<string, string> = {
    "/2026": `<title>Sample Commissioning Summit 2026</title><h1>Sample Commissioning Summit 2026</h1>
      <a href="/2026/speakers">Speakers</a><a href="/2025/attendees">Prior attendees</a>
      <a href="/2026/sponsors.csv">Sponsors</a>`,
    "/2026/speakers": `<title>Speakers</title><script type="application/ld+json">
      {"@type":"Event","startDate":"2026-11-17","speaker":{"@type":"Person","name":"Ana Casey",
       "jobTitle":"Commissioning Director","worksFor":{"name":"Sample Engineering"}}}
      </script>`,
    "/2026/sponsors.csv": "Name,Title,Company\nJamie Lee,Director,Example Company",
    "/2026/agenda": "",
  };
  const lookup = t.mock.method(dns, "lookup", async (host: string) => {
    return [{ address: host === hostname ? "93.184.216.34" : "10.0.0.10", family: 4 }];
  });
  const get = t.mock.method(https, "get", (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    assert.equal(url.hostname, hostname);
    assert.ok(Object.hasOwn(fixtures, url.pathname));
    options.lookup?.(hostname, {}, (error, address) => {
      assert.equal(error, null);
      assert.equal(address, "93.184.216.34");
    });
    const response = Object.assign(new EventEmitter(), {
      statusCode: url.href === unavailable ? 403 : 200,
      headers: { "content-type": url.pathname.endsWith(".csv") ? "text/csv" : "text/html" },
      resume() {},
    }) as IncomingMessage;
    queueMicrotask(() => {
      callback(response);
      response.emit("data", Buffer.from(fixtures[url.pathname]));
      response.emit("end");
    });
    return new EventEmitter();
  });
  syncBuiltinESMExports();
  t.after(() => {
    lookup.mock.restore();
    get.mock.restore();
    syncBuiltinESMExports();
  });

  const result = await researchConference({ name: "Sample Commissioning Summit 2026", url: source }, {
    hosted: true,
    mcp: async () => ({ results: [
      { title: "Sample Commissioning Summit 2026", url: blocked },
      { title: "Sample Commissioning Summit 2026 sponsors", url: `${source}/sponsors.csv` },
      { title: "Sample Commissioning Summit 2026 agenda", url: unavailable },
    ] }),
  });
  assert.equal(get.mock.callCount(), 4);
  assert.equal(result.needsRoster, true);
  assert.deepEqual(result.contacts.map(({ name, attendance, sourceUrl }) => ({ name, attendance, sourceUrl })).sort((a, b) => a.name.localeCompare(b.name)), [
    { name: "Ana Casey", attendance: "speaker", sourceUrl: `${source}/speakers` },
    { name: "Jamie Lee", attendance: "unconfirmed", sourceUrl: `${source}/sponsors.csv` },
  ]);
  assert.ok(result.sources.some(item => item.url === unavailable));
  assert.ok(!result.sources.some(item => item.url === blocked));
});

test("Apollo MCP checks capability once, requires exact approval, and reports credits for verified matches", async () => {
  const contacts: ResearchContact[] = [{ name: "Ana Casey", company: "Sample Engineering", attendance: "attendee" }];
  const calls: string[] = [];
  let conversationRef: unknown;
  const mcp: ResearchMcp = async (provider, operation, args) => {
    assert.equal(provider, "apollo");
    calls.push(operation);
    if (operation === "profile") {
      assert.equal(args.include_waterfall_capability, true);
      conversationRef = args._conversation_ref;
      return { structuredContent: { profile: { waterfall_email_enabled: false } } };
    }
    assert.equal(operation, "peopleMatch");
    assert.equal(args._conversation_ref, conversationRef);
    assert.equal(args.reveal_phone_number, false);
    assert.equal(args.reveal_personal_emails, false);
    assert.equal(args.run_waterfall_email, false);
    const payload = {
      person: { name: "Ana Casey", organization: { name: "Sample Engineering" }, email: "ana@sample-engineering.com", email_status: "verified" },
      mcp_credits: { estimated: { total_credits: 1 }, spent: { status: "charged", total_credits: 1 }, balance_after: 1200 },
    };
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  };
  await checkApolloMcpEnrichment(mcp);
  await assert.rejects(enrichApollo(contacts, { mcp, mcpCreditLimit: 2 }), /approve the exact Apollo batch/i);
  assert.deepEqual(calls, ["profile"]);
  const result = await enrichApollo(contacts, { mcp, mcpCreditLimit: 1 });
  assert.deepEqual(calls, ["profile", "peopleMatch"]);
  assert.equal(result.contacts[0].emailStatus, "verified");
  assert.match(result.notes.join(" "), /1,200 credits remaining/);
});

test("Apollo MCP blocks the standard batch if the account requires waterfall email enrichment", async () => {
  const mcp: ResearchMcp = async (_provider, operation) => {
    assert.equal(operation, "profile");
    return { structuredContent: { waterfall_email_enabled: true } };
  };
  await assert.rejects(enrichApollo([{ name: "Ana Casey", company: "Sample Engineering", attendance: "attendee" }], {
    mcp, mcpCreditLimit: 1,
  }), /requires waterfall email enrichment/);
});

test("Apollo waterfall quotes real historical metadata and polls the exact durable request ID", async () => {
  const contact: ResearchContact = { name: "Ana Casey", company: "Sample Engineering", attendance: "attendee" };
  const requestId = "-1783604882614419382";
  const calls: string[] = [];
  let polls = 0;
  const mcp: ResearchMcp = async (provider, operation, args) => {
    assert.equal(provider, "apollo");
    calls.push(operation);
    if (operation === "profile") return { structuredContent: { waterfall_email_enabled: true } };
    if (operation === "peopleMatch") {
      assert.equal(args.run_waterfall_email, true);
      assert.equal(args.run_waterfall_phone, false);
      assert.equal(args.reveal_phone_number, false);
      assert.equal(args.reveal_personal_emails, false);
      return { structuredContent: {
        person: { id: "apollo-person", name: "Ana Casey", organization: { name: "Sample Engineering" } },
        request_id: Number(requestId), request_id_str: requestId,
        waterfall: { status: "accepted" },
        mcp_credits: { estimated: { add_ons: [
          { name: "waterfall_email", status: "expected", per_contact: 2.5, max_per_contact: 8 },
        ] }, spent: { status: "pending" } },
      } };
    }
    assert.equal(operation, "webhookResult");
    assert.equal(args.request_id, requestId);
    polls++;
    if (polls === 1) return { isError: true, content: [{ type: "text", text: '{"error_code":"result_pending","error_details":{"retry_after_seconds":25}}' }] };
    return { structuredContent: {
      request_id: requestId, webhook_status: "skipped",
      webhook_result: {
        status: "success", credits_consumed: 3, people: [{
          id: "apollo-person", emails: [
            { email: "Ana@sample-engineering.com", email_status_cd: "Verified", position: 4 },
            { email: "ana@another-domain.com", email_status_cd: "extrapolated", position: 1 },
            { email: "ana@sample.net", email_status_cd: "verified", position: 6 },
            { email: "ana@gmail.com", email_status_cd: "Verified", position: 0 },
            { email: "info@sample-engineering.com", email_status_cd: "Verified", position: 0 },
          ],
        }],
      },
    } };
  };
  const initial = await planApolloMcpEnrichment(mcp, 2);
  assert.equal(initial.mode, "waterfall");
  assert.match(initial.confirmation, /typical cost of 1–4 credits per contact/);
  assert.match(initial.confirmation, /some vendors charge even without finding an email/);
  assert.deepEqual(calls, ["profile"]);
  const submitted = await submitApolloWaterfall(contact, mcp);
  assert.equal(submitted.status, "pending");
  assert.equal(submitted.requestId, requestId);
  assert.equal(submitted.personId, "apollo-person");
  assert.match(submitted.notes.join(" "), /charge pending/);
  const historical = await planApolloMcpEnrichment(mcp, 2);
  assert.match(historical.confirmation, /previously estimated 2.5 credits per contact \(5 credits/);
  assert.match(historical.confirmation, /16 credits in additional waterfall charges/);
  const request = { requestId, personId: submitted.personId };
  const pending = await pollApolloWaterfall(contact, request, mcp);
  assert.equal(pending.status, "pending");
  assert.equal(pending.retryAfterSeconds, 25);
  const finished = await pollApolloWaterfall(contact, request, mcp);
  assert.equal(finished.status, "completed");
  assert.equal(finished.creditsUsed, 3);
  assert.equal(finished.contact.email, "Ana@sample-engineering.com");
  assert.deepEqual(finished.addresses.map(({ status }) => status), ["extrapolated", "verified", "verified"]);
  assert.deepEqual(calls, ["profile", "peopleMatch", "webhookResult", "webhookResult"]);
});

test("Apollo waterfall treats missing submission receipts as uncertain and does not retry a paid request", async () => {
  let submitted = 0;
  const mcp: ResearchMcp = async (_provider, operation) => {
    if (operation === "profile") return { waterfall_email_enabled: true };
    assert.equal(operation, "peopleMatch");
    submitted++;
    throw new Error("Transport timed out after dispatch");
  };
  const result = await submitApolloWaterfall({ name: "Ana Casey", company: "Sample Engineering", attendance: "attendee" }, mcp);
  assert.equal(result.status, "uncertain");
  assert.equal(submitted, 1);
  assert.match(result.notes.join(" "), /Check Apollo's enrichment history/);
});

test("Apollo waterfall does not attach an address from an unconfirmed identity or an expired request", async () => {
  const contact: ResearchContact = { name: "Ana Casey", company: "Sample Engineering", attendance: "attendee" };
  const requestId = "1039995589705121975";
  const mcp: ResearchMcp = async () => ({
    status: "success", people: [{ id: "another-person", emails: [{ email: "ana@sample-engineering.com", email_status_cd: "verified" }] }],
  });
  const unrelated = await pollApolloWaterfall(contact, { requestId, personId: "original-person" }, mcp);
  assert.equal(unrelated.status, "completed");
  assert.equal(unrelated.contact.email, undefined);
  assert.equal(unrelated.addresses.length, 0);
  const expired: ResearchMcp = async () => ({ isError: true, structuredContent: { error: { error_code: "request_id_expired" } } });
  const result = await pollApolloWaterfall(contact, { requestId }, expired);
  assert.equal(result.status, "failed");
  assert.match(result.notes.join(" "), /30-day result window/);
});

test("Autumn MCP preserves clarification, resumes the same task, and imports sourced rows across pages", async () => {
  let answered = false;
  const operations: string[] = [];
  const connector = { mcp: (async (provider, operation, args) => {
    assert.equal(provider, "autumn");
    operations.push(operation);
    if (operation === "research") {
      assert.match(String(args.prompt), /Sample Commissioning Summit/);
      assert.match(String(args.prompt), /attendance_source, session_title/);
      assert.match(String(args.prompt), /Prefer commissioning leads/);
      return { content: [{ type: "text", text: '{"task_id":"test-job","state":"submitted"}' }] };
    }
    assert.equal(args.task_id, "test-job");
    if (operation === "getTask") {
      assert.equal(args.wait_seconds, 0);
      return { structuredContent: answered ? { done: true, state: "completed" }
        : { done: true, state: "input-required", message: "Which city is the event in?" } };
    }
    if (operation === "reply") {
      assert.equal(args.message, "Austin, Texas");
      answered = true;
      return { structuredContent: { state: "working" } };
    }
    assert.equal(operation, "getRows");
    const row = { name: "Ana Casey", attendance: "speaker", attendance_source: "https://sample.example.com/speakers" };
    return { structuredContent: args.cursor ? { rows: [{ name: "Mina Sample", attendance: "attendee" }] }
      : { rows: [row], next_cursor: "page-2" } };
  }) satisfies ResearchMcp };
  const { taskId } = await startAutumnDiscovery({ name: "Sample Commissioning Summit", notes: "Prefer commissioning leads" }, connector);
  const clarification = await pollAutumnDiscovery(taskId, connector);
  assert.equal(clarification.state, "input-required");
  assert.equal(clarification.message, "Which city is the event in?");
  await replyAutumn(taskId, "Austin, Texas", connector);
  const completed = await pollAutumnDiscovery(taskId, connector);
  assert.deepEqual(completed.contacts.map((contact) => contact.name), ["Ana Casey"]);
  assert.deepEqual(operations, ["research", "getTask", "reply", "getTask", "getRows", "getRows"]);
});
