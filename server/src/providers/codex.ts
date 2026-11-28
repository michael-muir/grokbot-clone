// Codex provider (#25): drives the user's own signed-in Codex CLI through `codex app-server` (JSON-RPC over stdio).
//
// Mapping to the gateway contract:
//   thread/start | thread/resume | thread/fork(lastTurnId) -> session (the thread id); resumeAt forks at a turn
//   item/agentMessage/delta, item/completed agentMessage   -> text_delta, text
//   item/started|completed commandExecution, fileChange    -> tool_start, tool_end
//   item/commandExecution|fileChange/requestApproval       -> approval cards
//   thread/tokenUsage/updated                              -> usage
//   turn/completed                                         -> checkpoint (the turn id) and the outcome
//
// Isolation: the user's Codex setup brings plugins (computer use, browser), their MCP servers and a notify hook.
// A bot mustn't inherit tools that act outside its workspace, so every run switches those off (codexArgs).
import { execFile } from "node:child_process";
import { childEnv } from "../child-env.ts";
import { NotConfiguredError } from "../errors.ts";
import type { AgentProvider, ProviderInfo, RunCallbacks, RunOutcome, RunRequest } from "../types.ts";
import { findExecutable, type Json, type LineConnection, launchSpec, Rpc, spawnLines } from "./stdio-rpc.ts";

/** A connection to one `codex app-server` process. Tests replace it with a scripted server. */
export type CodexConnection = LineConnection;
export { findExecutable };

/**
 * Codex features that reach outside the workspace or run code at turn ends: off for every bot run. Not
 * `code_mode_host`: that's the shell host, the bot's command tool, and its commands ask first (untrusted policy).
 */
export const DISABLED_FEATURES = [
  "apps",
  "plugins",
  "remote_plugin",
  "computer_use",
  "browser_use",
  "browser_use_external",
  "in_app_browser",
  "hooks",
  "image_generation",
] as const;

/** An MCP server name Codex's `-c` can address: its key path splits on dots and has no quoting. */
export const isPlainMcpName = (name: string): boolean => /^[\w-]+$/.test(name);

/**
 * The flags that isolate a run from the user's own Codex extras; `mcpNames` are the MCP servers still enabled.
 * Throws for a name `-c` can't address: that server would stay on, so the run must not start.
 */
export function codexArgs(mcpNames: readonly string[]): string[] {
  const odd = mcpNames.filter((n) => !isPlainMcpName(n));
  if (odd.length) {
    throw new Error(
      `Codex has an MCP server this app can't switch off for bots (${odd.map((n) => JSON.stringify(n.slice(0, 40))).join(", ")}). Rename it in Codex's config, or turn it off there.`,
    );
  }
  return [
    ...DISABLED_FEATURES.flatMap((f) => ["--disable", f]),
    "-c",
    "notify=[]",
    ...mcpNames.flatMap((n) => ["-c", `mcp_servers.${n}.enabled=false`]),
  ];
}

export interface CodexOptions {
  /** Opens the connection for a run in `cwd`, giving up when `signal` fires. Defaults to spawning `codex app-server`. */
  connect?: (cwd: string, signal: AbortSignal) => Promise<CodexConnection>;
  /** The Codex executable: CODEX_PATH, or `codex` on the PATH. */
  command?: string;
  /** How long Stop waits for Codex to end the turn before the process is killed. */
  stopGraceMs?: number;
}

