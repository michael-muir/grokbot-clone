// Live check that Claude Code reads choice-card answers to AskUserQuestion. Not part of `npm test`; costs a little.
//
//   LIVE_PROVIDER=claude LIVE_MODEL=<model> npm run test:live
//
// Skipped for any other LIVE_PROVIDER. The bot is asked to ask a question with AskUserQuestion; the card is
// answered with its second option, and the bot must say that option back.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BotRegistry } from "../../src/bots.ts";
import { LocalFolderComputers } from "../../src/computer.ts";
import { Gateway } from "../../src/gateway.ts";
import { Credentials, KeychainKeyStore } from "../../src/keys.ts";
import { defaultProviders } from "../../src/providers/index.ts";
import { TranscriptStore } from "../../src/transcript.ts";

const skip = process.env.LIVE_PROVIDER !== "claude" && "only with LIVE_PROVIDER=claude";

test("live: claude reads the answer to AskUserQuestion from a choice card", { skip, timeout: 300_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "smarty-live-q-"));
  try {
    const bots = new BotRegistry(dataDir, [
      {
        id: "live",
        name: "Live",
        provider: "claude",
        model: process.env.LIVE_MODEL,
        avatar: { shape: "circle", color: "blue" },
      },
    ]);
    const store = new TranscriptStore(dataDir);
    const provider = defaultProviders(dataDir, new Credentials(new KeychainKeyStore())).get("claude");
    assert.ok(provider, "no claude provider");
    const gateway = new Gateway(bots, store, new Map([["claude", provider]]), new LocalFolderComputers(dataDir));

    let picked: string | undefined;
    store.subscribe("live", (e) => {
      const b = e.body;
      if (b.kind === "approval" && b.state === "pending") {
        console.log("unexpected approval card", JSON.stringify(b));
        gateway.answerApproval("live", e.id, { allow: false, reason: "Not part of this test." });
      }
      if (b.kind === "choice" && b.state === "pending") {
        picked = b.options[1]?.value;
        console.log("card", JSON.stringify(b), "->", picked);
        if (picked) gateway.answerChoice("live", e.id, picked);
      }
      if (b.kind !== "assistant_text" || !b.streaming) console.log(b.kind, JSON.stringify(b));
    });

    const { done } = await gateway.sendMessage(
      "live",
      "Use the AskUserQuestion tool to ask me which color I like, with the options Red, Green and Blue. " +
        "After I answer, reply with exactly: You picked <the color>.",
    );
    await done;

    const entries = store.list("live");
    const run = entries.find((e) => e.body.kind === "run");
    assert.equal(run?.body.kind === "run" && run.body.state, "finished");
    assert.ok(picked, "a choice card was shown");
    const reply = entries.flatMap((e) => (e.body.kind === "assistant_text" ? [e.body.text] : [])).join("\n");
    assert.match(reply, new RegExp(`You picked ${picked}`, "i"));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
