// Platform selection: each OS gets its own behavior; unknown systems get Linux's.
import assert from "node:assert/strict";
import { test } from "node:test";
import { platformFor } from "../src/main/platform/index.ts";

test("macOS keeps running with no windows; Windows and Linux quit", () => {
  assert.equal(platformFor("darwin").quitWhenAllWindowsClosed, false);
  assert.equal(platformFor("darwin").reopenOnActivate, true);
  assert.equal(platformFor("win32").quitWhenAllWindowsClosed, true);
  assert.equal(platformFor("linux").quitWhenAllWindowsClosed, true);
  assert.equal(platformFor("freebsd"), platformFor("linux"));
});

test("no menu bar shows in the window: hidden on Windows, auto-hidden on Linux; macOS keeps the system bar", () => {
  assert.equal(platformFor("win32").menuBar, "hidden");
  assert.equal(platformFor("linux").menuBar, "auto-hide");
  assert.equal(platformFor("darwin").menuBar, "system");
});
