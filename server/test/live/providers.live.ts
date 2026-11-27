// Live end-to-end check of any real provider through the gateway. Not part of `npm test`.
//
//   LIVE_PROVIDER=ollama LIVE_MODEL=qwen3.5:4b npm run test:live
//   LIVE_PROVIDER=openai LIVE_MODEL=<model> npm run test:live
//   LIVE_PROVIDER=gemini LIVE_MODEL=<model> npm run test:live
//   LIVE_PROVIDER=claude LIVE_MODEL=<model> npm run test:live
//
// Providers are built exactly as the gateway builds them, so keys come from the OS keychain (saved through
// PUT /providers/:id/key), else the provider's env var.
//
// The bot is asked to create a file with write_file. The approval is granted automatically, then the test checks
// the file exists and the run finished.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BotRegistry } from "../../src/bots.ts";
import { LocalFolderComputers } from "../../src/computer.ts";
import { Gateway } from "../../src/gateway.ts";
import { Credentials, KeychainKeyStore } from "../../src/keys.ts";
import { defaultProviders } from "../../src/providers/index.ts";
import { TranscriptStore } from "../../src/transcript.ts";
import { isProviderId } from "../../src/types.ts";

const requested = process.env.LIVE_PROVIDER ?? "ollama";
const model = process.env.LIVE_MODEL;

test(`live: ${requested} creates a file through an approved tool call`, { timeout: 300_000 }, async () => {
  assert.ok(isProviderId(requested) && requested !== "fake", `LIVE_PROVIDER must be a real provider id`);
  const presetId = requested;
  const dataDir = mkdtempSync(join(tmpdir(), "smarty-live-"));
  try {
    const bots = new BotRegistry(dataDir, [
      { id: "live", name: "Live", provider: presetId, model, avatar: { shape: "circle", color: "blue" } },
    ]);
    const store = new TranscriptStore(dataDir);
    const providers = defaultProviders(dataDir, new Credentials(new KeychainKeyStore()));
    const provider = providers.get(presetId);
    assert.ok(provider, `no provider ${presetId}`);
    const gateway = new Gateway(bots, store, new Map([[presetId, provider]]), new LocalFolderComputers(dataDir));

    // Approve every card as it appears, and print the transcript as it changes.
    store.subscribe("live", (e) => {
      if (e.body.kind === "approval" && e.body.state === "pending")
        gateway.answerApproval("live", e.id, { allow: true });
      if (e.body.kind !== "assistant_text" || !e.body.streaming) console.log(e.body.kind, JSON.stringify(e.body));
    });

    const started = Date.now();
    const { done } = await gateway.sendMessage(
      "live",
      'Use the write_file tool to create a file named hello.txt containing exactly the text "hi from the agent". Then reply with one short sentence.',
    );
    await done;
    console.log(`took ${((Date.now() - started) / 1000).toFixed(1)} s`);

    const run = store.list("live").find((e) => e.body.kind === "run");
    assert.equal(run?.body.kind === "run" && run.body.state, "finished");
    const file = join(dataDir, "bots", "live", "computer", "hello.txt");
    assert.ok(existsSync(file), "hello.txt was created in the bot's workspace");
    assert.match(readFileSync(file, "utf8"), /hi from the agent/);
  } finally {
    // Claude Code can hold the folder for a couple of seconds after the run on Windows (its graceful exit).
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  }
});
