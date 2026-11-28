// Talking to an agent CLI over stdio: a line-based process connection and a JSON-RPC 2.0 client on top of it.
// Shared by the Codex (app-server) and Cursor (ACP) providers.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A line-based connection to one agent process. Tests replace it with a scripted server. */
export interface LineConnection {
  send(line: string): void;
  onLine(fn: (line: string) => void): void;
  /** Called once when the process ends (at once if it already has); `detail` is the end of its stderr. */
  onExit(fn: (detail: string) => void): void;
  /** Ends the process: by closing its input so it can save, or with `now` (a Stop or a timeout) by killing it. */
  close(now?: boolean): void;
}

/** The process's last stderr, kept for an error message. Callers pass an env without keys, so none can show. */
const TAIL_CHARS = 400;

/**
 * How to launch `command`: npm installs CLIs on Windows as `.cmd` shims, which only a shell can start. Callers keep
 * that safe by passing only arguments of their own: fixed flags, and names limited to word characters.
 */
export function launchSpec(command: string, args: readonly string[]): { file: string; args: string[]; shell: boolean } {
  const file = findExecutable(command) ?? command;
  if (!(process.platform === "win32" && /\.(cmd|bat)$/i.test(file))) return { file, args: [...args], shell: false };
  // Through the shell the arguments are one command line, so each must be plain: nothing a shell would read. The
  // path is quoted, but cmd still expands % and ! inside quotes and ends them at a quote.
  if (/[%!^&|<>"]/.test(file)) {
    throw new Error(
      `The path ${JSON.stringify(file)} has characters the Windows shell would change. Move it, or set its path without them.`,
    );
  }
  const odd = args.find((a) => !/^[\w.=:/[\]-]+$/.test(a));
  if (odd !== undefined) throw new Error(`An argument can't be passed through the shell: ${JSON.stringify(odd)}`);
  return { file: [`"${file}"`, ...args].join(" "), args: [], shell: true };
}

/** How long a closed process may take to exit on its own before it's killed. */
export const EXIT_GRACE_MS = 3000;

/** Every agent process still running, so the gateway can end them all when it exits. */
const running = new Set<ChildProcess>();

/** Kills every agent process still running, with its tree. For the gateway's shutdown. */
export function endAllNow(): void {
  for (const child of running) killTree(child);
  running.clear();
}

/** Kills a process and everything it started. */
function killTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", (err) => {
      console.warn(`couldn't end process ${child.pid} (${err.message})`);
      child.kill();
    });
    return;
  }
  child.kill("SIGKILL");
}

/** Spawns `command` as a LineConnection; `name` is used in log lines. */
export function spawnLines(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  name: string,
  opts: { exitGraceMs?: number } = {},
): LineConnection {
  const exitGraceMs = opts.exitGraceMs ?? EXIT_GRACE_MS;
  const launch = launchSpec(command, args);
  const child: ChildProcess = spawn(launch.file, launch.args, {
    cwd,
    env,
    windowsHide: true,
    shell: launch.shell,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let tail = "";
  const lineHandlers: ((line: string) => void)[] = [];
  const exitHandlers: ((detail: string) => void)[] = [];
  let exited = false;
  let exitDetail = "";
  const exit = (detail: string) => {
    if (exited) return;
    exited = true;
    exitDetail = detail;
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
  // A write after the process died, before "exit" arrives, is EPIPE: that ends the run, not the gateway.
  child.stdin?.on("error", (err) => {
    console.warn(`${name.toLowerCase()}: couldn't write to ${name} (${err.message})`);
    exit(tail.trim().split("\n").at(-1) || err.message);
  });
  running.add(child);
  let gone = false; // the process itself has exited (not just a failed write)
  child.on("exit", () => {
    gone = true;
    running.delete(child);
    exit(tail.trim().split("\n").at(-1) ?? "");
  });
  return {
    send: (line) => {
      if (!exited) child.stdin?.write(`${line}\n`);
    },
    onLine: (fn) => lineHandlers.push(fn),
    onExit: (fn) => {
      if (exited) fn(exitDetail);
      else exitHandlers.push(fn);
    },
    // Closing input lets the CLI finish and save (Cursor writes its conversation on the way out). Only one that
    // doesn't exit in time is killed, with its whole tree: on Windows the child may be a .cmd shim.
    close: (now = false) => {
      child.stdin?.end();
      if (gone) return;
      if (now) {
        killTree(child);
        return;
      }
      const timer = setTimeout(() => {
        if (!gone) killTree(child);
      }, exitGraceMs);
      timer.unref();
    },
  };
}

/** JSON-RPC over a LineConnection: requests, notifications, and answering the server's requests. */
export class Rpc {
  private next = 1;
  private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private onNotify: (method: string, params: Json) => void = () => {};
  private onRequest: (method: string, params: Json) => Promise<unknown> = async () => {
    throw new Error("not supported here");
  };
  private readonly conn: LineConnection;
  private readonly name: string;
  ended: string | undefined;

  constructor(conn: LineConnection, name: string) {
    this.conn = conn;
    this.name = name;
    conn.onLine((line) => this.receive(line));
    conn.onExit((detail) => {
      this.ended = detail || `${this.name} stopped.`;
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
      console.warn(`${this.name.toLowerCase()}: a line that isn't JSON was ignored`);
      return;
    }
    if (!isRecord(msg)) return;
    const method = typeof msg.method === "string" ? msg.method : undefined;
    const params = isRecord(msg.params) ? msg.params : {};
    if (method && msg.id !== undefined) {
      // A request from the agent: answer it, even when we can't do what it asks.
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
      if (isRecord(msg.error)) p.reject(new Error(str(msg.error.message) || `${this.name} refused the request.`));
      else p.resolve(msg.result);
    }
  }
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
