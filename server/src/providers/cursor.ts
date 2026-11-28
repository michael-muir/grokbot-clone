// Cursor provider (#26): drives the user's own signed-in Cursor CLI through `cursor-agent acp` (Agent Client
// Protocol, JSON-RPC over stdio). The owner chose ACP over print mode so Cursor's tool calls get approval cards.
//
// Mapping to the gateway contract:
//   session/new | session/load                         -> session (the session id); load's replay is ignored
//   session/update agent_message_chunk                 -> text_delta, then text when a tool call or the turn ends it
//   session/update tool_call, tool_call_update         -> tool_start, tool_end
//   session/request_permission (with allow-once)       -> approval cards; Cursor's questions are skipped
//   session/prompt stopReason                          -> the outcome
//   each finished or stopped turn                      -> checkpoint: how many messages the turn log holds
// Cursor has no session/fork, so the provider keeps a text log of each session's turns. A fork (resumeAt) opens a new
// Cursor session whose first prompt carries the conversation up to that checkpoint; the original is left as it was.
// No usage: ACP reports none.
//
// Isolation: the CLI reads MCP servers, hooks, plugins and its approval settings from the home folder, so every run
// gets a home of its own (isolatedEnv). Hooks in the bot's own workspace stop the run (workspaceHooks).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage } from "../agent/model.ts";
import { SessionStore } from "../agent/sessions.ts";
import { childEnv } from "../child-env.ts";
import { NotConfiguredError } from "../errors.ts";
import type { AgentProvider, ApprovalDecision, ProviderInfo, RunCallbacks, RunOutcome, RunRequest } from "../types.ts";
import { findExecutable, type Json, type LineConnection, Rpc, spawnLines } from "./stdio-rpc.ts";

export interface CursorOptions {
  /** The bots' own Cursor home: kept between runs, so sessions can be resumed. */
  homeDir: string;
  /** Opens the connection for a run in `cwd`, giving up when `signal` fires. Defaults to spawning `cursor-agent acp`. */
  connect?: (cwd: string, signal: AbortSignal) => Promise<LineConnection>;
  /** The executable: CURSOR_AGENT_PATH, or `cursor-agent` on the PATH. */
  command?: string;
  /** How long Stop waits for Cursor to end the turn before the process is killed. */
  stopGraceMs?: number;
}

const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Our tool names for ACP's tool kinds, so approval cards and steps read like other providers'. */
const TOOL_NAMES: Record<string, string> = {
  execute: "Bash",
  edit: "Edit",
  delete: "Edit",
  move: "Edit",
  read: "Read",
  fetch: "WebFetch",
  search: "Grep",
};
const toolName = (kind: string): string => TOOL_NAMES[kind] ?? (kind || "Tool");

/**
 * The environment for a bot's Cursor: the user's env without keys, with a home of its own so their MCP servers,
 * hooks, plugins and approval settings don't load. Their sign-in still works: on Windows it's under APPDATA (kept),
 * on Linux under XDG_CONFIG_HOME (pointed at the real one), on macOS through a link (see prepareHome).
 */
export function isolatedEnv(
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  realHome: string = homedir(),
): NodeJS.ProcessEnv {
  const out = childEnv(env);
  out.HOME = homeDir;
  out.USERPROFILE = homeDir;
  out.CURSOR_CONFIG_DIR = join(homeDir, ".cursor");
  if (platform === "linux") out.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME || join(realHome, ".config");
  return out;
}

/** Creates the bots' Cursor home. On macOS the sign-in lives in ~/.cursor/auth.json, so it's linked, never read. */
export function prepareHome(
  homeDir: string,
  platform: NodeJS.Platform = process.platform,
  realHome: string = homedir(),
): void {
  const dotCursor = join(homeDir, ".cursor");
  mkdirSync(dotCursor, { recursive: true });
  if (platform !== "darwin") return;
  const real = join(realHome, ".cursor", "auth.json");
  const link = join(dotCursor, "auth.json");
  if (existsSync(real) && !existsSync(link)) symlinkSync(real, link);
}

/**
 * The first hook file in the bot's workspace, if any. Cursor runs `.cursor/hooks.json` and the hooks in
 * `.claude/settings.json` without asking, and a bot can write either in its own workspace.
 */
