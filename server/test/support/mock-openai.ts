// A mock OpenAI-compatible server for tests. Each request is answered by a script; requests are recorded.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown> | undefined;
}

export type Reply =
  | { status: number; json: unknown }
  /** Raw SSE text pieces, written one by one with an optional delay (pieces may split events anywhere). */
  | { sse: string[]; delayMs?: number };

export type Script = (req: RecordedRequest) => Reply;

/** One SSE event carrying a chat completion chunk. */
export const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta }], ...extra })}\n\n`;
export const done = "data: [DONE]\n\n";
export const textReply = (text: string) => [
  ...text.split(" ").map((w, i) => chunk({ content: (i ? " " : "") + w })),
  done,
];

export class MockOpenAI {
  readonly requests: RecordedRequest[] = [];
  private server?: Server;
  private script: Script;

  constructor(script: Script) {
    this.script = script;
  }

  setScript(script: Script): void {
    this.script = script;
  }

  async start(): Promise<string> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const recorded: RecordedRequest = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
      };
      this.requests.push(recorded);
      const reply = this.script(recorded);
      if ("json" in reply) {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify(reply.json));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      let closed = false;
      res.on("close", () => {
        closed = true;
      });
      for (const piece of reply.sse) {
        if (closed) return;
        if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
        if (closed) return;
        res.write(piece);
      }
      res.end();
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
