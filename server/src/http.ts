// HTTP API for the desktop client. Binds to localhost only.
//
//   GET   /health
//   GET   /bots
//   PATCH /bots/:id                      {name?, provider?, model?}
//   GET   /bots/:id/transcript?since=N   entries changed after updatedSeq N
//   GET   /bots/:id/events?since=N       Server-Sent Events: backlog, then live entries
//   POST  /bots/:id/messages             {text}         -> 202, 409 while the bot is busy
//   POST  /bots/:id/interrupt                           -> 202, 409 when idle
//   POST  /bots/:id/approvals/:entryId   {allow, reason?}
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { BotRegistry } from "./bots.ts";
import { BotBusyError, BotNotFoundError, type Gateway } from "./gateway.ts";
import type { TranscriptStore } from "./transcript.ts";
import type { Bot, ProviderId } from "./types.ts";

const PROVIDERS: ProviderId[] = ["claude", "codex", "cursor", "fake"];
const MAX_BODY = 1_000_000;

export interface HttpDeps {
  gateway: Gateway;
  bots: BotRegistry;
  store: TranscriptStore;
  token?: string;
}

export function createHttpServer(deps: HttpDeps): Server {
  return createServer((req, res) => {
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
  if (parts[0] !== "bots") return send(res, 404, { error: "Not found" });
  if (parts.length === 1 && method === "GET") return send(res, 200, d.bots.list().map(publicBot));

  const bot = parts[1] ? d.bots.get(parts[1]) : undefined;
  if (!bot) return send(res, 404, { error: "Unknown bot" });
  const since = Number(url.searchParams.get("since") ?? -1);

  if (parts.length === 2 && method === "PATCH") {
    const body = await readJson(req);
    const patch: Partial<Bot> = {};
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim();
    if (typeof body.model === "string") patch.model = body.model || undefined;
    if (body.provider !== undefined) {
      if (!PROVIDERS.includes(body.provider as ProviderId)) return send(res, 400, { error: "Unknown provider" });
      if (d.gateway.isRunning(bot.id)) return send(res, 409, { error: "Can't change provider during a run" });
      patch.provider = body.provider as ProviderId;
    }
    return send(res, 200, publicBot(d.bots.update(bot.id, patch)));
  }

  switch (`${method} ${parts.slice(2).join("/") || ""}`) {
    case "GET transcript":
      return send(res, 200, d.store.list(bot.id, since));

    case "GET events": {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      // Send something immediately: with an empty backlog the client would otherwise wait for the first heartbeat.
      res.write(": connected\n\n");
      const write = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
      for (const e of d.store.list(bot.id, since)) write(e);
      const unsubscribe = d.store.subscribe(bot.id, write);
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
      // `res` closes when the client disconnects (req "close" can fire once the request body is read).
      res.on("close", () => (unsubscribe(), clearInterval(heartbeat)));
      return;
    }

    case "POST messages": {
      const body = await readJson(req);
      if (typeof body.text !== "string" || !body.text.trim()) return send(res, 400, { error: "text is required" });
      try {
        const { entry } = await d.gateway.sendMessage(bot.id, body.text);
        return send(res, 202, { entryId: entry.id });
      } catch (err) {
        if (err instanceof BotBusyError) return send(res, 409, { error: err.message });
        if (err instanceof BotNotFoundError) return send(res, 404, { error: err.message });
        throw err;
      }
    }

    case "POST interrupt":
      return d.gateway.interrupt(bot.id) ? send(res, 202, { ok: true }) : send(res, 409, { error: "Nothing is running" });

    default:
      if (method === "POST" && parts[2] === "approvals" && parts[3] && parts.length === 4) {
        const body = await readJson(req);
        if (typeof body.allow !== "boolean") return send(res, 400, { error: "allow must be true or false" });
        const reason = typeof body.reason === "string" && body.reason ? body.reason : "Denied by the user.";
        const ok = d.gateway.answerApproval(bot.id, parts[3], body.allow ? { allow: true } : { allow: false, reason });
        return ok ? send(res, 200, { ok: true }) : send(res, 404, { error: "No pending approval with that id" });
      }
      return send(res, 404, { error: "Not found" });
  }
}

function publicBot(bot: Bot) {
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
