// ModelAdapter for the OpenAI Chat Completions API and the many servers that copy it (xAI, OpenRouter, Ollama,
// LM Studio). Streams text and tool calls over SSE; uses only the subset these servers share.
import {
  type ChatMessage,
  INVALID_ARGUMENTS,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
  type ToolCall,
} from "./model.ts";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  /** Name of the environment variable the key comes from, for error messages. */
  keyEnv?: string;
  /** Local servers need no key, and fall back to their first model when none is chosen. */
  local: boolean;
  defaultModel?: string;
  /** Ask for token usage in the stream. Some local servers reject the option. */
  streamUsage: boolean;
  fetch?: typeof fetch;
}

/** OpenAI-style wire message. */
type WireMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

interface ToolCallFragment {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface StreamChunk {
  error?: { message?: string } | string;
  choices?: { delta?: { content?: string | null; tool_calls?: ToolCallFragment[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

export class ModelApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function toWireMessages(system: string, messages: ChatMessage[]): WireMessage[] {
  const out: WireMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.text });
    else if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.output });
    else {
      out.push({
        role: "assistant",
        content: m.text || null,
        ...(m.toolCalls.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: JSON.stringify(c.input) },
              })),
            }
          : {}),
      });
    }
  }
  return out;
}

/**
 * Which call a fragment belongs to. Without an index, a fragment continues the last call unless it brings a new id.
 */
function fragmentIndex(
  frag: ToolCallFragment,
  fragments: Map<number, { id: string }>,
  lastIndex: number | undefined,
): number {
  if (frag.index !== undefined) return frag.index;
  if (lastIndex === undefined) return 0;
  const last = fragments.get(lastIndex);
  if (frag.id && last?.id && frag.id !== last.id) return Math.max(...fragments.keys()) + 1;
  return lastIndex;
}

/** Parses a tool call's JSON arguments. Bad JSON becomes an input the tool will reject with a clear message. */
export function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    return { [INVALID_ARGUMENTS]: `Expected a JSON object, got: ${raw.slice(0, 200)}` };
  } catch {
    return { [INVALID_ARGUMENTS]: `Arguments were not valid JSON: ${raw.slice(0, 200)}` };
  }
}

/** Yields the data payload of each server-sent event, however the body is split into chunks. */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  let data: string[] = [];
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line === "") {
        if (data.length) yield data.join("\n");
        data = [];
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""));
      }
      nl = buf.indexOf("\n");
    }
  }
  buf += decoder.decode();
  if (buf.startsWith("data:")) data.push(buf.slice(5).replace(/^ /, ""));
  if (data.length) yield data.join("\n");
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  private readonly opts: OpenAICompatibleOptions;
  private readonly fetch: typeof fetch;

  constructor(opts: OpenAICompatibleOptions) {
    this.opts = { ...opts, baseUrl: opts.baseUrl.replace(/\/+$/, "") };
    this.fetch = opts.fetch ?? fetch;
  }

  /** Has what it needs to make requests: a key, or a local server. */
  get configured(): boolean {
    return this.opts.local || Boolean(this.opts.apiKey);
  }

  /** Model ids, sorted for display. */
  async listModels(signal: AbortSignal): Promise<string[]> {
    return (await this.serverModels(signal)).sort();
  }

  /** Model ids in the server's own order (a local server usually lists its loaded model first). */
  private async serverModels(signal: AbortSignal): Promise<string[]> {
    const res = await this.request("/models", { method: "GET", signal });
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelEvent> {
    const model = await this.chooseModel(req.model, signal);
    const body = {
      model,
      stream: true,
      ...(this.opts.streamUsage ? { stream_options: { include_usage: true } } : {}),
      messages: toWireMessages(req.system, req.messages),
      ...(req.tools.length
        ? {
            tools: req.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
    };
    const res = await this.request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.body) throw new Error("The model server sent an empty response.");

    const fragments = new Map<number, { id: string; name: string; args: string }>();
    let lastIndex: number | undefined;
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    for await (const data of sseData(res.body)) {
      if (data === "[DONE]") break;
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(data) as StreamChunk;
      } catch {
        console.warn("openai-compatible: skipped a stream event that isn't JSON", data.slice(0, 200));
        continue;
      }
      if (chunk.error) {
        // Some servers (OpenRouter among them) report upstream failures inside a 200 stream.
        const detail = typeof chunk.error === "string" ? chunk.error : chunk.error.message;
        throw new Error(`The model server reported an error: ${detail || "unknown error"}`);
      }
      if (chunk.usage) {
        usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) yield { type: "text_delta", text: delta.content };
      for (const frag of delta.tool_calls ?? []) {
        const index = fragmentIndex(frag, fragments, lastIndex);
        lastIndex = index;
        const call = fragments.get(index) ?? { id: "", name: "", args: "" };
        if (frag.id) call.id = frag.id;
        // Most servers send the name once; some resend the whole name in every fragment, and a few split it.
        const name = frag.function?.name;
        if (name && name !== call.name) call.name += name;
        if (frag.function?.arguments) call.args += frag.function.arguments;
        fragments.set(index, call);
      }
    }
    for (const [, c] of [...fragments.entries()].sort(([a], [b]) => a - b)) {
      if (!c.name) continue;
      const call: ToolCall = { id: c.id, name: c.name, input: parseArguments(c.args) };
      yield { type: "tool_call", call };
    }
    yield { type: "done", usage };
  }

  private async chooseModel(requested: string | undefined, signal: AbortSignal): Promise<string> {
    const model = requested || this.opts.defaultModel;
    if (model) return model;
    if (!this.opts.local) throw new Error("Choose a model for this bot.");
    // Asked every time, so installing or removing models takes effect without a restart.
    const first = (await this.serverModels(signal))[0];
    if (!first) throw new Error("The local model server has no models installed.");
    return first;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    if (!this.opts.local && !this.opts.apiKey) {
      throw new Error(`Set ${this.opts.keyEnv ?? "the API key"} (or switch this bot to another provider).`);
    }
    const headers = new Headers(init.headers);
    if (this.opts.apiKey) headers.set("authorization", `Bearer ${this.opts.apiKey}`);
    let res: Response;
    try {
      res = await this.fetch(`${this.opts.baseUrl}${path}`, { ...init, headers });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      throw new Error(`Couldn't reach ${this.opts.baseUrl}: ${(err as Error).message}`);
    }
    if (!res.ok) throw new ModelApiError(res.status, await errorMessage(res));
    return res;
  }
}

/** The API's own error message, never echoing request headers. */
async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let detail = text.slice(0, 500);
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    detail = (typeof body.error === "string" ? body.error : body.error?.message) ?? body.message ?? detail;
  } catch {
    // not JSON: keep the raw text
  }
  return `The model server returned ${res.status}${detail ? `: ${detail}` : ""}`;
}
