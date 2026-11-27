// Single instance: which launches take the lock, and bringing the running window forward.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bringToFront, type FrontWindow, takesLock } from "../src/main/single-instance.ts";

test("single instance: normal launches take the lock; smoke and dev runs never defer to a running app", () => {
  assert.equal(takesLock(["electron", "."], undefined), true);
  assert.equal(takesLock(["electron", ".", "--smoke"], undefined), false);
  assert.equal(takesLock(["electron", "."], "http://localhost:5173"), false);
});

function fakeWindow(state: { minimized: boolean; visible: boolean }) {
  const calls: string[] = [];
  const win: FrontWindow = {
    isMinimized: () => state.minimized,
    restore: () => {
      calls.push("restore");
      state.minimized = false;
    },
    isVisible: () => state.visible,
    show: () => {
      calls.push("show");
      state.visible = true;
    },
    focus: () => calls.push("focus"),
  };
  return { win, calls };
}

test("single instance: a minimized window is restored, a hidden one shown, and either is focused", () => {
  const minimized = fakeWindow({ minimized: true, visible: true });
  bringToFront(minimized.win);
  assert.deepEqual(minimized.calls, ["restore", "focus"]);

  const hidden = fakeWindow({ minimized: false, visible: false });
  bringToFront(hidden.win);
  assert.deepEqual(hidden.calls, ["show", "focus"]);

  const open = fakeWindow({ minimized: false, visible: true });
  bringToFront(open.win);
  assert.deepEqual(open.calls, ["focus"]);
});
