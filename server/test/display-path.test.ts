// Paths in status labels: relative inside the bot's workspace, the real full path outside it.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { displayPath, labelPath } from "../src/display-path.ts";
import { summarizeTool } from "../src/providers/claude.ts";

/** A real workspace in a temp folder (realpath'd: on macOS the temp dir is itself behind a link). */
function withWorkspace(fn: (ws: string, base: string) => void) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "smarty-paths-")));
  try {
    const ws = join(base, "computer");
    mkdirSync(ws);
    fn(ws, base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test("display path: inside the workspace, absolute or relative, existing or not, is shown relative", () =>
  withWorkspace((ws) => {
    assert.equal(displayPath(ws, join(ws, "hello.txt")), "hello.txt");
    assert.equal(displayPath(ws, "hello.txt"), "hello.txt");
    assert.equal(displayPath(ws, join(ws, "docs", "plan.md")), join("docs", "plan.md"));
    assert.equal(displayPath(ws, join("docs", "..", "a.txt")), "a.txt", "a .. that stays inside");
    assert.equal(displayPath(ws, ws), ".");
  }));

test("display path: outside, or escaping with .., shows the full path", () =>
  withWorkspace((ws, base) => {
    assert.equal(displayPath(ws, join(base, "notes.txt")), join(base, "notes.txt"));
    assert.equal(displayPath(ws, join("..", "secret.txt")), join(base, "secret.txt"));
    assert.equal(displayPath(ws, ".."), base);
    assert.equal(displayPath(ws, join(`${ws}-other`, "x")), join(`${ws}-other`, "x"), "a sibling with the same prefix");
  }));

test("display path: a name starting with .. is inside", () =>
  withWorkspace((ws) => {
    assert.equal(displayPath(ws, "..notes"), "..notes");
  }));

test("display path: a link inside the workspace that points out shows where it really goes", () =>
  withWorkspace((ws, base) => {
    const outside = join(base, "outside");
    mkdirSync(outside);
    // A junction needs no special rights on Windows; elsewhere the type is ignored.
    symlinkSync(outside, join(ws, "cfg"), "junction");
    assert.equal(displayPath(ws, join(ws, "cfg", "keys")), join(outside, "keys"));
    assert.equal(displayPath(ws, join("cfg", "new", "file.txt")), join(outside, "new", "file.txt"));
    // And a workspace reached through a link still matches its real paths.
    const linkedWs = join(base, "linked");
    symlinkSync(ws, linkedWs, "junction");
    assert.equal(displayPath(linkedWs, join(ws, "a.txt")), "a.txt");
  }));

test("display path: a long label keeps the file name", () =>
  withWorkspace((ws, base) => {
    const deep = join(base, "x".repeat(60), "y".repeat(40), "deploy-secrets.json");
    const label = labelPath(ws, deep);
    assert.equal(label.length, 80);
    assert.ok(label.startsWith("…"));
    assert.ok(label.endsWith("deploy-secrets.json"));
    assert.equal(labelPath(ws, undefined), '""');
  }));

test("claude: file tool labels are relative inside the workspace", () =>
  withWorkspace((ws) => {
    assert.equal(summarizeTool("Write", { file_path: join(ws, "hello.txt") }, ws), "Writing hello.txt");
    assert.equal(summarizeTool("Read", { file_path: join(ws, "a", "b.md") }, ws), `Reading ${join("a", "b.md")}`);
    // An outside path is the real path, then cut to 80 from the left. macOS temp dirs
    // (/private/var/folders/…) are longer than that; Windows and Linux ones often are not.
    const other = resolve(ws, "..", "other.ts");
    const shown = other.length <= 80 ? other : `…${other.slice(-(80 - 1))}`;
    assert.equal(summarizeTool("Edit", { file_path: other }, ws), `Editing ${shown}`);
    assert.equal(summarizeTool("NotebookEdit", { notebook_path: join(ws, "n.ipynb") }, ws), "Editing n.ipynb");
    assert.equal(summarizeTool("Bash", { command: "cat ../x" }, ws), "Running cat ../x", "commands are shown as typed");
  }));
