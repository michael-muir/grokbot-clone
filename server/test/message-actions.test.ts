// Message reactions and ratings: what the gateway accepts, what it keeps, and that it survives a restart.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BotRegistry } from "../src/bots.ts";
import { LocalFolderComputers } from "../src/computer.ts";
import { BotRuleError, Gateway } from "../src/gateway.ts";
import { createHttpServer } from "../src/http.ts";
import { Credentials, MemoryKeyStore } from "../src/keys.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { ProviderRegistry } from "../src/providers/index.ts";
import { TranscriptStore } from "../src/transcript.ts";
import type { ProviderId, TranscriptEntry } from "../src/types.ts";

function setup(dir = mkdtempSync(join(tmpdir(), "smarty-actions-"))) {
  const bots = new BotRegistry(dir, [
    { id: "nova", name: "Nova", provider: "fake", avatar: { shape: "star", color: "purple" } },
  ]);
  const store = new TranscriptStore(dir);
  const providers: ProviderRegistry = new Map<ProviderId, FakeProvider>([["fake", new FakeProvider(1)]]);
  const gateway = new Gateway(bots, store, providers, new LocalFolderComputers(dir));
  /** One exchange: the user's message and the bot's reply. */
  const exchange = async (text: string) => {
    const { entry, done } = await gateway.sendMessage("nova", text);
    await done;
    const reply = store.list("nova").findLast((e) => e.body.kind === "assistant_text");
    assert.ok(reply);
    return { mine: entry, reply };
  };
  return {
    dir,
    bots,
    store,
    gateway,
    providers,
    exchange,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("messages: reactions are added once, removed, and kept across a restart", async () => {
  const t = setup();
  try {
    const { mine, reply } = await t.exchange("apples");
    assert.deepEqual(t.gateway.react("nova", reply.id, "👍", true), ["👍"]);
    assert.deepEqual(t.gateway.react("nova", reply.id, "❤️", true), ["👍", "❤️"]);
    assert.deepEqual(t.gateway.react("nova", reply.id, "👍", true), ["👍", "❤️"], "each reaction once");
    assert.deepEqual(t.gateway.react("nova", reply.id, "👍", false), ["❤️"]);
    assert.deepEqual(t.gateway.react("nova", mine.id, "🎉", true), ["🎉"], "your own messages take them too");
    assert.deepEqual(t.gateway.react("nova", mine.id, "🎉", false), []);

    const after = new TranscriptStore(t.dir);
    assert.deepEqual(after.get("nova", reply.id)?.reactions, ["❤️"]);
    assert.equal(after.get("nova", mine.id)?.reactions, undefined, "the last one removed leaves none");
    assert.deepEqual(after.get("nova", reply.id)?.body, reply.body, "the message itself is unchanged");
  } finally {
    t.cleanup();
  }
});

test("messages: a bot message's rating is set, changed and cleared, and kept across a restart", async () => {
  const t = setup();
  try {
    const first = await t.exchange("apples");
    const second = await t.exchange("pears");
    const heard: TranscriptEntry[] = [];
    t.store.subscribe("nova", (e) => heard.push(e));
    assert.equal(t.gateway.rate("nova", first.reply.id, "up"), "up");
    assert.equal(t.gateway.rate("nova", first.reply.id, "down"), "down");
    assert.equal(t.gateway.rate("nova", second.reply.id, "up"), "up");
    assert.equal(t.gateway.rate("nova", second.reply.id, null), null);
    assert.equal(heard.length, 4, "every change streams to clients");
    t.gateway.rate("nova", second.reply.id, null);
    assert.equal(heard.length, 4, "no change, nothing sent");

    const after = new TranscriptStore(t.dir);
    assert.equal(after.get("nova", first.reply.id)?.feedback, "down");
    assert.equal(after.get("nova", second.reply.id)?.feedback, undefined);
  } finally {
    t.cleanup();
  }
});

test("messages: only visible messages take reactions, only bot messages take ratings, only known emoji", async () => {
  const t = setup();
  try {
    const { mine, reply } = await t.exchange("apples");
    const later = await t.exchange("pears");
    const run = t.store.list("nova").find((e) => e.body.kind === "run");
    assert.throws(() => t.gateway.react("nova", reply.id, "🦄", true), BotRuleError);
    assert.throws(() => t.gateway.react("nova", run?.id ?? "", "👍", true), BotRuleError);
    assert.throws(() => t.gateway.react("nova", "no-such-entry", "👍", true), BotRuleError);
    assert.throws(() => t.gateway.rate("nova", mine.id, "up"), BotRuleError);
    t.gateway.rollBack("nova", later.mine.id);
    assert.throws(() => t.gateway.react("nova", later.reply.id, "👍", true), BotRuleError, "rolled back");
    assert.throws(() => t.gateway.rate("nova", later.reply.id, "up"), BotRuleError, "rolled back");
  } finally {
    t.cleanup();
  }
});

test("messages: reacting doesn't wait for the bot to finish", async () => {
  const t = setup();
  try {
    const { reply } = await t.exchange("apples");
    const { done } = await t.gateway.sendMessage("nova", "/slow");
    assert.deepEqual(t.gateway.react("nova", reply.id, "😂", true), ["😂"]);
    t.gateway.interrupt("nova");
    await done;
  } finally {
    t.cleanup();
  }
});

test("transcript: mark changes an entry in place, streams it, and removes a mark given as undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "smarty-mark-"));
  try {
    const store = new TranscriptStore(dir);
    const e = store.append("nova", { kind: "assistant_text", text: "Hi", streaming: false });
    const heard: TranscriptEntry[] = [];
    store.subscribe("nova", (x) => heard.push(x));
    const marked = store.mark("nova", e.id, { feedback: "up", reactions: ["👍"] });
    assert.equal(marked.seq, e.seq);
    assert.ok(marked.updatedSeq > e.updatedSeq);
    assert.equal(heard.length, 1);
    const cleared = store.mark("nova", e.id, { feedback: undefined });
    assert.equal("feedback" in cleared, false);
    assert.deepEqual(cleared.reactions, ["👍"], "other marks stay");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("http: reactions and feedback answer 200, and 400 for what they refuse", async () => {
  const t = setup();
  const server = createHttpServer({
    gateway: t.gateway,
    bots: t.bots,
    store: t.store,
    providers: t.providers,
    credentials: new Credentials(new MemoryKeyStore(), {}),
    token: "secret",
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  try {
    const { mine, reply } = await t.exchange("apples");
    const at = (id: string, what: string) => `/bots/nova/entries/${id}/${what}`;
    assert.deepEqual(await post(at(reply.id, "reactions"), { emoji: "👍", on: true }), {
      status: 200,
      body: { reactions: ["👍"] },
    });
    assert.deepEqual(await post(at(reply.id, "feedback"), { vote: "down" }), {
      status: 200,
      body: { feedback: "down" },
    });
    assert.deepEqual(await post(at(reply.id, "feedback"), { vote: null }), { status: 200, body: { feedback: null } });
    assert.equal((await post(at(reply.id, "reactions"), { emoji: "👍" })).status, 400);
    assert.equal((await post(at(reply.id, "reactions"), { emoji: "🦄", on: true })).status, 400);
    assert.equal((await post(at(reply.id, "feedback"), { vote: "meh" })).status, 400);
    assert.equal((await post(at(mine.id, "feedback"), { vote: "up" })).status, 400);
    assert.equal((await post(at(reply.id, "other"), {})).status, 404);
  } finally {
    server.closeAllConnections();
    server.close();
    t.cleanup();
  }
});
