// Claude provider, built on the Claude Agent SDK (Claude Code as a library).
//
// Mapping to the gateway contract:
//   system/init          -> session (resumable id)
//   stream_event deltas  -> text_delta   (live typing)
//   assistant blocks     -> text / tool_start
//   user tool_result     -> tool_end
//   result               -> RunOutcome (cost, success or error)
//   canUseTool           -> approval card in the transcript
import { type Options, query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { apiErrorMessage } from "../agent/openai-compatible.ts";
import type { AgentProvider, ProviderInfo, RunCallbacks, RunOutcome, RunRequest } from "../types.ts";

export const DEFAULT_CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

/** Tools that only read, so they run without an approval card. Everything else asks. */
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"];

/** The SDK's `query`, or a scripted stand-in for offline tests. */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage>;

export class ClaudeProvider implements AgentProvider {
  readonly id = "claude" as const;
  private readonly queryFn: QueryFn;
  private readonly getKey: () => string | undefined;
  private readonly fetch: typeof fetch;

  /** `getKey` is read on every run, so a key saved in Settings is used by the next message. */
  constructor(
    queryFn: QueryFn = query,
    getKey: () => string | undefined = () => process.env.ANTHROPIC_API_KEY,
    fetchFn: typeof fetch = fetch,
  ) {
    this.queryFn = queryFn;
    this.getKey = getKey;
    this.fetch = fetchFn;
  }

  info(): ProviderInfo {
    return { label: "Claude", local: false, configured: Boolean(this.getKey()) };
  }

  /** Lists Claude models; also how Settings tests a key. */
  async listModels(signal: AbortSignal): Promise<string[]> {
    const key = this.getKey();
    if (!key) throw new Error("Add an API key in Settings, or set ANTHROPIC_API_KEY.");
    const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
    let res: Response;
    try {
      res = await this.fetch(`${base}/v1/models?limit=1000`, {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      throw new Error(`Couldn't reach Anthropic: ${(err as Error).message}`);
    }
    if (!res.ok) throw new Error(await apiErrorMessage(res, "Anthropic"));
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    return (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string")
      .sort();
  }

  async run(req: RunRequest, cb: RunCallbacks): Promise<RunOutcome> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    req.signal.addEventListener("abort", onAbort, { once: true });

    const options: Options = {
      cwd: req.workspaceDir,
      model: req.model || DEFAULT_CLAUDE_MODEL,
      resume: req.sessionId,
      systemPrompt: { type: "preset", preset: "claude_code", append: req.instructions },
      // Don't inherit the host user's own Claude Code settings, hooks or CLAUDE.md.
      settingSources: [],
      permissionMode: "default",
      allowedTools: READ_ONLY_TOOLS,
      includePartialMessages: true,
      abortController,
      // The key is read now, so a key saved in Settings works without a restart. Never logged.
      env: { ...process.env, ...(this.getKey() ? { ANTHROPIC_API_KEY: this.getKey() } : {}) },
      canUseTool: async (toolName, input, { signal }) => {
        const decision = await cb.requestApproval(
          { tool: toolName, summary: summarizeTool(toolName, input), input },
          signal,
        );
        return decision.allow
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: decision.reason };
      },
    };

    const text = new TextBlocks();
    let sessionId = req.sessionId;
    try {
      for await (const msg of this.queryFn({ prompt: req.prompt, options })) {
        const outcome = this.handle(msg, cb, text, (id) => (sessionId = id));
        if (outcome) return { ...outcome, sessionId };
      }
      return req.signal.aborted
        ? { status: "interrupted", sessionId }
        : { status: "failed", sessionId, error: "The agent stopped without a result." };
    } catch (err) {
      if (req.signal.aborted) return { status: "interrupted", sessionId };
      return { status: "failed", sessionId, error: err instanceof Error ? err.message : String(err) };
    } finally {
      req.signal.removeEventListener("abort", onAbort);
    }
  }

  private handle(
    msg: SDKMessage,
    cb: RunCallbacks,
    text: TextBlocks,
    setSession: (id: string) => void,
  ): RunOutcome | undefined {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          setSession(msg.session_id);
          cb.emit({ type: "session", sessionId: msg.session_id });
        }
        return;
      case "stream_event": {
        if (msg.parent_tool_use_id) return; // subagent output stays out of the main transcript
        const ev = msg.event;
        if (ev.type === "message_start") text.startMessage(ev.message.id);
        else if (ev.type === "content_block_start" && ev.content_block.type === "text") text.openStreamed(ev.index);
        else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          cb.emit({ type: "text_delta", blockId: text.streamedId(ev.index), text: ev.delta.text });
        }
        return;
      }
      case "assistant": {
        if (msg.parent_tool_use_id) return;
        for (const block of msg.message.content) {
          if (block.type === "text") {
            cb.emit({ type: "text", blockId: text.claimFinal(msg.message.id), text: block.text });
          } else if (block.type === "tool_use") {
            const input = (block.input ?? {}) as Record<string, unknown>;
            cb.emit({
              type: "tool_start",
              toolUseId: block.id,
              tool: block.name,
              summary: summarizeTool(block.name, input),
            });
          }
        }
        return;
      }
      case "user": {
        if (msg.parent_tool_use_id) return;
        const content = msg.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block.type === "tool_result") {
            cb.emit({ type: "tool_end", toolUseId: block.tool_use_id, ok: !block.is_error });
          }
        }
        return;
      }
      case "result":
        return msg.subtype === "success"
          ? { status: "finished", costUsd: msg.total_cost_usd }
          : { status: "failed", costUsd: msg.total_cost_usd, error: msg.errors.join("\n") || msg.subtype };
      default:
        return;
    }
  }
}

