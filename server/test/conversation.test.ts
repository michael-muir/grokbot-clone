// Conversation controls: start fresh, roll back, and threads, end to end on the fake provider. The fake remembers
// each session's prompts ("/history" lists them), so these tests check what the bot's next run actually remembers.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BotRegistry } from "../src/bots.ts";
import { LocalFolderComputers } from "../src/computer.ts";
import { BotBusyError, BotRuleError, FRESH_NOTICE, Gateway, threadPrompt } from "../src/gateway.ts";
import { createHttpServer } from "../src/http.ts";
import { Credentials, MemoryKeyStore } from "../src/keys.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { ProviderRegistry } from "../src/providers/index.ts";
import { TranscriptStore } from "../src/transcript.ts";
import type { ProviderId, TranscriptEntry } from "../src/types.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "smarty-conv-"));
  const bots = new BotRegistry(dir, [
    { id: "nova", name: "Nova", provider: "fake", avatar: { shape: "star", color: "purple" } },
  ]);
  const store = new TranscriptStore(dir);
  const providers: ProviderRegistry = new Map<ProviderId, FakeProvider>([
    ["fake", new FakeProvider(1)],
    ["ollama", new FakeProvider(1)],
  ]);
  const gateway = new Gateway(bots, store, providers, new LocalFolderComputers(dir));

  /** Sends a message, waits for its run, and returns the message's entry and the bot's last reply in that conversation. */
  const say = async (text: string, threadId?: string) => {
    const { entry, done } = await gateway.sendMessage("nova", text, undefined, threadId);
    await done;
    const reply = store
      .list("nova")
      .filter((e) => !e.hidden && e.threadId === threadId && e.body.kind === "assistant_text")
      .at(-1);
    return { entry, reply: reply?.body.kind === "assistant_text" ? reply.body.text : "", replyEntry: reply };
  };
  /** What the bot remembers in a conversation, by asking it. */
  const remembers = async (threadId?: string) => (await say("/history", threadId)).reply;
  const visible = (threadId?: string) =>
    store
      .list("nova")
      .filter((e) => !e.hidden && e.threadId === threadId)
      .map((e) => (e.body.kind === "user_message" ? e.body.text : e.body.kind));

  return {
    dir,
    bots,
    store,
    gateway,
    providers,
    say,
    remembers,
    visible,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const NOTHING = "I don't remember anything yet.";

test("conversation: start fresh drops the session, keeps every entry, and marks the boundary", async () => {
  const t = setup();
  try {
    await t.say("apples");
    await t.say("pears");
    const before = t.store.list("nova").length;
    t.gateway.startFresh("nova");
    const entries = t.store.list("nova");
    assert.equal(entries.length, before + 1, "nothing is removed");
    assert.ok(entries.every((e) => !e.hidden));
    assert.deepEqual(entries.at(-1)?.body, { kind: "notice", text: FRESH_NOTICE, reset: true });
    assert.equal(t.bots.get("nova")?.sessionId, undefined);
    assert.equal(await t.remembers(), NOTHING);
  } finally {
    t.cleanup();
  }
});

test("conversation: start fresh is refused while the bot is working", async () => {
  const t = setup();
  try {
    const { done } = await t.gateway.sendMessage("nova", "/slow");
    assert.throws(() => t.gateway.startFresh("nova"), BotBusyError);
    t.gateway.interrupt("nova");
    await done;
  } finally {
    t.cleanup();
  }
});

test("conversation: roll back hides the message and everything after it, and the next run forks from the run before", async () => {
  const t = setup();
  try {
    await t.say("apples");
    const pears = await t.say("pears");
    await t.say("plums");
    assert.deepEqual(t.gateway.rollBack("nova", pears.entry.id), { text: "pears" });
    assert.deepEqual(t.visible(), ["apples", "run", "assistant_text"]);
    const hidden = t.store.list("nova").filter((e) => e.hidden);
    assert.equal(hidden.length, 6, "pears and plums, each with its run and reply");
    assert.equal(t.bots.get("nova")?.sessionAt, "1", "the fork point is the end of the apples run");
    assert.equal(await t.remembers(), "I remember: apples");
    const bot = t.bots.get("nova");
    assert.equal(bot?.sessionAt, undefined, "the fork is used up");
    assert.notEqual(bot?.sessionId, "fake-session-nova", "the new run is on a new session");
    // The roll back holds from then on: the next run builds on the fork.
    assert.equal(await t.remembers(), "I remember: apples | /history");
  } finally {
    t.cleanup();
  }
});

test("conversation: rolling back again goes further back, past a roll back's own fork", async () => {
  const t = setup();
  try {
    await t.say("apples");
    const pears = await t.say("pears");
    t.gateway.rollBack("nova", pears.entry.id);
    const figs = await t.say("figs");
    await t.say("kiwis");
    t.gateway.rollBack("nova", figs.entry.id);
    assert.deepEqual(t.visible(), ["apples", "run", "assistant_text"]);
    assert.equal(await t.remembers(), "I remember: apples");
  } finally {
    t.cleanup();
  }
});

test("conversation: roll back to the first message starts the conversation over", async () => {
  const t = setup();
  try {
    const apples = await t.say("apples");
    await t.say("pears");
    t.gateway.rollBack("nova", apples.entry.id);
    assert.deepEqual(t.visible(), []);
    assert.equal(t.bots.get("nova")?.sessionId, undefined);
    assert.equal(await t.remembers(), NOTHING);
  } finally {
    t.cleanup();
  }
});

test("conversation: roll back never forks across a fresh start or a provider switch", async () => {
  const t = setup();
  try {
    await t.say("apples");
    t.gateway.startFresh("nova");
    const pears = await t.say("pears");
    t.gateway.rollBack("nova", pears.entry.id);
    assert.equal(t.bots.get("nova")?.sessionId, undefined, "the apples run is before the fresh start");
    assert.equal(await t.remembers(), NOTHING);

    await t.say("figs");
    t.gateway.updateBot("nova", { provider: "ollama" });
    const kiwis = await t.say("kiwis");
    t.gateway.rollBack("nova", kiwis.entry.id);
    assert.equal(t.bots.get("nova")?.sessionId, undefined, "the figs run was on another provider");
  } finally {
    t.cleanup();
  }
});

test("conversation: roll back is refused for bot messages, hidden entries and while working", async () => {
  const t = setup();
  try {
    const apples = await t.say("apples");
    const pears = await t.say("pears");
    assert.throws(() => t.gateway.rollBack("nova", apples.replyEntry?.id ?? ""), BotRuleError);
    assert.throws(() => t.gateway.rollBack("nova", "no-such-entry"), BotRuleError);
    t.gateway.rollBack("nova", pears.entry.id);
    assert.throws(() => t.gateway.rollBack("nova", pears.entry.id), BotRuleError, "already hidden");
    const { done } = await t.gateway.sendMessage("nova", "/slow");
    assert.throws(() => t.gateway.rollBack("nova", apples.entry.id), BotBusyError);
    t.gateway.interrupt("nova");
    await done;
  } finally {
    t.cleanup();
  }
});

test("conversation: a thread's first message forks from the root's run and quotes the root", async () => {
  const t = setup();
  try {
    const apples = await t.say("apples");
    await t.say("pears");
    const root = apples.replyEntry;
    assert.ok(root);
    const first = await t.say("tell me more", root.id);
    assert.equal(first.entry.threadId, root.id);
    assert.equal(first.reply, `Nova here. You said: ${threadPrompt("Nova here. You said: apples", "tell me more")}`);
    assert.equal(
      await t.remembers(root.id),
      `I remember: apples | ${threadPrompt("Nova here. You said: apples", "tell me more")}`,
      "the thread knows the conversation up to its root, and not what came after (pears)",
    );
    const quoted = await t.say("and then?", root.id);
    assert.equal(quoted.reply, "Nova here. You said: and then?", "only the first message quotes the root");
  } finally {
    t.cleanup();
  }
});

test("conversation: thread messages stay out of the main conversation and keep their own session", async () => {
  const t = setup();
  try {
    const apples = await t.say("apples");
    await t.say("side note", apples.entry.id);
    assert.deepEqual(t.visible(), ["apples", "run", "assistant_text"]);
    assert.deepEqual(t.visible(apples.entry.id), ["side note", "run", "assistant_text"]);
    const bot = t.bots.get("nova");
    const thread = bot?.threadSessions?.[apples.entry.id];
    assert.ok(thread?.sessionId && thread.sessionId !== bot?.sessionId, "the thread has a session of its own");
    assert.equal(await t.remembers(), "I remember: apples", "the main conversation never heard the side note");
  } finally {
    t.cleanup();
  }
});

test("conversation: a thread can't start from a hidden, threaded or non-message entry", async () => {
  const t = setup();
  try {
    const apples = await t.say("apples");
    const note = await t.say("side note", apples.entry.id);
    const pears = await t.say("pears");
    const run = t.store.list("nova").find((e) => e.body.kind === "run");
    t.gateway.rollBack("nova", pears.entry.id);
    for (const id of [pears.entry.id, note.entry.id, run?.id ?? "", "no-such-entry"]) {
      await assert.rejects(t.gateway.sendMessage("nova", "hi", undefined, id), BotRuleError, id);
    }
    assert.equal(t.gateway.isRunning("nova"), false, "a refused message leaves the bot free");
  } finally {
    t.cleanup();
  }
});

test("conversation: rolling back inside a thread keeps the main chat, and back to its start forks from the root again", async () => {
  const t = setup();
  try {
    const apples = await t.say("apples");
    const first = await t.say("side note", apples.entry.id);
    await t.say("more", apples.entry.id);
    t.gateway.rollBack("nova", first.entry.id);
    assert.deepEqual(t.visible(), ["apples", "run", "assistant_text"], "the main chat is untouched");
    assert.deepEqual(t.visible(apples.entry.id), []);
    assert.equal(t.bots.get("nova")?.threadSessions?.[apples.entry.id], undefined);
    const again = await t.say("fresh start", apples.entry.id);
    assert.equal(again.reply, `Nova here. You said: ${threadPrompt("apples", "fresh start")}`, "quoted again");
    assert.equal(await t.remembers(apples.entry.id), `I remember: apples | ${threadPrompt("apples", "fresh start")}`);
  } finally {
    t.cleanup();
  }
});

test("conversation: rolling back the main chat takes the threads of hidden messages with it", async () => {
  const t = setup();
  try {
    await t.say("apples");
    const pears = await t.say("pears");
    await t.say("side note", pears.entry.id);
    t.gateway.rollBack("nova", pears.entry.id);
    assert.deepEqual(t.visible(pears.entry.id), [], "the thread's entries are hidden too");
    assert.deepEqual(t.bots.get("nova")?.threadSessions, {}, "and its session is dropped");
  } finally {
    t.cleanup();
  }
});

test("transcript: hide marks entries hidden, bumps updatedSeq, tells listeners, and survives a reload", () => {
  const dir = mkdtempSync(join(tmpdir(), "smarty-hide-"));
  try {
    const store = new TranscriptStore(dir);
    const a = store.append("nova", { kind: "user_message", text: "A" });
    const b = store.append("nova", { kind: "user_message", text: "B" });
    const heard: TranscriptEntry[] = [];
    store.subscribe("nova", (e) => heard.push(e));
    store.hide("nova", [b.id]);
    store.hide("nova", [b.id]); // already hidden: nothing new
    assert.equal(heard.length, 1);
    assert.equal(heard[0]?.hidden, true);
    assert.ok((heard[0]?.updatedSeq ?? 0) > b.updatedSeq);
    const reloaded = new TranscriptStore(dir).list("nova");
    assert.deepEqual(
      reloaded.map((e) => [e.id, e.hidden ?? false]),
      [
        [a.id, false],
        [b.id, true],
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bots: a provider switch drops thread sessions and a pending fork too", () => {
  const dir = mkdtempSync(join(tmpdir(), "smarty-bots-"));
  try {
    const bots = new BotRegistry(dir, [
      {
        id: "nova",
        name: "Nova",
        provider: "fake",
        avatar: { shape: "star", color: "purple" },
        sessionId: "s",
        sessionProvider: "fake",
        sessionAt: "3",
        threadSessions: { root: { sessionId: "t", sessionProvider: "fake" } },
      },
    ]);
    const next = bots.update("nova", { provider: "ollama" });
    assert.equal(next.sessionId, undefined);
    assert.equal(next.sessionAt, undefined);
    assert.equal(next.threadSessions, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("http: fresh, rollback and thread sends map refusals to 400 and 409", async () => {
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
    const apples = await t.say("apples");
    const pears = await t.say("pears");
    assert.equal((await post("/bots/nova/rollback", {})).status, 400);
    assert.equal((await post("/bots/nova/rollback", { entryId: apples.replyEntry?.id })).status, 400);
    assert.deepEqual(await post("/bots/nova/rollback", { entryId: pears.entry.id }), {
      status: 200,
      body: { text: "pears" },
    });
    assert.equal((await post("/bots/nova/messages", { text: "hi", threadId: pears.entry.id })).status, 400);
    assert.equal((await post("/bots/nova/messages", { text: "hi", threadId: 7 })).status, 400);
    assert.equal((await post("/bots/nova/fresh", {})).status, 200);

    const { done } = await t.gateway.sendMessage("nova", "/slow");
    assert.equal((await post("/bots/nova/fresh", {})).status, 409);
    assert.equal((await post("/bots/nova/rollback", { entryId: apples.entry.id })).status, 409);
    t.gateway.interrupt("nova");
    await done;
  } finally {
    server.closeAllConnections();
    server.close();
    t.cleanup();
  }
});
