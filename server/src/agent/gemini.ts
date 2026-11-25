// ModelAdapter for the Gemini API (generativelanguage.googleapis.com): streamed text and function calls over SSE.
// The key goes in the x-goog-api-key header, never in the URL.
import {
  type ChatMessage,
  type KeySource,
  type ModelAdapter,
  type ModelEvent,
  type ModelRequest,
  readKey,
  type ToolSpec,
} from "./model.ts";
import { apiErrorMessage, ModelApiError, sseData } from "./openai-compatible.ts";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiOptions {
  baseUrl?: string;
  apiKey?: KeySource;
  defaultModel?: string;
  fetch?: typeof fetch;
}

interface Part {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
}

interface Content {
  role: "user" | "model";
  parts: Part[];
}

interface StreamChunk {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  error?: { message?: string };
}

/** Finish reasons that mean the turn ended normally. MAX_TOKENS is handled on its own. */
const NORMAL_FINISH = new Set(["STOP", "FINISH_REASON_UNSPECIFIED"]);

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

export function toGeminiContents(messages: ChatMessage[]): Content[] {
  const out: Content[] = [];
  // Gemini's own id for each call (when it gave one), to send back with the call's result.
  const geminiIds = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", parts: [{ text: m.text }] });
    } else if (m.role === "assistant") {
      // A signature Gemini put on its text goes back on that text, unchanged.
      const textSignature = str(m.meta?.textThoughtSignature);
      const parts: Part[] = m.text
        ? [{ text: m.text, ...(textSignature ? { thoughtSignature: textSignature } : {}) }]
        : [];
      for (const call of m.toolCalls) {
        const geminiId = str(call.meta?.geminiId);
        if (geminiId) geminiIds.set(call.id, geminiId);
        const signature = str(call.meta?.thoughtSignature);
        parts.push({
          functionCall: { ...(geminiId ? { id: geminiId } : {}), name: call.name, args: call.input },
          ...(signature ? { thoughtSignature: signature } : {}),
        });
      }
      if (parts.length) out.push({ role: "model", parts });
    } else {
      // All results for one step go back together, in one user turn.
      const geminiId = geminiIds.get(m.toolCallId);
      const part: Part = {
        functionResponse: {
          ...(geminiId ? { id: geminiId } : {}),
          name: m.name,
          response: m.isError ? { error: m.output } : { output: m.output },
        },
      };
      const last = out.at(-1);
      if (last?.role === "user" && last.parts.every((p) => p.functionResponse)) last.parts.push(part);
      else out.push({ role: "user", parts: [part] });
    }
  }
  return out;
}

/** Gemini rejects an object schema with no properties; leave parameters out for tools that take no input. */
function declaration(t: ToolSpec) {
  const props = t.inputSchema.properties;
  const empty = !props || (typeof props === "object" && Object.keys(props).length === 0);
  return { name: t.name, description: t.description, ...(empty ? {} : { parameters: t.inputSchema }) };
}

export class GeminiAdapter implements ModelAdapter {
  private readonly baseUrl: string;
  private readonly apiKey: KeySource;
  private readonly defaultModel?: string;
  private readonly fetch: typeof fetch;

