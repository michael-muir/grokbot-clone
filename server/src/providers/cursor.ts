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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs";
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
const toolName = (kind: string): string => (Object.hasOwn(TOOL_NAMES, kind) ? TOOL_NAMES[kind] : kind) || "Tool";

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

/**
 * Creates the bots' Cursor home. On macOS the sign-in lives in ~/.cursor/auth.json, so it's linked, never read.
 * Checked on every start: if Cursor replaced the link with a file (a refreshed sign-in written by rename), that file
 * is the newer sign-in, so it's moved back over the user's own, and the link made again.
 */
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
  let stat: ReturnType<typeof lstatSync> | undefined;
  try {
    stat = lstatSync(link);
  } catch {
    stat = undefined;
  }
  if (stat && !stat.isSymbolicLink()) {
    try {
      renameSync(link, real);
    } catch (err) {
      // On another volume it can't be moved; it's dropped, and Cursor may ask the user to sign in again.
      console.warn(`cursor: couldn't move a refreshed sign-in back (${(err as Error).message})`);
      rmSync(link, { force: true });
    }
    stat = undefined;
  }
  if (!stat && existsSync(real)) symlinkSync(real, link);
}

/** Workspace files whose hooks Cursor runs without asking: its own, and Claude's (it reads those too). */
const HOOK_FILES = [
  [".cursor", "hooks.json"],
  [".claude", "settings.json"],
  [".claude", "settings.local.json"],
] as const;

