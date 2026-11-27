// Core tools for the built-in agent loop. File tools stay inside the bot's workspace; the shell asks first.
import { lstatSync, realpathSync } from "node:fs";
import { glob, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { labelPath } from "../display-path.ts";
import type { ChoiceRequest } from "../types.ts";
import type { ToolSpec } from "./model.ts";
import { defaultShell, runShell, type ShellInfo } from "./shell.ts";

export interface ToolContext {
  workspaceDir: string;
  signal: AbortSignal;
  /** Asks the user a question with choices; undefined if the run was stopped. Absent where nobody can answer. */
  ask?(request: ChoiceRequest): Promise<string | undefined>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface Tool {
  spec: ToolSpec;
  /** Read-only tools run without asking. Everything else goes through an approval card. */
  readOnly: boolean;
  /** A line for the system prompt, when the model needs to know something about this tool. */
  promptNote?: string;
  /** Short label for the status row, like "Running npm test". Paths in it are shown relative to the workspace. */
  summarize(input: Record<string, unknown>, workspaceDir: string): string;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

const MAX_READ_BYTES = 100_000;
const MAX_RANGE_FILE_BYTES = 50_000_000;
const MAX_LIST = 500;
const MAX_MATCHES = 200;
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const SKIP_DIRS = new Set([".git", "node_modules"]);
export const SHELL_TIMEOUT_MS = 120_000;
export const SHELL_MAX_OUTPUT = 30_000;

export class ToolInputError extends Error {}

const str = (input: Record<string, unknown>, key: string): string => {
  const v = input[key];
  if (typeof v !== "string" || !v) throw new ToolInputError(`"${key}" must be a non-empty string.`);
  return v;
};
const optStr = (input: Record<string, unknown>, key: string): string | undefined => {
  const v = input[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new ToolInputError(`"${key}" must be a string.`);
  return v;
};
const optInt = (input: Record<string, unknown>, key: string): number | undefined => {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
    throw new ToolInputError(`"${key}" must be a positive integer.`);
  return v;
};

/** Short form of a value for a status row. */
export function short(v: unknown, max = 80): string {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const isInside = (root: string, target: string) => {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

const exists = (p: string) => {
  try {
    lstatSync(p); // lstat, so a dangling symlink counts as existing and gets checked
    return true;
  } catch {
    return false;
  }
};

/**
 * Resolves `path` against the workspace and refuses anything outside it, including through symlinks.
 * For a path that doesn't exist yet, its nearest existing ancestor is checked. A symlink whose target can't be
 * resolved (dangling) is refused, because writing through it could land anywhere.
 */
export function resolveInWorkspace(workspaceDir: string, path: string): string {
  const root = realpathSync(workspaceDir);
  const target = resolve(root, path);
  if (!isInside(root, target)) throw new ToolInputError(`${path} is outside the workspace.`);
  let existing = target;
  while (!exists(existing)) existing = dirname(existing);
  let real: string;
  try {
    real = realpathSync(existing);
  } catch {
    throw new ToolInputError(`${path} goes through a link that can't be resolved.`);
  }
  if (!isInside(root, real)) throw new ToolInputError(`${path} is outside the workspace.`);
  return target;
}

const toPosix = (p: string) => p.split(sep).join("/");

export const readFileTool: Tool = {
  spec: {
    name: "read_file",
    description: "Read a text file in your workspace. Optionally pass a 1-based line range.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to your workspace" },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 },
      },
      required: ["path"],
    },
  },
  readOnly: true,
  summarize: (input, dir) => `Reading ${labelPath(dir, input.path)}`,
  async run(input, ctx) {
    const file = resolveInWorkspace(ctx.workspaceDir, str(input, "path"));
    const info = await stat(file);
    if (!info.isFile()) return { ok: false, output: `${input.path} is not a file.` };
    const start = optInt(input, "start_line");
    const end = optInt(input, "end_line");
    if (!start && !end) {
      const text = (await readFile(file)).subarray(0, MAX_READ_BYTES).toString("utf8");
      const note =
        info.size > MAX_READ_BYTES
          ? `\n\n[File is ${info.size} bytes; only the first ${MAX_READ_BYTES} were read. Pass start_line and end_line to read further.]`
          : "";
      return { ok: true, output: text + note };
    }
    // A line range can be anywhere in the file, so read the whole file (up to a hard cap), then cut the range.
    if (info.size > MAX_RANGE_FILE_BYTES) {
      return { ok: false, output: `${input.path} is ${info.size} bytes, too large to read by line range.` };
    }
    const lines = (await readFile(file, "utf8")).split("\n");
    const text = lines.slice((start ?? 1) - 1, end ?? lines.length).join("\n");
    const note =
      text.length > MAX_READ_BYTES ? `\n\n[Range cut at ${MAX_READ_BYTES} characters. Ask for fewer lines.]` : "";
    return { ok: true, output: text.slice(0, MAX_READ_BYTES) + note };
  },
};

export const writeFileTool: Tool = {
  spec: {
    name: "write_file",
    description: "Create or overwrite a file in your workspace with the given content.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  readOnly: false,
  summarize: (input, dir) => `Writing ${labelPath(dir, input.path)}`,
  async run(input, ctx) {
    const file = resolveInWorkspace(ctx.workspaceDir, str(input, "path"));
    const content = input.content;
    if (typeof content !== "string") throw new ToolInputError(`"content" must be a string.`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
    return { ok: true, output: `Wrote ${Buffer.byteLength(content)} bytes to ${input.path}.` };
  },
};

export const editFileTool: Tool = {
  spec: {
    name: "edit_file",
    description:
      "Replace one exact string in a file in your workspace. old_text must appear exactly once; include enough surrounding text to make it unique.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
      required: ["path", "old_text", "new_text"],
    },
  },
  readOnly: false,
  summarize: (input, dir) => `Editing ${labelPath(dir, input.path)}`,
  async run(input, ctx) {
    const file = resolveInWorkspace(ctx.workspaceDir, str(input, "path"));
    const oldText = str(input, "old_text");
    const newText = input.new_text;
    if (typeof newText !== "string") throw new ToolInputError(`"new_text" must be a string.`);
    const text = await readFile(file, "utf8");
    const first = text.indexOf(oldText);
    if (first < 0) return { ok: false, output: "old_text was not found in the file." };
    if (text.indexOf(oldText, first + oldText.length) >= 0) {
      return { ok: false, output: "old_text appears more than once. Include more surrounding text." };
    }
    await writeFile(file, text.slice(0, first) + newText + text.slice(first + oldText.length));
    return { ok: true, output: `Edited ${input.path}.` };
  },
};

/**
 * Files under the workspace matching `pattern`, as sorted POSIX-style relative paths, up to MAX_LIST.
 * Every match is checked with resolveInWorkspace, so brace tricks like "{..,x}/*" and symlinks pointing out are
 * dropped, whatever the pattern text says.
 */
async function listWorkspaceFiles(
  workspaceDir: string,
  pattern: string,
  signal: AbortSignal,
): Promise<{ root: string; files: string[]; truncated: boolean }> {
  if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) {
    throw new ToolInputError("pattern must stay inside the workspace.");
  }
  const root = realpathSync(workspaceDir);
  const files = new Set<string>();
  let truncated = false;
  const exclude = (name: string) => SKIP_DIRS.has(name.split(/[\\/]/).pop() ?? "");
  for await (const entry of glob(pattern, { cwd: root, exclude })) {
    if (signal.aborted) break;
    let full: string;
    try {
      full = resolveInWorkspace(root, entry);
    } catch {
      continue; // outside the workspace, or a link that can't be resolved: not listed
    }
    const info = await stat(full).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") console.warn(`list_files: can't stat ${entry}`, err);
      return undefined;
    });
    if (!info?.isFile()) continue;
    // Report each file once, by its path inside the workspace, however the pattern reached it.
    const rel = toPosix(relative(root, full));
    if (files.has(rel)) continue;
    if (files.size >= MAX_LIST) {
      truncated = true;
      break;
    }
    files.add(rel);
  }
  return { root, files: [...files].sort(), truncated };
}

