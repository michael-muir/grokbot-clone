// Claude provider, built on the Claude Agent SDK (Claude Code as a library).
//
// Mapping to the gateway contract:
//   system/init          -> session (resumable id)
//   stream_event deltas  -> text_delta   (live typing)
//   assistant blocks     -> text / tool_start
//   user tool_result     -> tool_end
//   assistant/user uuid  -> checkpoint   (resumeAt forks the session there)
//   result               -> RunOutcome (cost, success or error)
//   canUseTool           -> approval card in the transcript
//   AskUserQuestion      -> choice cards (claude-questions.ts)
import { type Options, query, type SDKAssistantMessage, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { apiErrorMessage } from "../agent/openai-compatible.ts";
import { short } from "../agent/tools.ts";
import { childEnv } from "../child-env.ts";
import { labelPath } from "../display-path.ts";
import { NotConfiguredError } from "../errors.ts";
import type { AgentProvider, ProviderInfo, RunCallbacks, RunOutcome, RunRequest } from "../types.ts";
import { ASK_USER_QUESTION, answerQuestions } from "./claude-questions.ts";

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
  /** Sessions whose stopped Claude Code process is still shutting down; a new run on them waits for it. */
  private readonly closing = new Map<string, Promise<void>>();

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
    if (!key) throw new NotConfiguredError("Add an API key in Settings, or set ANTHROPIC_API_KEY.");
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
    // Two Claude Code processes must never write the same session: wait out a stopped run's shutdown first.
    const previous = req.sessionId ? this.closing.get(req.sessionId) : undefined;
    if (previous && (await untilStopped(previous, req.signal)) === STOP) {
      return { status: "interrupted", sessionId: req.sessionId };
    }
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    req.signal.addEventListener("abort", onAbort, { once: true });

    const options: Options = {
      cwd: req.workspaceDir,
      model: req.model || DEFAULT_CLAUDE_MODEL,
      resume: req.sessionId,
      // From a checkpoint: a new session holding the old one up to there (the SDK's truncating fork). The checkpoint
      // is the last entry of the turn being kept, which is where the SDK asks forks to be made.
      ...(req.sessionId && req.resumeAt ? { resumeSessionAt: req.resumeAt, forkSession: true } : {}),
      systemPrompt: { type: "preset", preset: "claude_code", append: req.instructions },
      // Don't inherit the host user's own Claude Code settings, hooks or CLAUDE.md.
      settingSources: [],
      permissionMode: "default",
      allowedTools: READ_ONLY_TOOLS,
      includePartialMessages: true,
      abortController,
      // The key is read now, so a key saved in Settings works without a restart. Never logged.
      // Claude Code needs its own key, and no other secret of the gateway's.
      env: { ...childEnv(), ...(this.getKey() ? { ANTHROPIC_API_KEY: this.getKey() } : {}) },
      canUseTool: async (toolName, input, { signal }) => {
        // A question isn't an action to approve: the user answers it on its own card.
        if (toolName === ASK_USER_QUESTION) return answerQuestions(input, cb.requestChoice, signal);
        const decision = await cb.requestApproval(
          { tool: toolName, summary: summarizeTool(toolName, input, req.workspaceDir), input },
          signal,
        );
        return decision.allow
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: decision.reason };
      },
    };

    const text = new TextBlocks();
    // An API failure (no credits, bad key, overload) arrives as an assistant message flagged with `error`, then a
    // "success" result with is_error. Its text is the error, not a reply, so it becomes the run's error message.
    const apiError: { message?: string } = {};
    let sessionId = req.sessionId;
    // After an abort the SDK closes Claude Code gracefully (~2 s) and keeps delivering messages meanwhile, ending
    // with a "success" result. Stop must be immediate: stop reading at once, and let the shutdown finish alone.
    const messages = this.queryFn({ prompt: req.prompt, options })[Symbol.asyncIterator]();
    try {
      while (true) {
        // Checked before asking for more: after Stop, the query must not be pulled again.
        const next = req.signal.aborted ? STOP : await untilStopped(messages.next(), req.signal);
        if (next === STOP) {
          this.finishClosing(sessionId, messages);
          return { status: "interrupted", sessionId };
        }
        if (next.done) break;
        const outcome = this.handle(next.value, cb, text, apiError, (id) => (sessionId = id), req.workspaceDir);
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

  /** Lets a stopped query shut down in the background, and marks its session busy until it has (at most 5 s). */
  private finishClosing(sessionId: string | undefined, messages: AsyncIterator<SDKMessage>): void {
    const shutdown = Promise.race([
      Promise.resolve(messages.return?.()).then(
        () => undefined,
        (err: unknown) => console.warn("Claude: closing a stopped query failed:", err),
      ),
      new Promise<void>((resolve) => setTimeout(resolve, CLOSE_WAIT_MS).unref()),
    ]);
    if (!sessionId) return;
    const done = shutdown.finally(() => {
      if (this.closing.get(sessionId) === done) this.closing.delete(sessionId);
    });
    this.closing.set(sessionId, done);
  }

  private handle(
    msg: SDKMessage,
    cb: RunCallbacks,
    text: TextBlocks,
    apiError: { message?: string },
    setSession: (id: string) => void,
    workspaceDir: string,
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
        // A reply cut off at the length limit is still a reply; only real API failures are swallowed here.
        if (msg.error && msg.error !== "max_output_tokens") {
          const said = msg.message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ");
          apiError.message = `Anthropic: ${said || API_ERRORS[msg.error] || msg.error}`;
          return;
        }
        cb.emit({ type: "checkpoint", at: msg.uuid });
        for (const block of msg.message.content) {
          if (block.type === "text") {
            cb.emit({ type: "text", blockId: text.claimFinal(msg.message.id), text: block.text });
          } else if (block.type === "tool_use") {
            const input = (block.input ?? {}) as Record<string, unknown>;
            cb.emit({
              type: "tool_start",
              toolUseId: block.id,
              tool: block.name,
              summary: summarizeTool(block.name, input, workspaceDir),
            });
          }
        }
        return;
      }
      case "user": {
        if (msg.parent_tool_use_id) return;
        // Tool results are part of the turn: a fork that dropped them would leave their tool calls unanswered.
        if (msg.uuid) cb.emit({ type: "checkpoint", at: msg.uuid });
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
        // The result decides: the SDK may retry after an API error and then succeed.
        if (msg.subtype === "success" && !msg.is_error) {
          return { status: "finished", costUsd: msg.total_cost_usd };
        }
        return {
          status: "failed",
          costUsd: msg.total_cost_usd,
          error:
            apiError.message ||
            (msg.subtype === "success" ? msg.result : msg.errors.join("\n")) ||
            "Claude stopped with an error.",
        };
      default:
        return;
    }
  }
}

