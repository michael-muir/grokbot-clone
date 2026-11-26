// HTTP API for the desktop client. Binds to localhost only, and refuses requests from web pages (see
// refuseForeignRequest).
//
//   GET   /health
//   GET   /providers                     [{id, label, local, configured, needsKey, keySource}] (never a key)
//   GET   /providers/:id/models          {models}  (409 when not set up, 502 when it can't be reached)
//   PUT   /providers/:id/key             {key}  -> 204, saved in the OS keychain (never returned)
//   DELETE /providers/:id/key                   -> 204
//   POST  /providers/:id/test            {baseUrl?} -> {ok, models} or {ok: false, error}
//   GET   /bots
//   PATCH /bots/:id                      {name?, provider?, model?, baseUrl?}
//   GET   /bots/:id/transcript?since=N   entries changed after updatedSeq N
//   GET   /bots/:id/events?since=N       Server-Sent Events: backlog, then live entries, in updatedSeq order;
//                                        each event's id is its updatedSeq (Last-Event-ID resumes)
//   POST  /bots/:id/messages             {text}         -> 202, 409 while the bot is busy
//   POST  /bots/:id/interrupt                           -> 202, 409 when idle
//   POST  /bots/:id/approvals/:entryId   {allow, reason?}

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { BotRegistry } from "./bots.ts";
import { NotConfiguredError } from "./errors.ts";
import { BotBusyError, BotNotFoundError, type Gateway } from "./gateway.ts";
import { acceptsKey, type Credentials, KeyStoreUnavailableError, needsKey } from "./keys.ts";
import type { ProviderRegistry } from "./providers/index.ts";
import type { TranscriptStore } from "./transcript.ts";
import {
  type Bot,
  type BotActivity,
  isProviderId,
  type ProviderSummary,
  type PublicBot,
  type TranscriptEntry,
} from "./types.ts";

const MAX_BODY = 1_000_000;
const HEARTBEAT_MS = 15_000;

/** One cursor value; missing, empty or unusable means none. */
function parseCursor(value: string | string[] | undefined | null): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= -1 ? n : undefined;
}

/**
 * Where a transcript read resumes. A browser EventSource reconnects to the same URL (same ?since=) but adds
 * Last-Event-ID, so the further of the two wins; with neither, from the start.
 */
function cursorFrom(since: string | null, lastEventId: string | string[] | undefined): number {
  const a = parseCursor(since);
  const b = parseCursor(lastEventId);
  return Math.max(a ?? -1, b ?? -1);
}

export interface HttpDeps {
  gateway: Gateway;
  bots: BotRegistry;
  store: TranscriptStore;
  providers: ProviderRegistry;
  credentials: Credentials;
  token?: string;
  /** How often the event stream sends a heartbeat comment. */
  heartbeatMs?: number;
  /** Extra browser origins allowed to call the API (loopback origins always are). */
  allowedOrigins?: string[];
}

