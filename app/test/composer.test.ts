// Composer logic: which button shows and when it's enabled, which keys send, and per-bot drafts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { draftFor, primaryButton, saveDraft, shouldSend } from "../src/renderer/src/chat/composer-state.ts";

test("composer: Send needs text and no send in flight; while busy the button is Stop", () => {
  const idle = { busy: false, sending: false, stopping: false };
  assert.deepEqual(primaryButton({ ...idle, draft: "" }), { kind: "send", enabled: false, label: "Send message" });
  assert.equal(primaryButton({ ...idle, draft: "   \n" }).enabled, false, "whitespace isn't a message");
  assert.equal(primaryButton({ ...idle, draft: "hi" }).enabled, true);
  assert.equal(primaryButton({ ...idle, draft: "hi", sending: true }).enabled, false);

  const busy = { draft: "next question", busy: true, sending: false, stopping: false };
  assert.deepEqual(primaryButton(busy), { kind: "stop", enabled: true, label: "Stop the reply" });
  assert.equal(primaryButton({ ...busy, stopping: true }).enabled, false, "Stop is pressed once");
  assert.equal(primaryButton({ ...busy, draft: "" }).kind, "stop", "Stop shows with or without a draft");
});

test("composer: Enter sends, Shift+Enter and IME confirmation don't", () => {
  assert.equal(shouldSend("Enter", false, false), true);
  assert.equal(shouldSend("Enter", true, false), false);
  assert.equal(shouldSend("Enter", false, true), false);
  assert.equal(shouldSend("a", false, false), false);
});

test("composer: drafts are kept per bot, and an empty draft is forgotten", () => {
  saveDraft("nova", "half a thought");
  saveDraft("rex", "other");
  assert.equal(draftFor("nova"), "half a thought");
  assert.equal(draftFor("rex"), "other");
  saveDraft("nova", "");
  assert.equal(draftFor("nova"), "");
  assert.equal(draftFor("unknown"), "");
});