const STOP = Symbol("stopped");
/** Longest a new run waits for a stopped run's Claude Code process to exit. */
const CLOSE_WAIT_MS = 5_000;

/**
 * Settles with the promise's value, or with STOP as soon as the signal fires. Stop wins whenever it has fired,
 * even if the value was already waiting. Nothing is left attached to the signal afterwards.
 */
function untilStopped<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof STOP> {
  if (signal.aborted) {
    promise.catch(() => {}); // its outcome no longer matters, but an unhandled rejection would crash the gateway
    return Promise.resolve(STOP);
  }
  return new Promise((resolve, reject) => {
    const onStop = () => resolve(STOP);
    signal.addEventListener("abort", onStop, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onStop);
        resolve(signal.aborted ? STOP : value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onStop);
        if (signal.aborted) resolve(STOP);
        else reject(err);
      },
    );
  });
}

/** Fallback wording when an API error comes without text of its own. */
const API_ERRORS: Partial<Record<NonNullable<SDKAssistantMessage["error"]>, string>> = {
  authentication_failed: "the API key was refused.",
  billing_error: "the account has no credit left.",
  rate_limit: "too many requests; try again in a moment.",
  overloaded: "the service is busy; try again in a moment.",
  model_not_found: "that model isn't available.",
};

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

/** Short, human label for a tool call, shown as a status row ("Running npm test"). Paths are workspace-relative. */
export function summarizeTool(tool: string, input: Record<string, unknown>, workspaceDir: string): string {
  const s = (v: unknown) => short(v);
  const file = (v: unknown) => labelPath(workspaceDir, v);
  switch (tool) {
    case "Bash":
      return `Running ${s(input.command)}`;
    case "Read":
      return `Reading ${file(input.file_path)}`;
    case "Write":
      return `Writing ${file(input.file_path)}`;
    case "Edit":
    case "MultiEdit":
      return `Editing ${file(input.file_path)}`;
    case "NotebookEdit":
      return `Editing ${file(input.notebook_path)}`;
    case "Glob":
    case "Grep":
      return `Searching files for ${s(input.pattern)}`;
    case "WebSearch":
      return `Searching the web for ${s(input.query)}`;
    case "WebFetch":
      return `Opening ${s(input.url)}`;
    case "TodoWrite":
      return "Updating the task list";
    case ASK_USER_QUESTION: {
      const first = Array.isArray(input.questions) ? (input.questions[0] as { question?: unknown })?.question : "";
      return `Asking: ${typeof first === "string" ? s(first) : ""}`;
    }
    default:
      return `Using ${tool}`;
  }
}