/** The first hook file in the bot's workspace, if any. A bot can write these in its own workspace. */
export function workspaceHooks(workspaceDir: string): string | undefined {
  for (const [dir, name] of HOOK_FILES) {
    const file = join(workspaceDir, dir, name);
    if (!existsSync(file)) continue;
    if (name === "hooks.json") return file;
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!isRecord(parsed) || parsed.hooks === undefined) continue;
      if (isRecord(parsed.hooks) && Object.keys(parsed.hooks).length === 0) continue;
      return file;
    } catch {
      // Unreadable: it might hold hooks, so it counts as if it did.
      return file;
    }
  }
  return undefined;
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
      // The killed process may still hold the folder (Windows); retry, and never let cleanup hide the answer.
      try {
        rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (err) {
        console.warn(`cursor: couldn't remove ${cwd} (${(err as Error).message})`);
      }
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
    const endedTools = new Set<string>(); // a repeated final update doesn't make a second step
    const thinking = new Set<string>(); // "think" calls are Cursor's reasoning, not steps
    const calls = new Map<string, { kind: string; title: string; input?: Json }>(); // what each call's tool_call said
    let finish: (outcome: RunOutcome) => void = () => {};
    const ended = new Promise<RunOutcome>((resolve) => {
      finish = resolve;
    });
    const sid = () => sessionId ?? req.sessionId;
    // Once run() has returned, the setup steps still settling (rejected as the process closes) report nothing.
    let over = false;
    const emit: RunCallbacks["emit"] = (event) => {
      if (!over) cb.emit(event);
    };

    /** Ends the text block being streamed, so it gets its final text. */
    const endBlock = () => {
      if (block) {
        emit({ type: "text", blockId: block.id, text: block.text });
        if (block.text.trim()) replyParts.push(block.text);
      }
      block = undefined;
    };
    const closeOpen = () => {
      endBlock();
      for (const id of openTools) emit({ type: "tool_end", toolUseId: id, ok: false });
      openTools.clear();
    };
    const toolStart = (id: string, kind: string, title: string) => {
      if (openTools.has(id) || endedTools.has(id)) return;
      endBlock();
      openTools.add(id);
      emit({ type: "tool_start", toolUseId: id, tool: toolName(kind), summary: title || toolName(kind) });
    };
    const toolEnd = (id: string, kind: string, title: string, ok: boolean) => {
      if (endedTools.has(id)) return;
      toolStart(id, kind, title);
      openTools.delete(id);
      endedTools.add(id);
      emit({ type: "tool_end", toolUseId: id, ok });
    };

    // The turn log, for forks. A fork starts from the log of the session it forks; a resume continues the session's.
    let history: ChatMessage[] = [];
    let prompting = false; // the prompt went to Cursor, so its session now holds this turn
    let logged = false;
    /** Logs this turn (once) and reports the checkpoint: how many messages the log holds. Not for a failed turn. */
    const logTurn = () => {
      if (over || logged || !prompting || !sessionId) return;
      logged = true;
      const log: ChatMessage[] = [
        ...history,
        { role: "user", text: req.prompt },
        { role: "assistant", text: replyParts.join("\n\n"), toolCalls: [] },
      ];
      try {
        this.turns().save(sessionId, log);
        emit({ type: "checkpoint", at: String(log.length) });
      } catch (err) {
        // Without the log the turn just leaves no checkpoint; the reply itself is fine.
        console.warn(`cursor: couldn't save the turn log (${(err as Error).message})`);
      }
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
          emit({ type: "text_delta", blockId: block.id, text });
        } else if (kind === "tool_call" || kind === "tool_call_update") {
          const id = str(update.toolCallId);
          if (!id) return;
          // Updates carry only what changed, so the kind and title come from what the call said before.
          const known = calls.get(id);
          const call = {
            kind: str(update.kind) || known?.kind || "",
            title: str(update.title) || known?.title || "",
            input: isRecord(update.rawInput) && Object.keys(update.rawInput).length ? update.rawInput : known?.input,
          };
          calls.set(id, call);
          if (call.kind === "think") thinking.add(id);
          if (thinking.has(id)) return;
          const status = str(update.status);
          if (status === "completed" || status === "failed") toolEnd(id, call.kind, call.title, status === "completed");
          else if (kind === "tool_call") toolStart(id, call.kind, call.title);
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
        const known = calls.get(str(call.toolCallId));
        const tool = toolName(str(call.kind) || known?.kind || "");
        const decision: ApprovalDecision = await cb.requestApproval(
          {
            tool,
            summary: (str(call.title) || known?.title || tool).slice(0, 200),
            input: isRecord(call.rawInput) && Object.keys(call.rawInput).length ? call.rawInput : (known?.input ?? {}),
          },
          req.signal,
        );
        if (req.signal.aborted) return CANCELLED;
        return decision.allow ? selected("allow-once") : rejectAnswer;
      },
    );
    conn.onExit(() => {
      closeOpen();
      if (req.signal.aborted) logTurn();
      finish(
        req.signal.aborted
          ? { status: "interrupted", sessionId: sid() }
          : { status: "failed", sessionId: sid(), error: `Cursor stopped: ${rpc.ended || "no reason given"}` },
      );
    });

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (sessionId) rpc.notify("session/cancel", { sessionId });
      // Cursor usually ends the prompt at once; if it doesn't, or setup hangs, the run ends anyway.
      clearTimeout(graceTimer);
      graceTimer = setTimeout(() => {
        closeOpen();
        logTurn();
        finish({ status: "interrupted", sessionId: sid() });
      }, this.stopGraceMs);
    };
    req.signal.addEventListener("abort", onAbort, { once: true });

    /** Setup and the prompt. Raced against `ended`, so Stop or an exit ends the run even while a step hangs. */
    const work = async (): Promise<RunOutcome> => {
      try {
        await initialize(rpc);
        const forking = req.sessionId !== undefined && req.resumeAt !== undefined;
        if (req.sessionId && forking) {
          const at = Number(req.resumeAt);
          if (!Number.isInteger(at) || at < 0) {
            throw new Error(`Cursor can't continue from checkpoint "${req.resumeAt}".`);
          }
          history = this.turns().load(req.sessionId).slice(0, at);
        } else if (req.sessionId) {
          history = this.turns().load(req.sessionId);
        }
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
        emit({ type: "session", sessionId });
        if (req.model) await rpc.request("session/set_model", { sessionId, modelId: req.model });
        if (req.signal.aborted) return { status: "interrupted", sessionId };
        const text = req.sessionId && !forking ? req.prompt : firstPrompt(req.instructions, history, req.prompt);
        prompting = true;
        const result = await rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
        closeOpen();
        const outcome = outcomeOf(str(result.stopReason), sessionId);
        if (outcome.status !== "failed") logTurn();
        return outcome;
      } catch (err) {
        closeOpen();
        if (req.signal.aborted) {
          logTurn();
          return { status: "interrupted", sessionId: sid() };
        }
        return { status: "failed", sessionId: sid(), error: (err as Error).message };
      }
    };

    try {
      const running = work();
      if (req.signal.aborted) onAbort();
      return await Promise.race([running, ended]);
    } finally {
      over = true;
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
