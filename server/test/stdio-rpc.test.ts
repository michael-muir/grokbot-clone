// Closing an agent CLI (#96): its input is closed so it can save and exit; only one that stays is killed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { endAllNow, spawnLines } from "../src/providers/stdio-rpc.ts";

/** Spawns node running `script`, as an agent CLI would be. */
function child(script: string, exitGraceMs: number) {
  const conn = spawnLines(process.execPath, ["-e", script], process.cwd(), { ...process.env }, "Test", { exitGraceMs });
  const exited = new Promise<number>((resolve) => {
    const started = Date.now();
    conn.onExit(() => resolve(Date.now() - started));
  });
  return { conn, exited };
}

test("stdio: a CLI that exits when its input closes is left to finish, not killed", async () => {
  // Saves on the way out: prints "saved" only when it reaches the end of its input.
  const { conn, exited } = child(
    'process.stdin.resume(); process.stdin.on("end", () => { console.log("saved"); process.exit(0); });',
    5000,
  );
  const lines: string[] = [];
  conn.onLine((l) => lines.push(l));
  await new Promise((r) => setTimeout(r, 300));
  conn.close();
  const ms = await exited;
  assert.ok(ms < 4000, `it exited on its own (${ms} ms), before any kill`);
  assert.deepEqual(lines, ["saved"], "it got to save");
});

test("stdio: a CLI that ignores its closed input is killed after the grace period", async () => {
  const { conn, exited } = child("setInterval(() => {}, 1000);", 200);
  await new Promise((r) => setTimeout(r, 300));
  const closedAt = Date.now();
  conn.close();
  await exited;
  const waited = Date.now() - closedAt;
  assert.ok(waited >= 150 && waited < 5000, `killed after the grace (${waited} ms)`);
});

test("stdio: a Stop or timeout kills at once, and onExit after the end is called right away", async () => {
  const { conn, exited } = child("setInterval(() => {}, 1000);", 10_000);
  await new Promise((r) => setTimeout(r, 300));
  const closedAt = Date.now();
  conn.close(true);
  await exited;
  assert.ok(Date.now() - closedAt < 3000, "no grace period");
  const late = await new Promise<boolean>((resolve) => {
    conn.onExit(() => resolve(true));
    setTimeout(() => resolve(false), 100);
  });
  assert.equal(late, true, "a handler added after the exit still hears of it");
});

test("stdio: at shutdown every agent process still running is ended", async () => {
  const { exited } = child("setInterval(() => {}, 1000);", 10_000);
  await new Promise((r) => setTimeout(r, 300));
  endAllNow();
  const ms = await exited;
  assert.ok(ms < 5000);
});