const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export class CodexProvider implements AgentProvider {
  readonly id = "codex" as const;
  private readonly command: string;
  private readonly connectFn: (cwd: string, signal: AbortSignal) => Promise<CodexConnection>;
  private readonly stopGraceMs: number;

  constructor(opts: CodexOptions = {}) {
    this.command = opts.command ?? process.env.CODEX_PATH ?? "codex";
    this.connectFn = opts.connect ?? ((cwd, signal) => this.spawnIsolated(cwd, signal));
    this.stopGraceMs = opts.stopGraceMs ?? 2000;
  }

  info(): ProviderInfo {
    return { label: "Codex", local: false, configured: findExecutable(this.command) !== undefined };
  }

  /** The models the signed-in Codex offers; also how Settings checks that Codex is installed and signed in. */
  async listModels(signal: AbortSignal): Promise<string[]> {
    let conn: CodexConnection;
    try {
      conn = await this.connectFn(process.cwd(), signal);
    } catch (err) {
      if (signal.aborted) throw err;
      throw new NotConfiguredError(
        `Couldn't start Codex: ${(err as Error).message}. Install it and run "codex login".`,
      );
    }
    if (signal.aborted) {
      conn.close();
      throw new Error("Stopped.");
    }
    const rpc = new Rpc(conn, "Codex");
    const abort = () => conn.close(true);
    signal.addEventListener("abort", abort, { once: true });
    try {
      await this.initialize(rpc);
      const list = await rpc.request("model/list", {});
      const data = Array.isArray(list.data) ? list.data : [];
      return data
        .filter((m): m is Json => isRecord(m) && m.hidden !== true)
        .map((m) => str(m.id))
        .filter(Boolean);
    } finally {
      signal.removeEventListener("abort", abort);
      conn.close();
    }
  }

  async run(req: RunRequest, cb: RunCallbacks): Promise<RunOutcome> {
    if (req.signal.aborted) return { status: "interrupted", sessionId: req.sessionId };
    let conn: CodexConnection;
    try {
      conn = await this.connectFn(req.workspaceDir, req.signal);
    } catch (err) {
      if (req.signal.aborted) return { status: "interrupted", sessionId: req.sessionId };
      return { status: "failed", error: `Couldn't start Codex: ${(err as Error).message}` };
    }
    if (req.signal.aborted) {
      conn.close();
      return { status: "interrupted", sessionId: req.sessionId };
    }
    const rpc = new Rpc(conn, "Codex");
    let threadId: string | undefined; // set from Codex's answer; until then nothing is filtered by thread
    let turnId: string | undefined;
    const openText = new Map<string, string>(); // item id -> text streamed so far
    const openTools = new Set<string>();
    let lastError: string | undefined;
    const earlyUsage: Json[] = []; // usage that came before the turn's id was known
    const countUsage = (params: Json) => {
      if (turnId && str(params.turnId) && str(params.turnId) !== turnId) return;
      const usage = isRecord(params.tokenUsage) && isRecord(params.tokenUsage.last) ? params.tokenUsage.last : {};
      cb.emit({ type: "usage", inputTokens: num(usage.inputTokens), outputTokens: num(usage.outputTokens) });
    };
    let finish: (outcome: RunOutcome) => void = () => {};
    const done = new Promise<RunOutcome>((resolve) => {
      finish = resolve;
    });

    const toolStart = (id: string, tool: string, summary: string) => {
      if (openTools.has(id)) return;
      openTools.add(id);
      cb.emit({ type: "tool_start", toolUseId: id, tool, summary });
    };
    const toolEnd = (id: string, tool: string, summary: string, ok: boolean) => {
      toolStart(id, tool, summary);
      openTools.delete(id);
      cb.emit({ type: "tool_end", toolUseId: id, ok });
    };
    /** Closes what a turn left open, so every streamed block ends and every step has its end. */
    const closeOpen = () => {
      for (const [id, text] of openText) cb.emit({ type: "text", blockId: id, text });
      openText.clear();
      for (const id of openTools) cb.emit({ type: "tool_end", toolUseId: id, ok: false });
      openTools.clear();
    };

    rpc.handle(
      (method, params) => {
        if (str(params.threadId) && threadId && str(params.threadId) !== threadId) return;
        if (method === "item/agentMessage/delta") {
          const id = str(params.itemId);
          const delta = str(params.delta);
          if (!id || !delta) return;
          openText.set(id, (openText.get(id) ?? "") + delta);
          cb.emit({ type: "text_delta", blockId: id, text: delta });
        } else if (method === "item/started" || method === "item/completed") {
          const item = isRecord(params.item) ? params.item : {};
          const id = str(item.id);
          const type = str(item.type);
          if (!id) return;
          if (type === "agentMessage" && method === "item/completed") {
            const streamed = openText.has(id);
            const text = str(item.text) || openText.get(id) || "";
            openText.delete(id);
            if (text.trim() || streamed) cb.emit({ type: "text", blockId: id, text });
          } else if (type === "commandExecution") {
            const summary = `Running ${shownCommand(str(item.command)).slice(0, 120)}`;
            if (method === "item/started") toolStart(id, "Bash", summary);
            else toolEnd(id, "Bash", summary, str(item.status) === "completed" && num(item.exitCode) === 0);
          } else if (type === "fileChange") {
            if (method === "item/started") toolStart(id, "Edit", "Changing files");
            else toolEnd(id, "Edit", "Changing files", str(item.status) === "completed");
          }
        } else if (method === "thread/tokenUsage/updated") {
          // A resumed thread first replays its last turn's usage; only this turn's counts.
          if (turnId === undefined) earlyUsage.push(params);
          else countUsage(params);
        } else if (method === "error") {
          const error = isRecord(params.error) ? params.error : {};
          if (params.willRetry !== true && str(error.message)) lastError = str(error.message);
        } else if (method === "turn/completed") {
          const turn = isRecord(params.turn) ? params.turn : {};
          if (turnId && str(turn.id) && str(turn.id) !== turnId) return;
          closeOpen();
          const status = str(turn.status);
          if (str(turn.id) && (status === "completed" || status === "interrupted")) {
            cb.emit({ type: "checkpoint", at: str(turn.id) });
          }
          const turnError = isRecord(turn.error) ? str(turn.error.message) : "";
          finish(
            status === "completed"
              ? { status: "finished", sessionId: threadId ?? req.sessionId }
              : status === "interrupted"
                ? { status: "interrupted", sessionId: threadId ?? req.sessionId }
                : {
                    status: "failed",
                    sessionId: threadId ?? req.sessionId,
                    error: turnError || lastError || "Codex stopped with an error.",
                  },
          );
        }
      },
      async (method, params) => {
        if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
          const command = Array.isArray(params.command) ? params.command.map(str).join(" ") : str(params.command);
          const decision = await cb.requestApproval(
            {
              tool: "Bash",
              summary: `Running ${shownCommand(command).slice(0, 120)}`,
              input: { command, cwd: str(params.cwd) },
            },
            req.signal,
          );
          return approvalAnswer(method, decision, req.signal.aborted);
        }
        if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
          const decision = await cb.requestApproval(
            { tool: "Edit", summary: "Changing files", input: { reason: str(params.reason) } },
            req.signal,
          );
          return approvalAnswer(method, decision, req.signal.aborted);
        }
        throw new Error(`${method} isn't supported here.`);
      },
    );
    conn.onExit(() => {
      closeOpen();
      finish(
        req.signal.aborted
          ? { status: "interrupted", sessionId: threadId ?? req.sessionId }
          : {
              status: "failed",
              sessionId: threadId ?? req.sessionId,
              error: `Codex stopped: ${rpc.ended || "no reason given"}`,
            },
      );
    });

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (threadId && turnId) rpc.request("turn/interrupt", { threadId, turnId }).catch(() => {});
      // Codex usually ends the turn at once; if it doesn't, the run ends anyway.
      clearTimeout(graceTimer);
      graceTimer = setTimeout(() => {
        closeOpen();
        finish({ status: "interrupted", sessionId: threadId ?? req.sessionId });
      }, this.stopGraceMs).unref?.();
    };
    req.signal.addEventListener("abort", onAbort, { once: true });

    try {
      await this.initialize(rpc);
      const threadParams: Json = {
        cwd: req.workspaceDir,
        approvalPolicy: "untrusted",
        sandbox: "workspace-write",
        developerInstructions: req.instructions,
        ...(req.model ? { model: req.model } : {}),
      };
      const opened =
        req.sessionId && req.resumeAt !== undefined
          ? await rpc.request("thread/fork", { ...threadParams, threadId: req.sessionId, lastTurnId: req.resumeAt })
          : req.sessionId
            ? await rpc.request("thread/resume", { ...threadParams, threadId: req.sessionId })
            : await rpc.request("thread/start", threadParams);
      threadId = isRecord(opened.thread) ? str(opened.thread.id) : "";
      if (!threadId) throw new Error("Codex didn't open a thread.");
      cb.emit({ type: "session", sessionId: threadId ?? req.sessionId });
      if (req.signal.aborted) return { status: "interrupted", sessionId: threadId ?? req.sessionId };
      const started = await rpc.request("turn/start", {
        threadId,
        input: [{ type: "text", text: req.prompt, text_elements: [] }],
      });
      turnId = isRecord(started.turn) ? str(started.turn.id) : "";
      if (!turnId) throw new Error("Codex didn't start a turn.");
      for (const params of earlyUsage.splice(0)) countUsage(params);
      if (req.signal.aborted) onAbort();
      return await done;
    } catch (err) {
      if (req.signal.aborted) return { status: "interrupted", sessionId: threadId ?? req.sessionId };
      return { status: "failed", sessionId: threadId ?? req.sessionId, error: (err as Error).message };
    } finally {
      req.signal.removeEventListener("abort", onAbort);
      clearTimeout(graceTimer);
      conn.close();
    }
  }

  private async initialize(rpc: Rpc): Promise<void> {
    await rpc.request("initialize", {
      clientInfo: { name: "smartyprompts", title: "SmartyPrompts", version: "0.1.0" },
      capabilities: null,
    });
    rpc.notify("initialized");
  }

  /** Spawns `codex app-server` with the user's plugins, hooks and MCP servers switched off. */
  private async spawnIsolated(cwd: string, signal: AbortSignal): Promise<CodexConnection> {
    const names = await this.enabledMcpServers(cwd, signal);
    signal.throwIfAborted();
    return spawnLines(this.command, ["app-server", ...codexArgs(names)], cwd, childEnv(), "Codex");
  }

  /** The MCP servers the user's Codex config still enables, once plugins are off: only their names are read. */
  private enabledMcpServers(cwd: string, signal: AbortSignal): Promise<string[]> {
    const args = [...codexArgs([]), "mcp", "list", "--json"];
    const launch = launchSpec(this.command, args);
    const opts = { cwd, env: childEnv(), windowsHide: true, timeout: 20_000, signal, shell: launch.shell };
    return new Promise((resolve, reject) => {
      execFile(launch.file, launch.args, opts, (err, stdout) => {
        if (err) return reject(new Error(err.message.split("\n")[0] ?? "codex mcp list failed"));
        try {
          resolve(enabledMcpNames(stdout));
        } catch (e) {
          reject(e);
        }
      });
    });
  }
}

