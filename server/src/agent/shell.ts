// Runs one shell command for the agent: PowerShell on Windows, the user's shell elsewhere. Kills the whole process
// tree on abort or timeout, and caps the captured output.
import { spawn } from "node:child_process";
import { platform } from "node:os";

export interface ShellOptions {
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  /** Characters of combined stdout and stderr to keep; the middle is dropped when it's longer. */
  maxOutput: number;
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
      env: process.env,
      // Own process group on POSIX, so the whole tree can be killed at once.
      detached: !windows,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    // Hold at most twice the cap while running; truncateMiddle trims at the end.
    const collect = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > opts.maxOutput * 2) output = truncateMiddle(output, opts.maxOutput * 2);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);

    let timedOut = false;
    let aborted = false;
    const killTree = () => {
      if (child.pid === undefined || child.exitCode !== null) return;
      try {
        if (windows) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      killTree();
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null, extra = "") => {
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      resolve({ exitCode, output: truncateMiddle(output + extra, opts.maxOutput), timedOut, aborted });
    };
    child.on("error", (err) => finish(null, `\n${err.message}`));
    child.on("close", (code) => finish(code));
  });
}
