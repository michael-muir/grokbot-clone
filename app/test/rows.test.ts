// Chat row layout: sides, bubble groups, spacing, time separators and the Thinking row.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryBody, TranscriptEntry } from "../../server/src/types.ts";
import { buildRows, conversation, type Row, replyCounts, separatorLabel } from "../src/renderer/src/chat/rows.ts";

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

test("rows: a Stopped notice comes after what the run produced, not where the run began", () => {
  seq = 0;
  const rows = buildRows(
    [user("go"), run("interrupted"), status("done"), bot("Partial"), user("next"), run("finished"), bot("ok")],
    NOW,
    "en-US",
  );
  assert.deepEqual(shape(rows), [
    "sep",
    "user_message:single:none",
    "status:first:switch",
    "assistant_text:last:tight",
    "run:single:switch",
    "user_message:single:switch",
    "assistant_text:single:switch",
  ]);
  seq = 0;
  const atEnd = buildRows([user("go"), run("interrupted"), bot("Nova")], NOW, "en-US");
  assert.deepEqual(shape(atEnd).slice(-2), ["assistant_text:single:switch", "run:single:switch"]);
});

test("rows: a moved Stopped notice doesn't make the next message look like it came after a long pause", () => {
  seq = 0;
  // The run starts at 0, streams until 55 minutes, is stopped; the next message comes 45 minutes after that.
  const rows = buildRows(
    [user("go", 0), run("interrupted", 0), bot("long reply", 55), user("next", 100)],
    NOW,
    "en-US",
  );
  assert.equal(rows.filter((r) => r.type === "separator").length, 1, "only the first separator");
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

test("rows: a pending message shows at the end until an entry with its nonce arrives", () => {
  seq = 0;
  const pending = [{ nonce: "n1", text: "on its way", at: T0 + 5 * MIN }];
  const before = buildRows([bot("hello", 0)], NOW, "en-US", pending);
  const last = before.at(-1);
  assert.ok(last?.type === "entry" && last.pending === true && last.side === "user");
  assert.equal(last?.type === "entry" && last.entry.body.kind === "user_message" && last.entry.body.text, "on its way");

  const confirmed = e({ kind: "user_message", text: "on its way", clientNonce: "n1" }, 5);
  const after = buildRows([bot("hello", 0), confirmed], NOW, "en-US", pending);
  assert.equal(after.filter((r) => r.type === "entry" && r.pending).length, 0, "replaced by the real entry");
  assert.equal(after.filter((r) => r.type === "entry" && r.entry.body.kind === "user_message").length, 1);
});

test("rows: a choice card sits on the bot's side as a card of its own", () => {
  seq = 0;
  const choice: EntryBody = {
    kind: "choice",
    prompt: "Pick",
    options: [{ label: "A", value: "a" }],
    allowCustom: false,
    state: "pending",
  };
  assert.deepEqual(shape(buildRows([bot("one"), e(choice), bot("two")], NOW, "en-US")), [
    "sep",
    "assistant_text:single:none",
    "choice:single:group",
    "assistant_text:single:group",
  ]);
});

test("rows: a Stopped notice stays with its run's output, before notices written after the run", () => {
  seq = 0;
  const inRun = (body: EntryBody, runId: string) => ({ ...e(body), runId });
  const run = inRun({ kind: "run", provider: "fake", state: "interrupted" }, "r1");
  const rows = buildRows(
    [
      user("go"),
      { ...run, id: "r1" },
      inRun({ kind: "assistant_text", text: "Partial", streaming: false }, "r1"),
      e({ kind: "notice", text: "Switched to Ollama" }),
    ],
    NOW,
    "en-US",
  );
  assert.deepEqual(
    rows.flatMap((r) => (r.type === "entry" ? [r.entry.body.kind] : [])),
    ["user_message", "assistant_text", "run", "notice"],
  );
});

test("rows: a pending message is matched by the entry id the send returned, even without an echoed nonce", () => {
  seq = 0;
  const pending = [{ nonce: "n2", text: "hi", at: T0, entryId: "e-real" }];
  const real = { ...e({ kind: "user_message", text: "hi" }), id: "e-real" }; // an older gateway: no clientNonce
  const rows = buildRows([real], NOW, "en-US", pending);
  assert.equal(rows.filter((r) => r.type === "entry" && r.pending).length, 0);
});

test("rows: no Thinking row under a choice card waiting for the user", () => {
  seq = 0;
  const choice: EntryBody = { kind: "choice", prompt: "Pick", options: [], allowCustom: true, state: "pending" };
  const rows = buildRows([user("go"), run("running"), e(choice)], NOW, "en-US");
  assert.ok(!shape(rows).some((s) => s.startsWith("thinking")));
});

test("rows: the main view leaves out hidden and thread entries, and counts replies", () => {
  seq = 0;
  const root = user("apples");
  const reply = bot("Nice.");
  const inThread = { ...user("side note"), threadId: root.id };
  const threadReply = { ...bot("Sure."), threadId: root.id };
  const rolledBack = { ...user("pears"), hidden: true as const };
  const hiddenInThread = { ...user("gone"), threadId: root.id, hidden: true as const };
  const all = [root, reply, inThread, threadReply, rolledBack, hiddenInThread];

  assert.deepEqual(
    conversation(all).map((x) => x.id),
    [root.id, reply.id],
  );
  assert.deepEqual(
    conversation(all, root.id).map((x) => x.id),
    [root.id, inThread.id, threadReply.id],
    "a thread shows its root, then its own visible entries",
  );
  assert.deepEqual(conversation(all, rolledBack.id), [], "a hidden root has no thread to show");
  assert.deepEqual([...replyCounts(all)], [[root.id, 2]]);

  const rows = buildRows(conversation(all), NOW, "en-US", [], { replies: replyCounts(all) });
  const entryRows = rows.filter((r) => r.type === "entry");
  assert.equal(entryRows[0]?.type === "entry" && entryRows[0].replies, 2);
  assert.equal(entryRows[1]?.type === "entry" && entryRows[1].replies, undefined);
});

test("rows: hover actions are a thread for any message in the main chat, and roll back for your own", () => {
  seq = 0;
  const root = user("apples");
  const reply = bot("Nice.");
  const note = { ...e({ kind: "notice", text: "Switched" }) };
  const inThread = { ...user("side note"), threadId: root.id };
  const actions = (rows: Row[]) =>
    rows.flatMap((r) => (r.type === "entry" ? [[r.entry.id, r.actions ?? null] as const] : []));

  assert.deepEqual(actions(buildRows([root, reply, note], NOW, "en-US")), [
    [root.id, { thread: true, rollBack: true }],
    [reply.id, { thread: true, rollBack: false }],
    [note.id, null],
  ]);
  assert.deepEqual(
    actions(buildRows([root, inThread], NOW, "en-US", [], { thread: root.id })),
    [
      [root.id, null],
      [inThread.id, { thread: false, rollBack: true }],
    ],
    "in a thread: no actions on its root (it belongs to the main chat), no threads inside threads",
  );
  const pending = buildRows([], NOW, "en-US", [{ nonce: "n1", text: "hi", at: T0 }]);
  assert.deepEqual(actions(pending), [["pending-n1", null]], "a message not yet sent has none");
});