export function createHttpServer(deps: HttpDeps): Server {
  return createServer((req, res) => {
    const refused = refuseForeignRequest(req, deps.allowedOrigins ?? []);
    if (refused) return send(res, 403, { error: refused });
    handle(req, res, deps).catch((err) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: "Internal error" });
      else res.end();
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, d: HttpDeps): Promise<void> {
  if (d.token && !authorized(req, d.token)) return send(res, 401, { error: "Unauthorized" });
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method ?? "GET";

  if (method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
  if (parts[0] === "providers") return handleProviders(req, res, parts, method, d);
  if (parts[0] === "activity" && parts.length === 1 && method === "GET") return streamActivity(res, d);
  if (parts[0] !== "bots") return send(res, 404, { error: "Not found" });
  if (parts.length === 1 && method === "GET") return send(res, 200, d.bots.list().map(publicBot));

  const bot = parts[1] ? d.bots.get(parts[1]) : undefined;
  if (!bot) return send(res, 404, { error: "Unknown bot" });
  const since = cursorFrom(url.searchParams.get("since"), req.headers["last-event-id"]);

  if (parts.length === 2 && method === "PATCH") {
    const body = await readJson(req);
    const patch: Partial<Pick<Bot, "name" | "provider" | "model" | "baseUrl">> = {};
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
    if (typeof body.model === "string") patch.model = body.model.trim() || undefined;
    if (typeof body.baseUrl === "string") {
      if (body.baseUrl && !isHttpUrl(body.baseUrl)) return send(res, 400, { error: "baseUrl must be an http(s) URL" });
      patch.baseUrl = body.baseUrl || undefined;
    }
    if (body.provider !== undefined) {
      if (!isProviderId(body.provider) || !d.providers.has(body.provider)) {
        return send(res, 400, { error: "Unknown provider" });
      }
      patch.provider = body.provider;
    }
    try {
      return send(res, 200, publicBot(d.gateway.updateBot(bot.id, patch)));
    } catch (err) {
      if (err instanceof BotBusyError) return send(res, 409, { error: err.message });
      throw err;
    }
  }

  switch (`${method} ${parts.slice(2).join("/") || ""}`) {
    case "GET transcript":
      return send(res, 200, d.store.list(bot.id, since));

    case "GET events": {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // retry: how soon a browser EventSource reconnects. Then something at once, so the client knows it's live.
      res.write("retry: 2000\n: connected\n\n");
      // id = updatedSeq: EventSource sends it back as Last-Event-ID, so a plain browser client resumes by itself.
      const write = (e: TranscriptEntry) => res.write(`id: ${e.updatedSeq}\ndata: ${JSON.stringify(e)}\n\n`);
      // Backlog and live entries in updatedSeq order, set up in the same tick so nothing falls in between.
      for (const e of d.store.changedSince(bot.id, since)) write(e);
      const unsubscribe = d.store.subscribe(bot.id, write);
      const heartbeat = setInterval(() => res.write(": ping\n\n"), d.heartbeatMs ?? HEARTBEAT_MS);
      // `res` closes when the client disconnects (req "close" can fire once the request body is read).
      res.on("close", () => {
        unsubscribe();
        clearInterval(heartbeat);
      });
      return;
    }

    case "POST messages": {
      const body = await readJson(req);
      if (typeof body.text !== "string" || !body.text.trim()) return send(res, 400, { error: "text is required" });
      const nonce = body.clientNonce;
      if (nonce !== undefined && !(typeof nonce === "string" && nonce.length > 0 && nonce.length <= 100)) {
        return send(res, 400, { error: "clientNonce must be a string of 1 to 100 characters" });
      }
      try {
        const { entry } = await d.gateway.sendMessage(bot.id, body.text, nonce);
        return send(res, 202, { entryId: entry.id });
      } catch (err) {
        if (err instanceof BotBusyError) return send(res, 409, { error: err.message });
        if (err instanceof BotNotFoundError) return send(res, 404, { error: err.message });
        throw err;
      }
    }

    case "POST interrupt":
      return d.gateway.interrupt(bot.id)
        ? send(res, 202, { ok: true })
        : send(res, 409, { error: "Nothing is running" });

    default:
      if (method === "POST" && parts[2] === "choices" && parts[3] && parts.length === 4) {
        const body = await readJson(req);
        if (typeof body.answer !== "string") return send(res, 400, { error: "answer must be a string" });
        const result = d.gateway.answerChoice(bot.id, parts[3], body.answer);
        if (result === "invalid") return send(res, 400, { error: "That answer isn't one of the choices" });
        return result === "ok"
          ? send(res, 200, { ok: true })
          : send(res, 404, { error: "No pending choice with that id" });
      }
      if (method === "POST" && parts[2] === "approvals" && parts[3] && parts.length === 4) {
        const body = await readJson(req);
        if (typeof body.allow !== "boolean") return send(res, 400, { error: "allow must be true or false" });
        // An empty reason is passed on as is: the gateway shows a plain "Denied" and gives the model a default.
        const reason = typeof body.reason === "string" ? body.reason : "";
        const ok = d.gateway.answerApproval(bot.id, parts[3], body.allow ? { allow: true } : { allow: false, reason });
        return ok ? send(res, 200, { ok: true }) : send(res, 404, { error: "No pending approval with that id" });
      }
      return send(res, 404, { error: "Not found" });
  }
}

async function handleProviders(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  method: string,
  d: HttpDeps,
): Promise<void> {
  if (parts.length === 1 && method === "GET") {
    const list = [...d.providers.values()].map(
      (p): ProviderSummary => ({
        id: p.id,
        ...(p.info?.() ?? { label: p.id, local: false, configured: true }),
        needsKey: needsKey(p.id),
        keySource: d.credentials.source(p.id) ?? null,
      }),
    );
    return send(res, 200, list);
  }
  const provider = isProviderId(parts[1]) ? d.providers.get(parts[1]) : undefined;
  if (!provider || parts.length !== 3) return send(res, 404, { error: "Not found" });
  const action = `${method} ${parts[2]}`;

  if (action === "PUT key" || action === "DELETE key") {
    if (!acceptsKey(provider.id)) return send(res, 400, { error: "This provider doesn't use an API key" });
    try {
      if (method === "DELETE") d.credentials.delete(provider.id);
      else {
        const body = await readJson(req);
        const key = typeof body.key === "string" ? body.key.trim() : "";
        if (!key) return send(res, 400, { error: "key is required" });
        d.credentials.set(provider.id, key);
      }
    } catch (err) {
      if (err instanceof KeyStoreUnavailableError) return send(res, 503, { error: err.message });
      throw err;
    }
    res.writeHead(204).end();
    return;
  }

  if (action === "GET models" || action === "POST test") {
    if (!provider.listModels) return send(res, 404, { error: "This provider doesn't list its models" });
    let baseUrl: string | undefined;
    if (method === "POST") {
      const body = await readJson(req);
      if (typeof body.baseUrl === "string" && body.baseUrl) {
        if (!isHttpUrl(body.baseUrl)) return send(res, 400, { error: "baseUrl must be an http(s) URL" });
        baseUrl = body.baseUrl;
      }
    }
    try {
      const models = await provider.listModels(AbortSignal.timeout(15_000), baseUrl);
      return send(res, 200, method === "POST" ? { ok: true, models } : { models });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // A failed test is an answer, not a gateway error: the UI shows the message next to the key field.
      if (method === "POST") return send(res, 200, { ok: false, error });
      // Missing key or model is a settings problem (409), not an unreachable server (502).
      return send(res, err instanceof NotConfiguredError ? 409 : 502, { error });
    }
  }
  return send(res, 404, { error: "Not found" });
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Only this machine's own clients may call the gateway: it can run commands and holds API keys.
 * - Host must be a loopback name, which defeats DNS rebinding (evil.example resolving to 127.0.0.1).
 * - A browser Origin, when sent, must be loopback or explicitly allowed, so a web page can't drive the API.
 * - Requests that change things must be JSON, which browsers can't send cross-site without a CORS preflight.
 * Returns the reason to refuse, or undefined to allow.
 */
export function refuseForeignRequest(req: IncomingMessage, allowedOrigins: string[]): string | undefined {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  if (!LOOPBACK.has(host)) return "Requests must be addressed to localhost";
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.includes(origin)) {
    let hostname = "";
    try {
      const u = new URL(origin);
      if (u.protocol === "http:" || u.protocol === "https:") hostname = u.hostname.toLowerCase();
    } catch {
      // "null" and other opaque origins aren't URLs: refused below
    }
    if (!LOOPBACK.has(hostname)) return "This origin may not call the gateway";
  }
  const method = req.method ?? "GET";
  const hasBody = Number(req.headers["content-length"] ?? 0) > 0 || req.headers["transfer-encoding"] !== undefined;
  if (MUTATING.has(method) && hasBody && !(req.headers["content-type"] ?? "").startsWith("application/json")) {
    return "Send JSON (content-type: application/json)";
  }
  return undefined;
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** SSE: a snapshot of every bot's activity now, then a fresh one whenever a run starts or ends. */
function streamActivity(res: ServerResponse, d: HttpDeps): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  res.write("retry: 2000\n: connected\n\n");
  const write = (bots: BotActivity[]) => res.write(`data: ${JSON.stringify(bots)}\n\n`);
  write(d.gateway.activity());
  const unsubscribe = d.gateway.subscribeActivity(write);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), d.heartbeatMs ?? HEARTBEAT_MS);
  res.on("close", () => {
    unsubscribe();
    clearInterval(heartbeat);
  });
}

function publicBot(bot: Bot): PublicBot {
  const { sessionId: _s, sessionProvider: _p, ...rest } = bot;
  return rest;
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
