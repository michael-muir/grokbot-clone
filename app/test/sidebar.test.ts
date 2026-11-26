// Sidebar logic: badges, new-reply tracking, the working button and bot name cleanup.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicBot } from "../../server/src/types.ts";
import {
  badgeFor,
  cleanName,
  MAX_NAME,
  nextUnread,
  tileLabel,
  workingButton,
} from "../src/renderer/src/shell/sidebar-state.ts";

test("sidebar: badge per state, working first, then a new reply, then the main star", () => {
  assert.equal(badgeFor({ running: true, unread: true, main: true }), "working");
  assert.equal(badgeFor({ running: false, unread: true, main: true }), "unread");
  assert.equal(badgeFor({ running: false, unread: false, main: true }), "main");
  assert.equal(badgeFor({ running: false, unread: false, main: false }), null);
  assert.equal(tileLabel("Nova", "working"), "Nova, working");
  assert.equal(tileLabel("Nova", "unread"), "Nova, new reply");
  assert.equal(tileLabel("Nova", "main"), "Nova");
});

test("sidebar: a run ending on another bot marks it unread; opening clears it", () => {
  const idle = [
    { botId: "nova", running: false },
    { botId: "rex", running: false },
  ];
  const rexBusy = [
    { botId: "nova", running: false },
    { botId: "rex", running: true },
  ];
  const none = new Set<string>();
  assert.deepEqual([...nextUnread(none, idle, rexBusy, "nova")], [], "starting isn't a reply");
  assert.deepEqual([...nextUnread(none, rexBusy, idle, "nova")], ["rex"], "rex finished while nova was open");
  assert.deepEqual([...nextUnread(none, rexBusy, idle, "rex")], [], "finishing in the open chat isn't unread");
  assert.deepEqual([...nextUnread(new Set(["rex"]), idle, idle, "rex")], [], "opening rex clears it");
  assert.deepEqual([...nextUnread(new Set(["gone"]), idle, idle, "nova")], [], "deleted bots are forgotten");
});

const bot = (id: string, name: string): PublicBot => ({
  id,
  name,
  provider: "fake",
  avatar: { shape: "circle", color: "amber" },
});

test("sidebar: the working button names the bot, counts several, and prefers one that isn't open", () => {
  const bots = [bot("nova", "Nova"), bot("rex", "Rex")];
  const run = (...ids: string[]) => bots.map((b) => ({ botId: b.id, running: ids.includes(b.id) }));
  assert.equal(workingButton(bots, run(), "nova"), undefined);
  assert.deepEqual(workingButton(bots, run("rex"), "nova"), { label: "Rex is working", target: "rex" });
  assert.deepEqual(workingButton(bots, run("nova", "rex"), "nova"), { label: "2 bots are working", target: "rex" });
  assert.deepEqual(workingButton(bots, run("nova"), "nova"), { label: "Nova is working", target: "nova" });
});

test("rename: trims, collapses spaces, caps the length, refuses empty", () => {
  assert.equal(cleanName("  Nova  "), "Nova");
  assert.equal(cleanName("Nova\n  Prime"), "Nova Prime");
  assert.equal(cleanName("   "), undefined);
  assert.equal(cleanName("x".repeat(60))?.length, MAX_NAME);
  assert.equal(Array.from(cleanName("🚀".repeat(50)) ?? "").length, MAX_NAME, "counts characters, not code units");
});
