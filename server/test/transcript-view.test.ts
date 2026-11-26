// TranscriptView: the client-side transcript store the desktop app renders from.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TranscriptView } from "../src/client/transcript-view.ts";
import type { EntryBody, TranscriptEntry } from "../src/types.ts";

let counter = 0;
function entry(seq: number, body: EntryBody, updatedSeq = ++counter, id = `e${seq}`): TranscriptEntry {
  return { seq, updatedSeq, id, botId: "b", body, createdAt: seq, updatedAt: updatedSeq };
}
const text = (t: string, streaming = false): EntryBody => ({ kind: "assistant_text", text: t, streaming });

test("transcript view: entries come out in seq order, whatever order they arrive in", () => {
  const view = new TranscriptView();
  for (const seq of [3, 1, 4, 0, 2]) view.apply(entry(seq, text(`t${seq}`)));
  assert.deepEqual(
    view.entries().map((e) => e.seq),
    [0, 1, 2, 3, 4],
  );
});

test("transcript view: an update replaces the entry at its position", () => {
  const view = new TranscriptView();
  view.apply(entry(0, { kind: "user_message", text: "hi" }));
  view.apply(entry(1, text("He", true), 10));
  view.apply(entry(2, { kind: "status", label: "Reading a file", tool: "read_file", state: "running" }, 11));
  view.apply(entry(1, text("Hello", true), 12));
  view.apply(entry(2, { kind: "status", label: "Reading a file", tool: "read_file", state: "done" }, 13));
  const list = view.entries();
  assert.equal(list.length, 3);
  assert.deepEqual(list[1]?.body, text("Hello", true));
  assert.equal(list[2]?.body.kind === "status" && list[2].body.state, "done");
  assert.equal(view.cursor, 13);
});

test("transcript view: a stale or repeated update is ignored", () => {
  const view = new TranscriptView();
  assert.ok(view.apply(entry(0, text("new"), 5)));
  assert.equal(view.apply(entry(0, text("old"), 4)), false);
  assert.equal(view.apply(entry(0, text("new again"), 5)), false);
  assert.deepEqual(view.entries()[0]?.body, text("new"));
  assert.equal(view.version, 1);
});

test("transcript view: entries() keeps its reference until something changes, and listeners hear each change", () => {
  const view = new TranscriptView();
  let heard = 0;
  const stop = view.subscribe(() => heard++);
  view.apply(entry(0, text("a"), 1));
  const first = view.entries();
  assert.equal(view.entries(), first, "same array while nothing changed");
  view.apply(entry(0, text("a"), 1)); // stale: no change
  assert.equal(view.entries(), first);
  view.apply(entry(1, text("b"), 2));
  const second = view.entries();
  assert.notEqual(second, first, "a change gives a new array");
  assert.equal(first.length, 1, "an earlier snapshot is never changed afterwards");
  assert.equal(heard, 2);
  stop();
  view.apply(entry(2, text("c"), 3));
  assert.equal(heard, 2, "no calls after unsubscribing");
});

test("transcript view: 10,000 appends and updates stay fast", () => {
  const view = new TranscriptView();
  const started = performance.now();
  for (let seq = 0; seq < 5_000; seq++) view.apply(entry(seq, text(`m${seq}`), seq + 1));
  // Then stream 5,000 tokens into the last entry, reading after each as a renderer would.
  let s = "";
  for (let i = 0; i < 5_000; i++) {
    s += "x";
    view.apply(entry(4_999, text(s, true), 10_000 + i));
    if (i % 50 === 0) view.entries();
  }
  const ms = performance.now() - started;
  assert.equal(view.entries().length, 5_000);
  assert.ok(ms < 1_000, `took ${ms.toFixed(0)} ms`);
});
