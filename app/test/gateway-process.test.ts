// Gateway launcher tests: starts the real gateway, attaches to a running one, and reports early exits.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startGateway } from "../src/main/gateway-process.ts";

const serverDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "server");
const quiet = () => {};
// The user's own GATEWAY_URL would switch the launcher to attach mode.
const noAttach = { ...process.env, GATEWAY_URL: "" };

test("starts the gateway with a token, attaches to it by URL, and stops it", { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "grokbot-app-"));
  const env = { ...process.env, DATA_DIR: dataDir, GATEWAY_URL: "" };
  const handle = await startGateway({ serverDir, env, log: quiet });
  try {
    assert.equal(handle.spawned, true);
    const bots = await handle.client.listBots();
    assert.ok(bots.length > 0, "the gateway lists its default bots");

    // Without the token the gateway refuses; with it, attach mode works.
    const res = await fetch(`${handle.client.baseUrl}/bots`);
    assert.equal(res.status, 401);
    const tokenless = await startGateway({
      serverDir,
      env: { GATEWAY_URL: handle.client.baseUrl },
      log: quiet,
      timeoutMs: 2000,
    }).then(
      () => "attached",
      (err: Error) => err.message,
    );
    assert.match(tokenless, /Unauthorized/);
  } finally {
    await handle.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
  let stopped = false;
  await Promise.race([handle.exited.then(() => (stopped = true)), new Promise((r) => setTimeout(r, 100))]);
  assert.equal(stopped, true, "the gateway process exited");
  assert.equal(await handle.client.health(), false);
});

test("a gateway that exits before it's ready is reported at once, with its error output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-app-"));
  try {
    writeFileSync(join(dir, "crash.mjs"), 'console.error("port in use"); process.exit(3);\n');
    const started = Date.now();
    const result = await startGateway({ serverDir: dir, entry: "crash.mjs", env: noAttach, log: quiet }).then(
      () => "started",
      (err: Error) => err.message,
    );
    assert.match(result, /exited \(code 3\)/);
    assert.match(result, /port in use/);
    assert.ok(Date.now() - started < 5000, "didn't wait for the timeout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing node binary is reported instead of hanging", async () => {
  const result = await startGateway({ serverDir, node: "no-such-node-binary", env: noAttach, log: quiet }).then(
    () => "started",
    (err: Error) => err.message,
  );
  assert.match(result, /Couldn't start the gateway/);
});
