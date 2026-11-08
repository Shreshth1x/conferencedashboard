import { createHash, timingSafeEqual } from "node:crypto";
import { researchConference } from "../server/conference-research.ts";

const BODY_LIMIT = 16_384;
const INPUT_KEYS = new Set(["name", "url", "notes", "seedUrls"]);
const PRIVATE_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

function errorResponse(status: number, error: string) {
  return Response.json({ error }, {
    status,
    headers: status === 405 ? { ...PRIVATE_HEADERS, Allow: "POST" } : PRIVATE_HEADERS,
  });
}

function authorized(request: Request) {
  const secret = process.env.DESK_RESEARCH_SECRET;
  const supplied = /^Bearer ([!-~]{32,512})$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!secret || secret.length < 32 || secret.length > 512 || !supplied) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(supplied), digest(secret));
}

async function readBody(request: Request): Promise<string | undefined> {
  if (Number(request.headers.get("content-length")) > BODY_LIMIT) return undefined;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let length = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return text + decoder.decode();
      length += value.byteLength;
      if (length > BODY_LIMIT) {
        await reader.cancel();
        return undefined;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function field(value: unknown, limit: number) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > limit) throw new Error("Invalid field");
  return value.trim() || undefined;
}

function sourceUrl(value: unknown) {
  const input = field(value, 2_048);
  if (!input) return undefined;
  const url = new URL(input);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error("Invalid URL");
  }
  return input;
}

function readInput(text: string) {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !INPUT_KEYS.has(key))) throw new Error("Invalid fields");
  const input = value as Record<string, unknown>;
  const name = field(input.name, 500);
  const url = sourceUrl(input.url);
  const notes = field(input.notes, 2_000);
  let seedUrls: string[] | undefined;
  if (input.seedUrls !== undefined) {
    if (!Array.isArray(input.seedUrls) || input.seedUrls.length > 6) throw new Error("Invalid seed URLs");
    seedUrls = input.seedUrls.map(value => {
      const seed = sourceUrl(value);
      if (!seed) throw new Error("Invalid seed URL");
      return seed;
    });
  }
  if (!name && !url && !seedUrls?.length) throw new Error("Missing conference");
  return { name, url, notes, seedUrls };
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return errorResponse(405, "Use POST.");
    if (!authorized(request)) return errorResponse(401, "Unauthorized.");
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      return errorResponse(415, "Use application/json.");
    }
    let input: ReturnType<typeof readInput>;
    try {
      const text = await readBody(request);
      if (text === undefined) return errorResponse(413, "Request is too large.");
      input = readInput(text);
    } catch {
      return errorResponse(400, "Provide valid conference search fields.");
    }
    try {
      const { name, url, notes, seedUrls } = input;
      const result = await researchConference({ name, url, notes }, { hosted: true, seedUrls });
      return Response.json(result, { headers: PRIVATE_HEADERS });
    } catch {
      return errorResponse(502, "Public conference research could not complete.");
    }
  },
};
