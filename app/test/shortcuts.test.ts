// Keyboard shortcuts and the palette's filtering (#23).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  filterPalette,
  type KeyLike,
  keyLabels,
  matchShortcut,
  paletteActions,
  SHORTCUTS,
} from "../src/renderer/src/shell/shortcuts.ts";

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

test("shortcuts: each binding matches its keys with the platform's modifier, and nothing else", () => {
  const win = (k: string, mods: Partial<KeyLike> = {}) => matchShortcut(key(k, { ctrlKey: true, ...mods }), false);
  assert.deepEqual(win("k"), { action: "search" });
  assert.deepEqual(win("F", { shiftKey: true }), { action: "search" });
  assert.deepEqual(win("n"), { action: "new-bot" });
  assert.deepEqual(win("/"), { action: "shortcuts" });
  assert.deepEqual(win("i"), { action: "focus-chat" });
  assert.deepEqual(win("3", { code: "Digit3" }), { action: "go-to-bot", index: 2 });
  assert.deepEqual(win("!", { code: "Digit1" }), { action: "go-to-bot", index: 0 }, "by the physical key");
  assert.deepEqual(win("b", { altKey: true }), { action: "details" });
  assert.deepEqual(matchShortcut(key("ArrowDown", { altKey: true }), false), { action: "next-bot" });
  assert.deepEqual(matchShortcut(key("ArrowUp", { altKey: true }), false), { action: "previous-bot" });

  assert.deepEqual(matchShortcut(key("k", { metaKey: true }), true), { action: "search" }, "⌘ on macOS");
  assert.equal(matchShortcut(key("k", { ctrlKey: true }), true), undefined, "Ctrl isn't ⌘");
  assert.equal(matchShortcut(key("k", { metaKey: true }), false), undefined, "the Windows key isn't Ctrl");
  for (const plain of ["k", "n", "1", "ArrowDown", "Enter"]) assert.equal(matchShortcut(key(plain), false), undefined);
  assert.equal(win("c"), undefined, "copy stays the system's");
  assert.equal(win("0", { code: "Digit0" }), undefined, "Ctrl+0 is the menu's zoom reset");
});

test("shortcuts: every shortcut on the sheet is bound here or handled elsewhere", () => {
  const menu = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
  const composer = readFileSync(new URL("../src/renderer/src/chat/Composer.tsx", import.meta.url), "utf8");
  const elsewhere: Record<string, boolean> = {
    Send: composer.includes("shouldSend"),
    Settings: menu.includes('accelerator: "CmdOrCtrl+,"'),
    "Stop the reply": composer.includes('e.key === "Escape" && busy'),
    Zoom: menu.includes('role: "viewMenu"'),
    "Full screen": menu.includes('role: "viewMenu"'),
  };
  for (const s of SHORTCUTS) {
    assert.ok(s.action !== undefined || elsewhere[s.label], `${s.label} is listed but nothing handles it`);
  }
  assert.deepEqual(keyLabels(["Mod", "Shift", "F"], true), ["⌘", "⇧", "F"]);
  assert.deepEqual(keyLabels(["Mod", "Alt", "B"], false), ["Ctrl", "Alt", "B"]);
});

test("palette: bots and actions filter by every word, in any case", () => {
  const bots = [{ name: "Nova Two" }, { name: "Pip" }, { name: "Smarty" }];
  assert.deepEqual(
    filterPalette(bots, "two nov", (b) => b.name).map((b) => b.name),
    ["Nova Two"],
  );
  assert.equal(filterPalette(bots, "  ", (b) => b.name).length, 3);
  const actions = paletteActions("Nova");
  assert.deepEqual(
    filterPalette(actions, "settings", (a) => `${a.label} ${a.detail ?? ""}`).map((a) => a.id),
    ["settings", "models", "usage"],
  );
  assert.ok(!paletteActions().some((a) => a.id === "start-fresh"), "no bot open, no start fresh");
});

test("shortcuts: the highlight's CSS duration matches the code", () => {
  const tokens = readFileSync(new URL("../src/renderer/src/theme/tokens.css", import.meta.url), "utf8");
  const transcript = readFileSync(new URL("../src/renderer/src/chat/Transcript.tsx", import.meta.url), "utf8");
  const css = /--duration-found: (\d+)ms/.exec(tokens)?.[1];
  const code = /HIGHLIGHT_MS = (\d+)/.exec(transcript)?.[1];
  assert.ok(css && css === code, `${css} vs ${code}`);
});
