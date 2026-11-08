import { GmailApiError } from "../../../server/gmail.ts";
import { beginDeskGoogleAuth, deskGmailConfig, finishDeskGoogleAuth, processDueMail, syncDueDeskMail, type DeskGoogleMode } from "./mail.ts";
import { processResearch } from "./providers.ts";
import { DeskStorageError, readDeskState, withDeskState, type DeskState } from "./storage.ts";
import { clean, DeskError, expire, hash, token } from "./shared.ts";
import { hosted, snapshot, workspaceAction } from "./workspace.ts";

const authLifetime = 7 * 86_400_000;
function site() {
  const value = Deno.env.get("DESK_SITE_URL");
  if (!value) throw new DeskError("The dashboard URL needs to be configured.", 503);
  return new URL(value);
}
const ownerEmail = () => Deno.env.get("DESK_OWNER_EMAIL")?.trim().toLowerCase();
function returnLocation(value: unknown) {
  const base = site();
  let target: URL;
  try { target = new URL(clean(value, 1024)); }
  catch { throw new DeskError("Open Conference Desk from its published dashboard URL."); }
  if (target.origin !== base.origin || target.pathname !== base.pathname || target.username || target.password) {
    throw new DeskError("Open Conference Desk from its published dashboard URL.");
  }
  target.search = "";
  if (!["", "#connections"].includes(target.hash)) target.hash = "";
  return target.toString();
}
function googleConfig() {
  const config = deskGmailConfig();
  if (!config || !ownerEmail()) throw new DeskError("Google sign-in needs to be configured.", 503);
  return config;
}
async function sessionKey(request: Request) {
  const authorization = request.headers.get("authorization") || "";
  const session = /^Bearer ([a-f0-9]{64})$/i.exec(authorization)?.[1];
  if (!session) throw new DeskError("Sign in with your Conference Desk Google account.", 401);
  return await hash(session);
}
function requireSession(state: Pick<DeskState, "secrets">, key: string) {
  if ((hosted(state).sessions?.[key] ?? 0) <= Date.now()) throw new DeskError("Your session expired. Sign in again.", 401);
}

async function startGoogle(state: DeskState, mode: DeskGoogleMode, input: Record<string, unknown>, ownerSession?: string) {
  const returnUrl = returnLocation(input.returnUrl);
  const { url, pending } = beginDeskGoogleAuth(googleConfig(), mode);
  const requests = hosted(state).oauth ??= {};
  expire(requests, request => request.pending.expiresAt <= Date.now());
  if (Object.keys(requests).length >= 40) throw new DeskError("Too many sign-in attempts. Try again in a few minutes.", 429);
  requests[pending.state] = { pending, mode, returnUrl, ownerSession };
  await state.save();
  return { url };
}