/**
 * The servers to switch off, from `codex mcp list --json`. Strict: a list in another form is an error, and a server
 * counts as enabled unless it says otherwise, so a change in Codex's output can't quietly leave servers on.
 */
export function enabledMcpNames(stdout: string): string[] {
  let list: unknown;
  try {
    list = JSON.parse(stdout);
  } catch {
    list = undefined;
  }
  if (!Array.isArray(list) || !list.every((s) => isRecord(s) && typeof s.name === "string")) {
    throw new Error("Codex listed its MCP servers in a form this app doesn't read.");
  }
  return list.filter((s: Json) => s.enabled !== false).map((s: Json) => str(s.name));
}

/**
 * The command as the user would type it. On Windows Codex wraps each one as `"...\powershell.exe" -Command '<cmd>'`;
 * the card's input keeps the whole line.
 */
export function shownCommand(command: string): string {
  // Only Codex's exact form: one quoted argument, nothing after it. Inside single quotes '' is a quote; double
  // quotes hold no quote at all. Anything else is shown whole, so a card never hides part of a command.
  const wrapped =
    /^"?[^"]*?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?-Command\s+(?:'((?:[^']|'')*)'|"([^"]*)")$/i.exec(
      command.trim(),
    );
  if (!wrapped) return command;
  return wrapped[1] !== undefined ? wrapped[1].replaceAll("''", "'") : (wrapped[2] ?? command);
}

/** Our approval decision in the shape Codex asked for (the v2 requests, or the legacy ones). */
function approvalAnswer(
  method: string,
  decision: { allow: true } | { allow: false; reason: string },
  stopped: boolean,
): Json {
  const legacy = method === "execCommandApproval" || method === "applyPatchApproval";
  if (legacy)
    return { decision: decision.allow ? "approved" : stopped ? "abort" : { denied: { rejection: decision.reason } } };
  return { decision: decision.allow ? "accept" : stopped ? "cancel" : "decline" };
}
