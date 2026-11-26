// Chat row layout: sides, bubble groups, spacing, time separators and the Thinking row.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryBody, TranscriptEntry } from "../../server/src/types.ts";
import { buildRows, type Row, separatorLabel } from "../src/renderer/src/chat/rows.ts";

const T0 = new Date(2026, 10, 26, 15, 19).getTime(); // local time, so labels don't depend on the time zone
const NOW = new Date(2026, 10, 26, 18, 0);
const MIN = 60_000;

let seq = 0;
function e(body: EntryBody, atMin = seq, id = `e${seq}`): TranscriptEntry {
  const s = seq++;
  return { seq: s, updatedSeq: s, id, botId: "b", body, createdAt: T0 + atMin * MIN, updatedAt: T0 };
}
const user = (text: string, at?: number) => e({ kind: "user_message", text }, at);
const bot = (text: string, at?: number, streaming = false) => e({ kind: "assistant_text", text, streaming }, at);
const status = (state: "running" | "done" | "failed", at?: number) =>
  e({ kind: "status", label: "Reading a file", tool: "read_file", state }, at);
const run = (state: "running" | "finished" | "interrupted" | "failed", at?: number) =>
  e({ kind: "run", provider: "fake", state }, at);

/** Compact picture of the rows: "sep", or kind:group:gap. */
const shape = (rows: Row[]) =>
  rows.map((r) =>
    r.type === "separator" ? "sep" : `${r.type === "thinking" ? "thinking" : r.entry.body.kind}:${r.group}:${r.gap}`,
  );

test("rows: consecutive bot bubbles and status rows form one group with joined corners", () => {
  seq = 0;
  const rows = buildRows(
    [user("hi"), run("finished"), bot("one"), status("done"), bot("two"), bot("three")],
    NOW,
    "en-US",
  );
  assert.deepEqual(shape(rows), [
    "sep",
    "user_message:single:none",
    "assistant_text:first:switch",
    "status:middle:tight",
    "assistant_text:middle:tight",
    "assistant_text:last:tight",
  ]);
});

test("rows: a card breaks a group; the next bubble starts a new group on the same side", () => {
  seq = 0;
  const approval: EntryBody = {
    kind: "approval",
    tool: "write_file",
    summary: "Write hello.txt",
    input: {},
    state: "approved",
  };
  const rows = buildRows([bot("before"), e(approval), bot("after"), user("ok"), user("thanks")], NOW, "en-US");
  assert.deepEqual(shape(rows), [
    "sep",
    "assistant_text:single:none",
    "approval:single:group",
    "assistant_text:single:group",
    "user_message:first:switch",
    "user_message:last:tight",
  ]);
});

test("rows: notices and errors sit in the center; running, finished and failed runs are hidden", () => {
  seq = 0;
  const rows = buildRows(
    [run("finished"), bot("hi"), run("failed"), e({ kind: "error", message: "boom" }), run("interrupted")],
    NOW,
    "en-US",
  );
  assert.deepEqual(shape(rows), ["sep", "assistant_text:single:none", "error:single:switch", "run:single:group"]);
  assert.ok(rows.every((r) => r.type !== "entry" || r.side !== "center" || r.group === "single"));
});

test("rows: separators before the first entry and after an hour's pause", () => {
  seq = 0;
  const rows = buildRows([bot("a", 0), bot("b", 59), bot("c", 59 + 60)], NOW, "en-US");
  assert.deepEqual(shape(rows), [
    "sep",
    "assistant_text:first:none",
    "assistant_text:last:tight",
    "sep",
    "assistant_text:single:none",
  ]);
  const labels = rows.flatMap((r) => (r.type === "separator" ? [r.label] : []));
  assert.deepEqual(labels, ["Today 3:19 PM", "Today 5:18 PM"]);
  const first = rows[1];
  assert.equal(first?.type === "entry" && first.time, "3:19 PM");
});

test("rows: separator labels for today, yesterday, this year and an earlier year", () => {
  const at = (y: number, m: number, d: number) => new Date(y, m, d, 15, 28);
  assert.equal(separatorLabel(at(2026, 10, 26), NOW, "en-US"), "Today 3:28 PM");
  assert.equal(separatorLabel(at(2026, 10, 25), NOW, "en-US"), "Yesterday 3:28 PM");
  assert.equal(separatorLabel(at(2026, 10, 23), NOW, "en-US"), "Mon, Nov 23 3:28 PM");
  assert.equal(separatorLabel(at(2025, 10, 23), NOW, "en-US"), "Sun, Nov 23, 2025 3:28 PM");
});

test("rows: Thinking shows while a run has nothing visible yet, and goes when text streams", () => {
  seq = 0;
  const start = [user("hi"), run("running")];
  assert.deepEqual(shape(buildRows(start, NOW, "en-US")).slice(-1), ["thinking:single:switch"]);

  const empty = bot("", undefined, true);
  assert.deepEqual(shape(buildRows([...start, empty], NOW, "en-US")).slice(-1), ["thinking:single:switch"]);

  const streaming = {
    ...empty,
    updatedSeq: 99,
    body: { kind: "assistant_text", text: "Hel", streaming: true } as const,
  };
  const rows = buildRows([...start, streaming], NOW, "en-US");
  assert.deepEqual(shape(rows).slice(-1), ["assistant_text:single:switch"]);

  const afterText = [...start, bot("Let me check."), status("done")];
  assert.deepEqual(shape(buildRows(afterText, NOW, "en-US")).slice(-2), ["status:middle:tight", "thinking:last:tight"]);
  assert.ok(!shape(buildRows([...afterText, status("running")], NOW, "en-US")).some((s) => s.startsWith("thinking")));
  assert.ok(!shape(buildRows([...start, run("finished")], NOW, "en-US")).some((s) => s.startsWith("thinking")));
});

test("rows: a streaming entry keeps its key and position as it updates", () => {
  seq = 0;
  const hi = user("hi");
  const reply = bot("He", undefined, true);
  const tool = status("running");
  const before = buildRows([hi, reply, tool], NOW, "en-US");
  const grown = { ...reply, updatedSeq: 50, body: { kind: "assistant_text", text: "Hello", streaming: true } as const };
  const after = buildRows([hi, grown, { ...tool, updatedSeq: 51 }], NOW, "en-US");
  assert.deepEqual(
    after.map((r) => r.key),
    before.map((r) => r.key),
  );
  const row = after.findIndex((r) => r.key === reply.id);
  assert.equal(
    row,
    before.findIndex((r) => r.key === reply.id),
  );
  const shown = after[row];
  assert.equal(shown?.type === "entry" && shown.entry.body.kind === "assistant_text" && shown.entry.body.text, "Hello");
});