/**
 * Pairs streamed text blocks with the final text blocks of the same message,
 * so the final text replaces the streamed entry instead of creating a new one.
 * Works whether the SDK delivers a message's blocks in one assistant message or several.
 */
class TextBlocks {
  private messageId = "";
  private readonly streamed = new Map<string, string[]>(); // messageId -> block ids, in order
  private readonly byIndex = new Map<string, string>(); // `${messageId}:${index}` -> block id
  private counter = 0;

  startMessage(id: string): void {
    this.messageId = id;
  }

  openStreamed(index: number): void {
    const id = `${this.messageId}:${index}`;
    this.byIndex.set(id, id);
    const list = this.streamed.get(this.messageId) ?? [];
    list.push(id);
    this.streamed.set(this.messageId, list);
  }

  streamedId(index: number): string {
    return this.byIndex.get(`${this.messageId}:${index}`) ?? `${this.messageId}:${index}`;
  }

  claimFinal(messageId: string): string {
    return this.streamed.get(messageId)?.shift() ?? `${messageId}:final:${this.counter++}`;
  }
}

/** Short, human label for a tool call, shown as a status row ("Running npm test"). */
export function summarizeTool(tool: string, input: Record<string, unknown>): string {
  const s = (v: unknown, max = 80) => {
    const str = typeof v === "string" ? v : JSON.stringify(v ?? "");
    return str.length > max ? `${str.slice(0, max - 1)}…` : str;
  };
  switch (tool) {
    case "Bash":
      return `Running ${s(input.command)}`;
    case "Read":
      return `Reading ${s(input.file_path)}`;
    case "Write":
      return `Writing ${s(input.file_path)}`;
    case "Edit":
    case "MultiEdit":
      return `Editing ${s(input.file_path)}`;
    case "Glob":
    case "Grep":
      return `Searching files for ${s(input.pattern)}`;
    case "WebSearch":
      return `Searching the web for ${s(input.query)}`;
    case "WebFetch":
      return `Opening ${s(input.url)}`;
    case "TodoWrite":
      return "Updating the task list";
    default:
      return `Using ${tool}`;
  }
}