export const listFilesTool: Tool = {
  spec: {
    name: "list_files",
    description: 'List files in your workspace matching a glob pattern, such as "**/*.md". Defaults to all files.',
    inputSchema: { type: "object", properties: { pattern: { type: "string" } } },
  },
  readOnly: true,
  summarize: (input) => `Listing ${short(input.pattern ?? "files")}`,
  async run(input, ctx) {
    const pattern = optStr(input, "pattern") ?? "**/*";
    const { files, truncated } = await listWorkspaceFiles(ctx.workspaceDir, pattern, ctx.signal);
    if (!files.length) return { ok: true, output: "No files match." };
    const more = truncated ? `\n[Stopped at ${MAX_LIST} files.]` : "";
    return { ok: true, output: files.join("\n") + more };
  },
};

export const searchFilesTool: Tool = {
  spec: {
    name: "search_files",
    description:
      "Search file contents in your workspace with a regular expression. Optionally limit to files matching a glob.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression" },
        glob: { type: "string" },
      },
      required: ["pattern"],
    },
  },
  readOnly: true,
  summarize: (input) => `Searching files for ${short(input.pattern)}`,
  async run(input, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(str(input, "pattern"));
    } catch (err) {
      throw new ToolInputError(`Invalid regular expression: ${(err as Error).message}`);
    }
    const pattern = optStr(input, "glob") ?? "**/*";
    const { root, files } = await listWorkspaceFiles(ctx.workspaceDir, pattern, ctx.signal);
    const matches: string[] = [];
    for (const rel of files) {
      if (ctx.signal.aborted || matches.length >= MAX_MATCHES) break;
      const file = resolve(root, rel);
      const info = await stat(file);
      if (info.size > MAX_SEARCH_FILE_BYTES) continue;
      const text = await readFile(file, "utf8");
      if (text.includes("\u0000")) continue; // binary
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
        if (re.test(lines[i] ?? "")) matches.push(`${rel}:${i + 1}: ${short(lines[i], 200)}`);
      }
    }
    if (!matches.length) return { ok: true, output: "No matches." };
    const more = matches.length >= MAX_MATCHES ? `\n[Stopped at ${MAX_MATCHES} matches.]` : "";
    return { ok: true, output: matches.join("\n") + more };
  },
};

