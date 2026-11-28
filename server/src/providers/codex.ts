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
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { childEnv } from "../child-env.ts";
import { NotConfiguredError } from "../errors.ts";
import type { AgentProvider, ProviderInfo, RunCallbacks, RunOutcome, RunRequest } from "../types.ts";

/** Codex features that reach outside the workspace or run code at turn ends: off for every bot run. */
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
  "code_mode_host",
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

/** A line-based connection to one app-server process. Tests replace it with a scripted server. */
export interface CodexConnection {
  send(line: string): void;
  onLine(fn: (line: string) => void): void;
  /** Called once if the process ends; `detail` is the end of its stderr. */
  onExit(fn: (detail: string) => void): void;
  close(): void;
}

export interface CodexOptions {
  /** Opens the connection for a run in `cwd`, giving up when `signal` fires. Defaults to spawning `codex app-server`. */
  connect?: (cwd: string, signal: AbortSignal) => Promise<CodexConnection>;
  /** The Codex executable: CODEX_PATH, or `codex` on the PATH. */
  command?: string;
  /** How long Stop waits for Codex to end the turn before the process is killed. */
  stopGraceMs?: number;
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The process's last stderr lines, kept for an error message. Codex gets no keys (childEnv), so none can show. */
const TAIL_CHARS = 400;

/**
 * How to launch `command`: npm installs Codex on Windows as a `.cmd` shim, which only a shell can start. That's safe
 * here because every argument is one of ours: fixed flags, and MCP names already limited to word characters.
 */
function launchSpec(command: string): { file: string; shell: boolean } {
  const file = findExecutable(command) ?? command;
  return { file, shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(file) };
}

function spawnCodex(command: string, args: string[], cwd: string): CodexConnection {
  const { file, shell } = launchSpec(command);
  const child: ChildProcess = spawn(shell ? `"${file}"` : file, args, {
    cwd,
    env: childEnv(),
    windowsHide: true,
    shell,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let tail = "";
  const lineHandlers: ((line: string) => void)[] = [];
  const exitHandlers: ((detail: string) => void)[] = [];
  let exited = false;
  const exit = (detail: string) => {
    if (exited) return;
    exited = true;
    for (const h of exitHandlers) h(detail);
  };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) for (const h of lineHandlers) h(line);
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-TAIL_CHARS);
  });
  child.on("error", (err) => exit(err.message));
  // A write after Codex died, before "exit" arrives, is EPIPE: that ends the run, not the gateway.
  child.stdin?.on("error", (err) => {
    console.warn(`codex: couldn't write to Codex (${err.message})`);
    exit(tail.trim().split("\n").at(-1) || err.message);
  });
  child.on("exit", () => exit(tail.trim().split("\n").at(-1) ?? ""));
  return {
    send: (line) => {
      if (!exited) child.stdin?.write(`${line}\n`);
    },
    onLine: (fn) => lineHandlers.push(fn),
    onExit: (fn) => exitHandlers.push(fn),
    close: () => {
      child.stdin?.end();
      if (!exited) child.kill();
    },
  };
}

/** JSON-RPC over a CodexConnection: requests, notifications, and answering the server's requests. */
class Rpc {
  private next = 1;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private onNotify: (method: string, params: Json) => void = () => {};
  private onRequest: (method: string, params: Json) => Promise<unknown> = async () => {
    throw new Error("not supported here");
  };
  private readonly conn: CodexConnection;
  ended: string | undefined;

  constructor(conn: CodexConnection) {
    this.conn = conn;
    conn.onLine((line) => this.receive(line));
    conn.onExit((detail) => {
      this.ended = detail || "Codex stopped.";
      for (const p of this.pending.values()) p.reject(new Error(this.ended));
      this.pending.clear();
    });
  }

  handle(notify: (method: string, params: Json) => void, request: (method: string, params: Json) => Promise<unknown>) {
    this.onNotify = notify;
    this.onRequest = request;
  }

  request(method: string, params: Json): Promise<Json> {
    if (this.ended !== undefined) return Promise.reject(new Error(this.ended));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (v) => resolve(isRecord(v) ? v : {}), reject });
      this.conn.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method: string, params?: Json): void {
    this.conn.send(JSON.stringify({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }));
  }

  private receive(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      console.warn("codex: a line that isn't JSON was ignored");
      return;
    }
    if (!isRecord(msg)) return;
    const method = typeof msg.method === "string" ? msg.method : undefined;
    const params = isRecord(msg.params) ? msg.params : {};
    if (method && msg.id !== undefined) {
      // A request from Codex: answer it, even when we can't do what it asks.
      const id = msg.id;
      this.onRequest(method, params).then(
        (result) => this.conn.send(JSON.stringify({ jsonrpc: "2.0", id, result })),
        (err: unknown) =>
          this.conn.send(
            JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: (err as Error).message } }),
          ),
      );
      return;
    }
    if (method) {
      this.onNotify(method, params);
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (isRecord(msg.error)) p.reject(new Error(str(msg.error.message) || "Codex refused the request."));
      else p.resolve(msg.result);
    }
  }
}

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
    const rpc = new Rpc(conn);
    const abort = () => conn.close();
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
    const rpc = new Rpc(conn);
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
            const summary = `Running ${str(item.command).slice(0, 120)}`;
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
            { tool: "Bash", summary: `Running ${command.slice(0, 120)}`, input: { command, cwd: str(params.cwd) } },
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
    return spawnCodex(this.command, ["app-server", ...codexArgs(names)], cwd);
  }

  /** The MCP servers the user's Codex config still enables, once plugins are off: only their names are read. */
  private enabledMcpServers(cwd: string, signal: AbortSignal): Promise<string[]> {
    const args = [...codexArgs([]), "mcp", "list", "--json"];
    const { file, shell } = launchSpec(this.command);
    const opts = { cwd, env: childEnv(), windowsHide: true, timeout: 20_000, signal, shell };
    return new Promise((resolve, reject) => {
      execFile(shell ? `"${file}"` : file, args, opts, (err, stdout) => {
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

/** Where `command` resolves: a path that exists, or the first match on the PATH (with Windows' extensions). */
export function findExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return exists(command) ? command : undefined;
  }
  const exts = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const path = join(dir, command + ext.toLowerCase());
      if (exists(path)) return path;
    }
  }
  return undefined;
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