export function workspaceHooks(workspaceDir: string): string | undefined {
  const cursorHooks = join(workspaceDir, ".cursor", "hooks.json");
  if (existsSync(cursorHooks)) return cursorHooks;
  const claudeSettings = join(workspaceDir, ".claude", "settings.json");
  if (!existsSync(claudeSettings)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(claudeSettings, "utf8"));
    if (!isRecord(parsed) || parsed.hooks === undefined) return undefined;
    return isRecord(parsed.hooks) && Object.keys(parsed.hooks).length === 0 ? undefined : claudeSettings;
  } catch {
    // Unreadable: it might hold hooks, so it counts as if it did.
    return claudeSettings;
  }
}

const CANCELLED = { outcome: { outcome: "cancelled" } } as const;
const selected = (optionId: string) => ({ outcome: { outcome: "selected", optionId } });

export class CursorProvider implements AgentProvider {
  readonly id = "cursor" as const;
  private readonly homeDir: string;
  private readonly command: string;
  private readonly connectFn: (cwd: string, signal: AbortSignal) => Promise<LineConnection>;
  private readonly stopGraceMs: number;
  private turnLog: SessionStore | undefined;

  constructor(opts: CursorOptions) {
    this.homeDir = opts.homeDir;
    this.command = opts.command ?? process.env.CURSOR_AGENT_PATH ?? "cursor-agent";
    this.connectFn = opts.connect ?? ((cwd) => this.spawnIsolated(cwd));
    this.stopGraceMs = opts.stopGraceMs ?? 2000;
  }

  /** Each session's turns, as text, for forks. Under the bots' Cursor home; created on first use. */
  private turns(): SessionStore {
    this.turnLog ??= new SessionStore(this.homeDir);
    return this.turnLog;
  }

  info(): ProviderInfo {
    return { label: "Cursor", local: false, configured: findExecutable(this.command) !== undefined };
  }