export function shellTool(shell: ShellInfo = defaultShell()): Tool {
  return {
    spec: {
      name: "shell",
      description: `Run a ${shell.name} command in your workspace. Returns the exit code and output. Times out after ${SHELL_TIMEOUT_MS / 1000} seconds by default.`,
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_seconds: { type: "integer", minimum: 1, maximum: 600 },
        },
        required: ["command"],
      },
    },
    readOnly: false,
    promptNote: `The shell tool uses ${shell.name}, so write commands in its syntax.`,
    summarize: (input) => `Running ${short(input.command)}`,
    async run(input, ctx) {
      const command = str(input, "command");
      const seconds = optInt(input, "timeout_seconds");
      const timeoutMs = Math.min(seconds ? seconds * 1000 : SHELL_TIMEOUT_MS, 600_000);
      const r = await runShell(
        command,
        { cwd: ctx.workspaceDir, signal: ctx.signal, timeoutMs, maxOutput: SHELL_MAX_OUTPUT },
        shell,
      );
      if (r.aborted) return { ok: false, output: "The command was stopped." };
      if (r.timedOut) return { ok: false, output: `Timed out after ${timeoutMs / 1000} seconds.\n${r.output}` };
      return { ok: r.exitCode === 0, output: `Exit code ${r.exitCode}\n${r.output}`.trimEnd() };
    },
  };
}

/** Asks the user to pick from a few choices. Read-only: asking needs no approval, and nothing is changed. */
export const askUserTool: Tool = {
  spec: {
    name: "ask_user",
    description:
      "Ask the user a question with 2 to 6 short choices, shown as a card they can tap. Use it when a quick pick " +
      "helps more than an open question. Returns the user's answer.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, one short sentence." },
        options: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 6,
          description: "The choices, a few words each.",
        },
        allow_other: { type: "boolean", description: "Let the user type their own answer too." },
      },
      required: ["question", "options"],
    },
  },
  readOnly: true,
  promptNote: "To offer the user a few choices, use ask_user instead of listing them in text.",
  summarize: (input) => `Asking: ${short(input.question)}`,
  async run(input, ctx) {
    const question = str(input, "question");
    const raw = input.options;
    if (
      !Array.isArray(raw) ||
      raw.length < 2 ||
      raw.length > 6 ||
      !raw.every((o) => typeof o === "string" && o.trim())
    ) {
      throw new ToolInputError('"options" must be 2 to 6 non-empty strings.');
    }
    const labels = [...new Set(raw.map((o: string) => o.trim().slice(0, 100)))];
    if (labels.length < 2) throw new ToolInputError('"options" must hold at least 2 different choices.');
    if (!ctx.ask)
      return { ok: false, output: "Questions with choices can't be shown here. Ask in plain text instead." };
    const answer = await ctx.ask({
      prompt: question.slice(0, 300),
      options: labels.map((label) => ({ label, value: label })),
      allowCustom: input.allow_other === true,
    });
    if (answer === undefined) return { ok: false, output: "The run was stopped before the user answered." };
    return { ok: true, output: `The user answered: ${answer}` };
  },
};

export function defaultTools(): Tool[] {
  return [readFileTool, listFilesTool, searchFilesTool, writeFileTool, editFileTool, shellTool(), askUserTool];
}