  constructor(opts: GeminiOptions) {
    this.baseUrl = (opts.baseUrl ?? GEMINI_BASE_URL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.defaultModel = opts.defaultModel;
    this.fetch = opts.fetch ?? fetch;
  }

  get configured(): boolean {
    return Boolean(readKey(this.apiKey));
  }

  async listModels(signal: AbortSignal, baseUrl?: string): Promise<string[]> {
    const models: string[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ pageSize: "1000", ...(pageToken ? { pageToken } : {}) });
      const res = await this.request(`/models?${query}`, { method: "GET", signal }, baseUrl);
      const body = (await res.json()) as {
        models?: { name?: string; supportedGenerationMethods?: string[] }[];
        nextPageToken?: string;
      };
      for (const m of body.models ?? []) {
        if (m.name && m.supportedGenerationMethods?.includes("generateContent")) {
          models.push(m.name.replace(/^models\//, ""));
        }
      }
      pageToken = body.nextPageToken || undefined;
    } while (pageToken);
    return models.sort();
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelEvent> {
    const model = req.model || this.defaultModel;
    if (!model) throw new Error("Choose a model for this bot.");
    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: toGeminiContents(req.messages),
      ...(req.tools.length ? { tools: [{ functionDeclarations: req.tools.map(declaration) }] } : {}),
    };
    // Accept "models/gemini-x" as written in Google's docs, as well as "gemini-x".
    const name = model.replace(/^models\//, "");
    const res = await this.request(
      `/models/${encodeURIComponent(name)}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      },
      req.baseUrl,
    );
    if (!res.body) throw new Error("Gemini sent an empty response.");

    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let produced = false;
    let finish: string | undefined;
    for await (const data of sseData(res.body)) {
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(data) as StreamChunk;
      } catch {
        console.warn("gemini: skipped a stream event that isn't JSON", data.slice(0, 200));
        continue;
      }
      if (chunk.error) throw new Error(`Gemini reported an error: ${chunk.error.message ?? "unknown error"}`);
      const blocked = chunk.promptFeedback?.blockReason;
      if (blocked) throw new Error(`Gemini blocked the request (${blocked}).`);
      if (chunk.usageMetadata) {
        usage = {
          inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
          // Thinking tokens are billed as output too.
          outputTokens: (chunk.usageMetadata.candidatesTokenCount ?? 0) + (chunk.usageMetadata.thoughtsTokenCount ?? 0),
        };
      }
      const candidate = chunk.candidates?.[0];
      if (candidate?.finishReason) finish = candidate.finishReason;
      for (const part of candidate?.content?.parts ?? []) {
        if (part.thought) continue;
        // Signatures on text parts often arrive on a final, empty part; keep the last one for the history.
        if (!part.functionCall && part.thoughtSignature) {
          yield { type: "turn_meta", meta: { textThoughtSignature: part.thoughtSignature } };
        }
        if (part.text) {
          produced = true;
          yield { type: "text_delta", text: part.text };
        }
        if (part.functionCall) {
          produced = true;
          const { id, name, args } = part.functionCall;
          yield {
            type: "tool_call",
            call: {
              id: id ?? "",
              name,
              input: args ?? {},
              meta: {
                ...(id ? { geminiId: id } : {}),
                ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
              },
            },
          };
        }
      }
    }
    if (finish === "MAX_TOKENS") {
      // A cut-short answer is still an answer; nothing at all (all spent on thinking) is not.
      if (!produced) throw new Error("Gemini ran out of output tokens before answering.");
    } else if (finish && !NORMAL_FINISH.has(finish)) {
      // SAFETY, RECITATION, MALFORMED_FUNCTION_CALL, …: say so, even after partial text (the loop keeps that text).
      throw new Error(produced ? `Gemini stopped early (${finish}).` : `Gemini stopped without answering (${finish}).`);
    }
    yield { type: "done", usage };
  }

  private async request(path: string, init: RequestInit, baseUrlOverride?: string): Promise<Response> {
    const apiKey = readKey(this.apiKey);
    if (!apiKey) {
      throw new Error("Add an API key in Settings, or set GEMINI_API_KEY (or switch this bot to another provider).");
    }
    const baseUrl = baseUrlOverride?.replace(/\/+$/, "") || this.baseUrl;
    const headers = new Headers(init.headers);
    headers.set("x-goog-api-key", apiKey);
    let res: Response;
    try {
      res = await this.fetch(`${baseUrl}${path}`, { ...init, headers });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      throw new Error(`Couldn't reach Gemini at ${baseUrl}: ${(err as Error).message}`);
    }
    if (!res.ok) throw new ModelApiError(res.status, await apiErrorMessage(res, "Gemini"));
    return res;
  }
}