function redirect(url: URL) {
  return new Response(null, { status: 303, headers: { Location: url.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
async function googleCallback(url: URL) {
  const id = clean(url.searchParams.get("state"));
  if (!/^[a-z0-9_-]{20,128}$/i.test(id)) throw new DeskError("Google authorization expired. Open Conference Desk and try again.");
  const start = await withDeskState(async state => {
    const requests = hosted(state).oauth || {};
    const record = requests[id];
    if (!record || record.pending.expiresAt <= Date.now()) throw new DeskError("Google authorization expired. Open Conference Desk and try again.");
    if (record.mode === "mailbox") requireSession(state, record.ownerSession || "");
    delete requests[id];
    await state.save();
    return record;
  });
  const destination = new URL(returnLocation(start.returnUrl));
  try {
    const { email, refreshToken } = await finishDeskGoogleAuth(googleConfig(), start.pending, {
      state: id, code: clean(url.searchParams.get("code"), 4096),
    }, start.mode);
    if (start.mode === "login") {
      if (email.toLowerCase() !== ownerEmail()) throw new DeskError("Use the Google account that owns Conference Desk.");
      const sessionToken = token();
      const exchangeCode = token();
      await withDeskState(async state => {
        const stateAuth = hosted(state);
        const sessions = stateAuth.sessions ??= {};
        const exchanges = stateAuth.exchanges ??= {};
        expire(sessions, expires => expires <= Date.now());
        expire(exchanges, exchange => exchange.expiresAt <= Date.now());
        if (Object.keys(sessions).length >= 30) {
          const oldest = Object.entries(sessions).sort((a, b) => a[1] - b[1])[0];
          delete sessions[oldest[0]];
        }
        sessions[await hash(sessionToken)] = Date.now() + authLifetime;
        exchanges[await hash(exchangeCode)] = { expiresAt: Date.now() + 120_000, sessionToken };
        await state.save();
      });
      destination.searchParams.set("desk_code", exchangeCode);
    } else {
      if (!refreshToken) throw new DeskError("Google did not return offline access. Reconnect this mailbox.");
      await withDeskState(async state => {
        requireSession(state, start.ownerSession || "");
        state.secrets.mailboxes[email] = { email, refreshToken };
        state.secrets.activeMailbox = email;
        await state.save();
      });
      destination.searchParams.set("gmail", "connected");
    }
  } catch (error) {
    const message = error instanceof DeskError || error instanceof GmailApiError ? error.message : "Google authorization expired or was canceled.";
    destination.searchParams.set(start.mode === "login" ? "desk_error" : "gmail", message);
  }
  return redirect(destination);
}

async function exchange(state: DeskState, input: Record<string, unknown>) {
  const code = clean(input.code);
  if (!/^[a-f0-9]{64}$/i.test(code)) throw new DeskError("The sign-in link expired. Sign in again.", 401);
  const key = await hash(code);
  const records = hosted(state).exchanges || {};
  const record = records[key];
  if (!record || record.expiresAt <= Date.now()) throw new DeskError("The sign-in link expired. Sign in again.", 401);
  delete records[key];
  await state.save();
  return { token: record.sessionToken };
}

async function handle(request: Request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/(?:functions\/v1\/)?desk(?=\/|$)/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const name = path.join("/");
  const origin = request.headers.get("origin");
  const allowedOrigin = site().origin;
  const headers = new Headers({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Vary": "Origin" });
  if (origin === allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "authorization, content-type");
    headers.set("Access-Control-Max-Age", "600");
  }
  const json = (data: unknown, status = 200) => Response.json(data, { status, headers });
  try {
    if (request.method === "OPTIONS") return new Response(null, { status: origin === allowedOrigin ? 204 : 403, headers });
    if (request.method === "GET" && name === "health") return json({ ok: true });
    if (request.method === "GET" && name === "gmail/callback") return await googleCallback(url);
    if (name === "cron" && request.method === "POST") {
      const secret = Deno.env.get("DESK_CRON_SECRET");
      const supplied = request.headers.get("x-desk-cron") || "";
      if (!secret || !supplied || await hash(supplied) !== await hash(secret)) throw new DeskError("Worker authorization required.", 401);
      return json(await withDeskState(async state => {
        const sends = await processDueMail(state);
        if (sends) return { sends, repliesChecked: 0, research: false };
        const research = await processResearch(state);
        const repliesChecked = research ? 0 : await syncDueDeskMail(state);
        return { sends, repliesChecked, research };
      }));
    }
    if (origin && origin !== allowedOrigin) throw new DeskError("Open Conference Desk from its published dashboard URL.", 403);
    if (request.method === "GET" && name === "workspace") {
      const key = await sessionKey(request);
      const state = await readDeskState();
      requireSession(state, key);
      return json(snapshot(state));
    }
    if (request.method !== "POST") throw new DeskError("Endpoint not found.", 404);
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new DeskError("Send JSON from Conference Desk.", 415);
    const data = await request.text();
    if (data.length > 4_000_000) throw new DeskError("This request is too large.", 413);
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(data);
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
    } catch { throw new DeskError("Invalid JSON request."); }
    if (name === "session/start") {
      if (origin !== allowedOrigin) throw new DeskError("Open Conference Desk from its published dashboard URL.", 403);
      return json(await withDeskState(state => startGoogle(state, "login", input)));
    }
    if (name === "session/exchange") {
      if (origin !== allowedOrigin) throw new DeskError("Open Conference Desk from its published dashboard URL.", 403);
      return json(await withDeskState(state => exchange(state, input)));
    }
    const key = await sessionKey(request);
    // Reject stale or invalid sessions before acquiring the workspace write lease.
    requireSession(await readDeskState(), key);
    return json(await withDeskState(async state => {
      requireSession(state, key);
      if (name === "session/end") {
        delete hosted(state).sessions![key];
        await state.save();
        return { ok: true };
      }
      if (name === "gmail/connect") return await startGoogle(state, "mailbox", input, key);
      return await workspaceAction(state, path, input);
    }));
  } catch (error) {
    if (error instanceof GmailApiError) return json({ error: error.message }, error.status === 401 ? 409 : error.status);
    if (error instanceof DeskError || error instanceof DeskStorageError) return json({ error: error.message }, error.status);
    console.error("Conference Desk request failed", { route: path[0], kind: error instanceof Error ? error.name : typeof error });
    return json({ error: "Conference Desk could not complete the request. Try again." }, 500);
  }
}

Deno.serve(handle);
