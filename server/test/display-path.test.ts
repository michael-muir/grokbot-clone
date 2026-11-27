// Paths in status labels: relative inside the bot's workspace, the full resolved path outside it.
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { displayPath } from "../src/display-path.ts";
import { summarizeTool } from "../src/providers/claude.ts";

const ws = resolve("data", "bots", "smarty", "computer");

test("display path: inside the workspace, absolute or relative, is shown relative", () => {
  assert.equal(displayPath(ws, join(ws, "hello.txt")), "hello.txt");
  assert.equal(displayPath(ws, "hello.txt"), "hello.txt");
  assert.equal(displayPath(ws, join(ws, "docs", "plan.md")), join("docs", "plan.md"));
  assert.equal(displayPath(ws, join("docs", "..", "a.txt")), "a.txt", "a .. that stays inside");
  assert.equal(displayPath(ws, ws), ".");
});

test("display path: outside, or escaping with .., shows the full path", () => {
  const outside = resolve("elsewhere", "notes.txt");
  assert.equal(displayPath(ws, outside), outside);
  assert.equal(displayPath(ws, join("..", "..", "secret.txt")), resolve(ws, "..", "..", "secret.txt"));
  assert.equal(displayPath(ws, ".."), resolve(ws, ".."));
  assert.equal(
    displayPath(ws, join(`${ws}-other`, "x")),
    resolve(`${ws}-other`, "x"),
    "a sibling with the same prefix",
  );
});

test("display path: a name starting with .. is inside", () => {
  assert.equal(displayPath(ws, "..notes"), "..notes");
});

test("claude: file tool labels are relative inside the workspace", () => {
  assert.equal(summarizeTool("Write", { file_path: join(ws, "hello.txt") }, ws), "Writing hello.txt");
  assert.equal(summarizeTool("Read", { file_path: join(ws, "a", "b.md") }, ws), `Reading ${join("a", "b.md")}`);
  assert.equal(summarizeTool("Edit", { file_path: resolve("other.ts") }, ws), `Editing ${resolve("other.ts")}`);
  assert.equal(summarizeTool("NotebookEdit", { notebook_path: join(ws, "n.ipynb") }, ws), "Editing n.ipynb");
  assert.equal(summarizeTool("Bash", { command: "cat ../x" }, ws), "Running cat ../x", "commands are shown as typed");
});