  /** The models the signed-in Cursor offers, from a session opened in an empty folder. */
  async listModels(signal: AbortSignal): Promise<string[]> {
    const cwd = mkdtempSync(join(tmpdir(), "smarty-cursor-models-"));
    let conn: LineConnection | undefined;
    const abort = () => conn?.close();
    signal.addEventListener("abort", abort, { once: true });
    try {
      try {
        conn = await this.connectFn(cwd, signal);
      } catch (err) {
        if (signal.aborted) throw err;
        throw new NotConfiguredError(
          `Couldn't start Cursor: ${(err as Error).message}. Install it and run "cursor-agent login".`,
        );
      }
      signal.throwIfAborted();
      const rpc = new Rpc(conn, "Cursor");
      await initialize(rpc);
      const opened = await rpc.request("session/new", { cwd, mcpServers: [] });
      const models = isRecord(opened.models) && Array.isArray(opened.models.availableModels) ? opened.models : {};
      return (Array.isArray(models.availableModels) ? models.availableModels : [])
        .filter(isRecord)
        .map((m) => str(m.modelId))
        .filter(Boolean);
    } finally {
      signal.removeEventListener("abort", abort);
      conn?.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  async run(req: RunRequest, cb: RunCallbacks): Promise<RunOutcome> {
    if (req.signal.aborted) return { status: "interrupted", sessionId: req.sessionId };
    const hooks = workspaceHooks(req.workspaceDir);
    if (hooks) {
      return {
        status: "failed",
        sessionId: req.sessionId,
        error: `This bot's folder has hooks Cursor would run without asking (${hooks}). Remove them to use Cursor here.`,
      };
    }
    let conn: LineConnection;
    try {
      conn = await this.connectFn(req.workspaceDir, req.signal);
    } catch (err) {
      if (req.signal.aborted) return { status: "interrupted", sessionId: req.sessionId };
      return { status: "failed", sessionId: req.sessionId, error: `Couldn't start Cursor: ${(err as Error).message}` };
    }
    if (req.signal.aborted) {
      conn.close();
      return { status: "interrupted", sessionId: req.sessionId };
    }

    const rpc = new Rpc(conn, "Cursor");
    let sessionId: string | undefined;
    let live = false; // false while session/load replays history
    let blockSeq = 0;
    let block: { id: string; text: string } | undefined;
    const replyParts: string[] = []; // this turn's text, for the turn log
    const openTools = new Set<string>();
    const toolInputs = new Map<string, Json>(); // tool call id -> its input, for a permission request without one
    let finish: (outcome: RunOutcome) => void = () => {};
    const ended = new Promise<RunOutcome>((resolve) => {
      finish = resolve;
    });
    const sid = () => sessionId ?? req.sessionId;

    /** Ends the text block being streamed, so it gets its final text. */
    const endBlock = () => {
      if (block) {
        cb.emit({ type: "text", blockId: block.id, text: block.text });
        if (block.text.trim()) replyParts.push(block.text);
      }
      block = undefined;
    };
    const closeOpen = () => {
      endBlock();
      for (const id of openTools) cb.emit({ type: "tool_end", toolUseId: id, ok: false });
      openTools.clear();
    };
    const toolStart = (id: string, kind: string, title: string) => {
      if (openTools.has(id)) return;
      endBlock();
      openTools.add(id);
      cb.emit({ type: "tool_start", toolUseId: id, tool: toolName(kind), summary: title || toolName(kind) });
    };
    const toolEnd = (id: string, kind: string, title: string, ok: boolean) => {
      toolStart(id, kind, title);
      openTools.delete(id);
      cb.emit({ type: "tool_end", toolUseId: id, ok });
    };

    rpc.handle(
      (method, params) => {
        if (method !== "session/update" || !live) return;
        if (str(params.sessionId) && str(params.sessionId) !== sessionId) return;
        const update = isRecord(params.update) ? params.update : {};
        const kind = str(update.sessionUpdate);
        if (kind === "agent_message_chunk") {
          const content = isRecord(update.content) ? update.content : {};
          const text = content.type === "text" ? str(content.text) : "";
          if (!text) return;
          if (!block) block = { id: `cursor-text-${++blockSeq}`, text: "" };
          block.text += text;
          cb.emit({ type: "text_delta", blockId: block.id, text });
        } else if (kind === "tool_call" || kind === "tool_call_update") {
          const id = str(update.toolCallId);
          const toolKind = str(update.kind);
          if (!id || toolKind === "think") return;
          if (isRecord(update.rawInput) && Object.keys(update.rawInput).length) toolInputs.set(id, update.rawInput);
          const status = str(update.status);
          if (status === "completed" || status === "failed")
            toolEnd(id, toolKind, str(update.title), status === "completed");
          else if (kind === "tool_call") toolStart(id, toolKind, str(update.title));
        }
      },
      async (method, params) => {
        if (method !== "session/request_permission") throw new Error(`${method} isn't supported here.`);
        const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
        const reject =
          options.find((o) => o.kind === "reject_once") ?? options.find((o) => str(o.kind).startsWith("reject"));
        const rejectAnswer = reject ? selected(str(reject.optionId)) : CANCELLED;
        // Without allow-once it isn't an approval: it's one of Cursor's questions, which are skipped.
        if (!options.some((o) => o.optionId === "allow-once")) return rejectAnswer;
        if (req.signal.aborted) return CANCELLED;
        const call = isRecord(params.toolCall) ? params.toolCall : {};
        const tool = toolName(str(call.kind));
        const decision: ApprovalDecision = await cb.requestApproval(
          {
            tool,
            summary: str(call.title).slice(0, 200) || tool,
            input:
              isRecord(call.rawInput) && Object.keys(call.rawInput).length
                ? call.rawInput
                : (toolInputs.get(str(call.toolCallId)) ?? {}),
          },
          req.signal,
        );
        if (req.signal.aborted) return CANCELLED;
        return decision.allow ? selected("allow-once") : rejectAnswer;
      },
    );
    conn.onExit(() => {
      closeOpen();
      finish(
        req.signal.aborted
          ? { status: "interrupted", sessionId: sid() }
          : { status: "failed", sessionId: sid(), error: `Cursor stopped: ${rpc.ended || "no reason given"}` },
      );
    });

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (sessionId) rpc.notify("session/cancel", { sessionId });
      // Cursor usually ends the prompt at once; if it doesn't, the run ends anyway.
      clearTimeout(graceTimer);
      graceTimer = setTimeout(() => {
        closeOpen();
        finish({ status: "interrupted", sessionId: sid() });
      }, this.stopGraceMs);
    };
    req.signal.addEventListener("abort", onAbort, { once: true });

    try {
      await initialize(rpc);
      // A fork starts a new Cursor session from the log of the one it forks; a resume loads the session itself.
      let history: ChatMessage[] = [];
      if (req.sessionId && req.resumeAt !== undefined) {
        const at = Number(req.resumeAt);
        if (!Number.isInteger(at) || at < 0)
          throw new Error(`Cursor can't continue from checkpoint "${req.resumeAt}".`);
        history = this.turns().load(req.sessionId).slice(0, at);
      } else if (req.sessionId) {
        history = this.turns().load(req.sessionId);
      }
      const forking = req.sessionId !== undefined && req.resumeAt !== undefined;
      const where = { cwd: req.workspaceDir, mcpServers: [] };
      if (req.sessionId && !forking) {
        await rpc.request("session/load", { ...where, sessionId: req.sessionId });
        sessionId = req.sessionId;
      } else {
        const opened = await rpc.request("session/new", where);
        sessionId = str(opened.sessionId);
        if (!sessionId) throw new Error("Cursor didn't open a session.");
      }
      live = true;
      cb.emit({ type: "session", sessionId });
      if (req.model) await rpc.request("session/set_model", { sessionId, modelId: req.model });
      if (req.signal.aborted) return { status: "interrupted", sessionId };
      const text = req.sessionId && !forking ? req.prompt : firstPrompt(req.instructions, history, req.prompt);
      const opened = sessionId;
      const prompted = rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }).then(
        (result): RunOutcome => {
          closeOpen();
          const outcome = outcomeOf(str(result.stopReason), opened);
          if (outcome.status !== "failed") {
            // The turn goes in the log, and the checkpoint is how far the log got.
            const log: ChatMessage[] = [
              ...history,
              { role: "user", text: req.prompt },
              { role: "assistant", text: replyParts.join("\n\n"), toolCalls: [] },
            ];
            this.turns().save(opened, log);
            cb.emit({ type: "checkpoint", at: String(log.length) });
          }
          return outcome;
        },
        (err: unknown): RunOutcome => {
          closeOpen();
          if (req.signal.aborted) return { status: "interrupted", sessionId: sid() };
          return { status: "failed", sessionId: sid(), error: (err as Error).message };
        },
      );
      if (req.signal.aborted) onAbort();
      return await Promise.race([prompted, ended]);
    } catch (err) {
      closeOpen();
      if (req.signal.aborted) return { status: "interrupted", sessionId: sid() };
      return { status: "failed", sessionId: sid(), error: (err as Error).message };
    } finally {
      req.signal.removeEventListener("abort", onAbort);
      clearTimeout(graceTimer);
      conn.close();
    }
  }

  /** Spawns `cursor-agent acp` with a home of its own (no user MCP servers, hooks, plugins or approval settings). */
  private async spawnIsolated(cwd: string): Promise<LineConnection> {
    prepareHome(this.homeDir);
    return spawnLines(this.command, ["acp"], cwd, isolatedEnv(this.homeDir), "Cursor");
  }
}

