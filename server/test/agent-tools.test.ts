// Tests for the agent loop's core tools and shell runner: workspace boundaries, edits, search, shell exit codes,
// timeouts and abort.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { runShell, truncateMiddle } from "../src/agent/shell.ts";
import {
  editFileTool,
  listFilesTool,
  readFileTool,
  resolveInWorkspace,
  searchFilesTool,
  shellTool,
  ToolInputError,
  writeFileTool,
} from "../src/agent/tools.ts";

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "grokbot-tools-"));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const ctx = (workspaceDir: string, signal = new AbortController().signal) => ({ workspaceDir, signal });

/** A workspace with an "outside" sibling directory, for escape attempts. */
function workspace() {
  const base = tempDir();
  const ws = join(base, "ws");
  const outside = join(base, "outside");
  mkdirSync(ws);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "top secret");
  return { ws, outside };
}

test("file tools refuse paths outside the workspace", async () => {
  const { ws, outside } = workspace();
  const escapes = ["../outside/secret.txt", join(outside, "secret.txt")];
  for (const path of escapes) {
    await assert.rejects(readFileTool.run({ path }, ctx(ws)), ToolInputError);
    await assert.rejects(writeFileTool.run({ path, content: "x" }, ctx(ws)), ToolInputError);
    await assert.rejects(editFileTool.run({ path, old_text: "top", new_text: "x" }, ctx(ws)), ToolInputError);
  }
  await assert.rejects(listFilesTool.run({ pattern: "../outside/*" }, ctx(ws)), ToolInputError);
  assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "top secret");
});

test("file tools refuse to follow a link that points outside the workspace", async () => {
  const { ws, outside } = workspace();
  // A junction needs no special rights on Windows; it's an ordinary directory symlink elsewhere.
  symlinkSync(outside, join(ws, "link"), "junction");
  await assert.rejects(readFileTool.run({ path: "link/secret.txt" }, ctx(ws)), ToolInputError);
  await assert.rejects(writeFileTool.run({ path: "link/new.txt", content: "x" }, ctx(ws)), ToolInputError);
  assert.throws(() => resolveInWorkspace(ws, "link/deeper/new.txt"), ToolInputError);
});

test("write, read (with a line range) and edit a file", async () => {
  const { ws } = workspace();
  const w = await writeFileTool.run({ path: "notes/today.md", content: "one\ntwo\nthree\n" }, ctx(ws));
  assert.equal(w.ok, true);
  const r = await readFileTool.run({ path: "notes/today.md", start_line: 2, end_line: 3 }, ctx(ws));
  assert.deepEqual(r, { ok: true, output: "two\nthree" });
  const e = await editFileTool.run({ path: "notes/today.md", old_text: "two", new_text: "TWO" }, ctx(ws));
  assert.equal(e.ok, true);
  assert.equal(readFileSync(join(ws, "notes", "today.md"), "utf8"), "one\nTWO\nthree\n");
});

test("edit refuses text that is missing or appears more than once", async () => {
  const { ws } = workspace();
  writeFileSync(join(ws, "a.txt"), "same same");
  const missing = await editFileTool.run({ path: "a.txt", old_text: "other", new_text: "x" }, ctx(ws));
  assert.deepEqual(missing, { ok: false, output: "old_text was not found in the file." });
  const twice = await editFileTool.run({ path: "a.txt", old_text: "same", new_text: "x" }, ctx(ws));
  assert.equal(twice.ok, false);
  assert.match(twice.output, /more than once/);
  assert.equal(readFileSync(join(ws, "a.txt"), "utf8"), "same same");
});

test("list and search skip node_modules and .git", async () => {
  const { ws } = workspace();
  mkdirSync(join(ws, "src"));
  mkdirSync(join(ws, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(ws, "src", "app.ts"), "const answer = 42;\n");
  writeFileSync(join(ws, "readme.md"), "The answer is here.\n");
  writeFileSync(join(ws, "node_modules", "pkg", "index.js"), "answer\n");

  const list = await listFilesTool.run({}, ctx(ws));
  assert.deepEqual(list.output.split("\n"), ["readme.md", "src/app.ts"]);
  const md = await listFilesTool.run({ pattern: "**/*.md" }, ctx(ws));
  assert.equal(md.output, "readme.md");

  const search = await searchFilesTool.run({ pattern: "answer" }, ctx(ws));
  assert.deepEqual(search.output.split("\n"), ["readme.md:1: The answer is here.", "src/app.ts:1: const answer = 42;"]);
  const none = await searchFilesTool.run({ pattern: "nothing-like-this" }, ctx(ws));
  assert.equal(none.output, "No matches.");
  await assert.rejects(searchFilesTool.run({ pattern: "(" }, ctx(ws)), ToolInputError);
});

test("shell runs in the workspace and reports the exit code", async () => {
  const { ws } = workspace();
  writeFileSync(join(ws, "marker.txt"), "found me");
  const shell = shellTool();
  const ok = await shell.run(
    { command: "node -e \"process.stdout.write(require('fs').readFileSync('marker.txt','utf8'))\"" },
    ctx(ws),
  );
  assert.equal(ok.ok, true);
  assert.match(ok.output, /^Exit code 0\nfound me/);
  const bad = await shell.run({ command: 'node -e "process.exit(3)"' }, ctx(ws));
  assert.equal(bad.ok, false);
  assert.match(bad.output, /^Exit code 3/);
});

test("shell stops a command on timeout", async () => {
  const { ws } = workspace();
  const r = await runShell('node -e "setTimeout(() => {}, 30000)"', {
    cwd: ws,
    signal: new AbortController().signal,
    timeoutMs: 500,
    maxOutput: 1000,
  });
  assert.equal(r.timedOut, true);
});

test("shell kills a running command within 2 seconds of abort", async () => {
  const { ws } = workspace();
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 300);
  const r = await shellTool().run({ command: 'node -e "setTimeout(() => {}, 30000)"' }, ctx(ws, controller.signal));
  assert.deepEqual(r, { ok: false, output: "The command was stopped." });
  assert.ok(Date.now() - started < 2300, `stopped after ${Date.now() - started} ms`);
});

test("long output keeps its start and end", () => {
  const text = `${"a".repeat(1000)}${"b".repeat(1000)}`;
  const cut = truncateMiddle(text, 200);
  assert.ok(cut.length <= 200);
  assert.ok(cut.startsWith("aaa"));
  assert.ok(cut.endsWith("bbb"));
  assert.match(cut, /characters omitted/);
  assert.equal(truncateMiddle("short", 200), "short");
});

test("tool summaries match the status row wording", () => {
  assert.equal(shellTool().summarize({ command: "npm test" }), "Running npm test");
  assert.equal(readFileTool.summarize({ path: "notes.md" }), "Reading notes.md");
  assert.equal(writeFileTool.summarize({ path: "a.txt" }), "Writing a.txt");
  assert.equal(editFileTool.summarize({ path: "a.txt" }), "Editing a.txt");
  assert.equal(searchFilesTool.summarize({ pattern: "TODO" }), "Searching files for TODO");
});
