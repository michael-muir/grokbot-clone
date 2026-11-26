// Choice cards, run ids and client nonces: the transcript additions from the Grok Bot capture (#64).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { askUserTool } from "../src/agent/tools.ts";
import { BotRegistry } from "../src/bots.ts";
import { LocalFolderComputers } from "../src/computer.ts";
import { Gateway } from "../src/gateway.ts";
import { createHttpServer } from "../src/http.ts";
import { Credentials, MemoryKeyStore } from "../src/keys.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { ProviderRegistry } from "../src/providers/index.ts";
import { TranscriptStore } from "../src/transcript.ts";
import type { EntryBody, ProviderId, TranscriptEntry } from "../src/types.ts";

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-choice-"));
  const bots = new BotRegistry(dir, [
    { id: "nova", name: "Nova", provider: "fake", avatar: { shape: "circle", color: "amber" } },
  ]);
  const store = new TranscriptStore(dir);
  const providers: ProviderRegistry = new Map<ProviderId, FakeProvider>([["fake", new FakeProvider(1)]]);
  const gateway = new Gateway(bots, store, providers, new LocalFolderComputers(dir));
  const server = createHttpServer({
    gateway,
    bots,
    store,
    providers,
    credentials: new Credentials(new MemoryKeyStore(), {}),
    token: "secret",
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    store,
    gateway,
    post,
    cleanup() {
      server.closeAllConnections();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function until<T>(get: () => T | undefined, ms = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const pendingChoice = (store: TranscriptStore) =>
  store.list("nova").find((e) => e.body.kind === "choice" && e.body.state === "pending");
const choiceBody = (e: TranscriptEntry | undefined) =>
  e?.body.kind === "choice" ? (e.body as Extract<EntryBody, { kind: "choice" }>) : undefined;
const lastText = (store: TranscriptStore) =>
  store
    .list("nova")
    .flatMap((e) => (e.body.kind === "assistant_text" ? [e.body.text] : []))
    .at(-1);

test("choice card: an answer over HTTP resumes the run, and the card records it", async () => {
  const t = await setup();
  try {
    const { done } = await t.gateway.sendMessage("nova", "/choice");
    const card = await until(() => pendingChoice(t.store));
    assert.deepEqual(choiceBody(card)?.options, [
      { label: "Red", value: "red" },
      { label: "Blue", value: "blue" },
    ]);
    assert.equal((await t.post(`/bots/nova/choices/${card.id}`, { answer: "blue" })).status, 200);
    await done;
    assert.equal(choiceBody(t.store.get("nova", card.id))?.state, "answered");
    assert.equal(choiceBody(t.store.get("nova", card.id))?.answer, "blue");
    assert.equal(lastText(t.store), "You picked blue.");
    assert.equal((await t.post(`/bots/nova/choices/${card.id}`, { answer: "red" })).status, 404, "answered once");
  } finally {
    t.cleanup();
  }
});

test("choice card: a typed answer is accepted only when the card allows it, and is trimmed", async () => {
  const t = await setup();
  try {
    const { done } = await t.gateway.sendMessage("nova", "/choice");
    const card = await until(() => pendingChoice(t.store));
    assert.equal(t.gateway.answerChoice("nova", card.id, "   "), "invalid");
    assert.equal(t.gateway.answerChoice("nova", card.id, "x".repeat(501)), "invalid");
    assert.equal((await t.post(`/bots/nova/choices/${card.id}`, { answer: 7 })).status, 400);
    assert.equal(t.gateway.answerChoice("nova", card.id, "  green  "), "ok");
    await done;
    assert.equal(lastText(t.store), "You picked green.");
  } finally {
    t.cleanup();
  }
});

test("choice card: stopping the run marks a pending card expired", async () => {
  const t = await setup();
  try {
    const { done } = await t.gateway.sendMessage("nova", "/choice");
    const card = await until(() => pendingChoice(t.store));
    t.gateway.interrupt("nova");
    await done;
    assert.equal(choiceBody(t.store.get("nova", card.id))?.state, "expired");
    assert.equal(t.gateway.answerChoice("nova", card.id, "red"), "not-pending");
  } finally {
    t.cleanup();
  }
});

test("run id: every entry written during a run carries the run's id; the user's message has none", async () => {
  const t = await setup();
  try {
    const { done } = await t.gateway.sendMessage("nova", "/choice");
    const card = await until(() => pendingChoice(t.store));
    t.gateway.answerChoice("nova", card.id, "red");
    await done;
    const [user, ...rest] = t.store.list("nova");
    assert.equal(user?.body.kind, "user_message");
    assert.equal(user?.runId, undefined);
    const run = rest.find((e) => e.body.kind === "run");
    assert.ok(run);
    assert.equal(run.runId, run.id, "the run entry carries its own id");
    assert.ok(
      rest.every((e) => e.runId === run.id),
      "status, card and reply all belong to the run",
    );
  } finally {
    t.cleanup();
  }
});

test("client nonce: echoed on the user entry; an invalid nonce is refused", async () => {
  const t = await setup();
  try {
    assert.equal((await t.post("/bots/nova/messages", { text: "hi", clientNonce: "n-123" })).status, 202);
    const user = await until(() => t.store.list("nova").find((e) => e.body.kind === "user_message"));
    assert.deepEqual(user.body, { kind: "user_message", text: "hi", clientNonce: "n-123" });
    await until(() => (t.gateway.isRunning("nova") ? undefined : true));
    assert.equal((await t.post("/bots/nova/messages", { text: "hi", clientNonce: "" })).status, 400);
    assert.equal((await t.post("/bots/nova/messages", { text: "hi", clientNonce: "x".repeat(101) })).status, 400);
  } finally {
    t.cleanup();
  }
});

test("ask_user: returns the answer, refuses bad options, and says so when nobody can answer", async () => {
  const signal = new AbortController().signal;
  const asked: unknown[] = [];
  const ctx = {
    workspaceDir: ".",
    signal,
    ask: async (q: unknown) => {
      asked.push(q);
      return "Blue";
    },
  };
  const r = await askUserTool.run({ question: "Color?", options: ["Red", "Blue", "Red"], allow_other: true }, ctx);
  assert.deepEqual(r, { ok: true, output: "The user answered: Blue" });
  assert.deepEqual(asked, [
    {
      prompt: "Color?",
      options: [
        { label: "Red", value: "Red" },
        { label: "Blue", value: "Blue" },
      ],
      allowCustom: true,
    },
  ]);
  await assert.rejects(askUserTool.run({ question: "Q", options: ["only one"] }, ctx), /2 to 6/);
  await assert.rejects(askUserTool.run({ question: "Q", options: ["Same", "Same"] }, ctx), /2 different/);
  const nobody = await askUserTool.run({ question: "Q", options: ["a", "b"] }, { workspaceDir: ".", signal });
  assert.equal(nobody.ok, false);
  const stopped = await askUserTool.run({ question: "Q", options: ["a", "b"] }, { ...ctx, ask: async () => undefined });
  assert.deepEqual(stopped, { ok: false, output: "The run was stopped before the user answered." });
  assert.equal(askUserTool.readOnly, true, "asking needs no approval");
});
