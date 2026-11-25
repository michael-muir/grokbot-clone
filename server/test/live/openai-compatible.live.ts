// Live end-to-end check of an OpenAI-compatible provider through the gateway. Not part of `npm test`.
//
//   LIVE_PROVIDER=ollama LIVE_MODEL=qwen3.5:4b npm run test:live
//   LIVE_PROVIDER=openai LIVE_MODEL=<model> OPENAI_API_KEY=... npm run test:live
//
// The bot is asked to create a file with write_file. The approval is granted automatically, then the test checks
// the file exists and the run finished.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionStore } from "../../src/agent/sessions.ts";
import { BotRegistry } from "../../src/bots.ts";
import { LocalFolderComputers } from "../../src/computer.ts";
import { Gateway } from "../../src/gateway.ts";
import { OPENAI_PRESETS, openAICompatibleProvider } from "../../src/providers/openai-compatible.ts";
import { TranscriptStore } from "../../src/transcript.ts";

const presetId = process.env.LIVE_PROVIDER ?? "ollama";
const model = process.env.LIVE_MODEL;

test(`live: ${presetId} creates a file through an approved tool call`, { timeout: 300_000 }, async () => {
  const preset = OPENAI_PRESETS.find((p) => p.id === presetId);
  assert.ok(preset, `LIVE_PROVIDER must be one of ${OPENAI_PRESETS.map((p) => p.id).join(", ")}`);
  const dataDir = mkdtempSync(join(tmpdir(), "grokbot-live-"));
  try {
    const bots = new BotRegistry(dataDir, [
      { id: "live", name: "Live", provider: preset.id, model, avatar: { shape: "circle", color: "blue" } },
    ]);
    const store = new TranscriptStore(dataDir);
    const provider = openAICompatibleProvider(preset, new SessionStore(dataDir));
    const gateway = new Gateway(bots, store, new Map([[preset.id, provider]]), new LocalFolderComputers(dataDir));

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
    rmSync(dataDir, { recursive: true, force: true });
  }
});
