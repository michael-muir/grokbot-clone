// Runs one shell command for the agent: PowerShell on Windows, the user's shell elsewhere. Kills the whole process
// tree on abort or timeout, and caps the captured output.
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { childEnv } from "../child-env.ts";

export interface ShellOptions {
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  /** Characters of combined stdout and stderr to keep; the middle is dropped when it's longer. */
  maxOutput: number;
  /** Extra environment variables (the bot's secrets), over the gateway's own minus its secrets. */
  env?: Readonly<Record<string, string>>;
}

export interface ShellResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface ShellInfo {
  /** Name shown to the model, so it writes commands in the right syntax. */
  name: string;
  command: string;
  args: (script: string) => string[];
}

export function defaultShell(os: NodeJS.Platform = platform()): ShellInfo {
  if (os === "win32") {
    return {
      name: "PowerShell",
      command: "powershell.exe",
      // PowerShell exits 1 for any failure and drops a native program's own exit code; pass the real one through.
      args: (script) => [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$global:LASTEXITCODE = 0\n${script}\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }\nexit $LASTEXITCODE`,
      ],
    };
  }
  const shell = process.env.SHELL || "/bin/sh";
  return { name: shell.split("/").pop() || "sh", command: shell, args: (script) => ["-c", script] };
}

/** Keeps the start and end of long output, which is where errors and results usually are. */
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.floor((max - 60) / 2);
  const dropped = text.length - keep * 2;
  return `${text.slice(0, keep)}\n\n[… ${dropped} characters omitted …]\n\n${text.slice(-keep)}`;
}

export function runShell(script: string, opts: ShellOptions, shell: ShellInfo = defaultShell()): Promise<ShellResult> {
  return new Promise((resolve) => {
    const windows = platform() === "win32";
    const child = spawn(shell.command, shell.args(script), {
      cwd: opts.cwd,
      env: { ...childEnv(), ...opts.env },
      // Own process group on POSIX, so the whole tree can be killed at once.
      detached: !windows,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    // Hold at most twice the cap while running; truncateMiddle trims at the end.
    const collect = (chunk: string) => {
      output += chunk;
      if (output.length > opts.maxOutput * 2) output = truncateMiddle(output, opts.maxOutput * 2);
    };
    // Decode as a stream, so a character split across two chunks isn't garbled.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    let timedOut = false;
    let aborted = false;
    let settled = false;
    let exitCode: number | null = null;
    const timers: NodeJS.Timeout[] = [];

    const finish = (code: number | null, extra = "") => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      opts.signal.removeEventListener("abort", onAbort);
      // A background process may still hold the pipes; stop listening to them.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ exitCode: code, output: truncateMiddle(output + extra, opts.maxOutput), timedOut, aborted });
    };

    // Kills the shell and everything it started. Runs even after the shell itself has exited, because a
    // background child can outlive it (the POSIX process group stays valid while any member is alive).
    const killTree = () => {
      if (child.pid === undefined) return;
      if (windows) {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        killer.on("error", (err) => {
          console.warn("taskkill failed; killing the shell only", err);
          child.kill();
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") console.warn("couldn't kill the process group", err);
          child.kill("SIGKILL");
        }
      }
    };
    const stop = (why: "timeout" | "abort") => {
      if (why === "timeout") timedOut = true;
      else aborted = true;
      killTree();
      // Don't wait for every pipe to close: return within a second even if something survived the kill.
      timers.push(setTimeout(() => finish(exitCode, "\n[Stopped waiting for the command's output.]"), STOP_GRACE_MS));
    };
    const onAbort = () => stop("abort");

    timers.push(setTimeout(() => stop("timeout"), opts.timeoutMs));
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => finish(null, `\n${err.message}`));
    child.on("exit", (code) => {
      exitCode = code;
      // Normally 'close' follows at once. If a background process keeps the output open, finish anyway.
      timers.push(
        setTimeout(
          () => finish(code, "\n[The command left a background process running; stopped waiting for its output.]"),
          EXIT_GRACE_MS,
        ),
      );
    });
    child.on("close", (code) => finish(code ?? exitCode));
  });
}

/** After a kill, how long to wait for the output to close before returning anyway. */
const STOP_GRACE_MS = 1000;
/** After the shell exits, how long to wait for background processes to release its output. */
const EXIT_GRACE_MS = 2000;