async function initialize(rpc: Rpc): Promise<void> {
  await rpc.request("initialize", {
    protocolVersion: 1,
    // No file or terminal access of ours: Cursor's agent uses its own tools, which ask through permissions.
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "smartyprompts", title: "SmartyPrompts", version: "0.1.0" },
  });
}

/**
 * The text of a new session's first prompt. ACP has no system prompt, so it carries the bot's instructions, and on a
 * fork the conversation up to the checkpoint.
 */
export function firstPrompt(instructions: string, history: readonly ChatMessage[], prompt: string): string {
  const parts: string[] = [];
  if (instructions.trim()) parts.push(`<instructions>\n${instructions.trim()}\n</instructions>`);
  const turns = history.flatMap((m) =>
    m.role === "user" ? [`User: ${m.text}`] : m.role === "assistant" && m.text ? [`You: ${m.text}`] : [],
  );
  if (turns.length) parts.push(`<earlier_conversation>\n${turns.join("\n\n")}\n</earlier_conversation>`);
  parts.push(prompt);
  return parts.join("\n\n");
}

/** The run's outcome from ACP's stop reason. */
export function outcomeOf(stopReason: string, sessionId: string | undefined): RunOutcome {
  if (stopReason === "cancelled") return { status: "interrupted", sessionId };
  if (stopReason === "refusal") return { status: "failed", sessionId, error: "The model declined to answer." };
  return { status: "finished", sessionId };
}
