// Durable runs (#22): a run the app cut off (a crash, quitting) is closed on startup, marked, and can be resumed in
// the same conversation and session. A user's Stop isn't a cut-off.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BotRegistry } from "../src/bots.ts";
import { LocalFolderComputers } from "../src/computer.ts";
import { BotBusyError, BotRuleError, Gateway, RESUME_PROMPT } from "../src/gateway.ts";
import { createHttpServer } from "../src/http.ts";
import { Credentials, MemoryKeyStore } from "../src/keys.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { ProviderRegistry } from "../src/providers/index.ts";
import { TranscriptStore } from "../src/transcript.ts";
import type { AgentProvider, EntryBody, ProviderId, RunRequest, TranscriptEntry } from "../src/types.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "smarty-durable-"));
  const bots = new BotRegistry(dir, [
    { id: "nova", name: "Nova", provider: "fake", avatar: { shape: "star", color: "purple" } },
  ]);
  const store = new TranscriptStore(dir);
  // One provider for every gateway here, so its in-memory sessions outlive a "restart".
  const providers: ProviderRegistry = new Map<ProviderId, FakeProvider>([["fake", new FakeProvider(1)]]);
  const start = () => new Gateway(bots, store, providers, new LocalFolderComputers(dir));
  return { dir, bots, store, providers, start, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const runOf = (e: TranscriptEntry | undefined) => (e?.body.kind === "run" ? e.body : undefined);

/** What the gateway left behind when its process died mid-run: a run still "running", with its last checkpoint. */
function crashMidRun(t: ReturnType<typeof setup>, threadId?: string): TranscriptEntry {
  const session = threadId ? t.bots.get("nova")?.threadSessions?.[threadId]?.sessionId : t.bots.get("nova")?.sessionId;
  const runId = `crashed-${threadId ?? "main"}`;
  t.store.append("nova", { kind: "user_message", text: "build it" }, { runId, threadId });
  const run = t.store.append(
    "nova",
    {
      kind: "run",
      provider: "fake",
      state: "running",
      usage: { inputTokens: 10, outputTokens: 2 },
      ...(session ? { checkpoint: { sessionId: session, at: "1" } } : {}),
    } as EntryBody,
    { id: runId, runId, threadId },
  );
  t.store.append("nova", { kind: "assistant_text", text: "Working on", streaming: true }, { runId, threadId });
  return run;
}

test("durable: a run cut off by a crash is closed on startup, marked cutOff, with its checkpoint and usage kept", async () => {
  const t = setup();
  try {
    await (await t.start().sendMessage("nova", "apples")).done;
    const run = crashMidRun(t);
    t.start(); // the restart
    const after = runOf(t.store.get("nova", run.id));
    assert.equal(after?.state, "interrupted");
    assert.equal(after?.cutOff, true);
    assert.deepEqual(after?.usage, { inputTokens: 10, outputTokens: 2 });
    assert.ok(after?.checkpoint);
    assert.ok(!t.store.list("nova").some((e) => e.body.kind === "assistant_text" && e.body.streaming));
  } finally {
    t.cleanup();
  }
});

test("durable: resume continues the same conversation and session, and the bot keeps what it had", async () => {
  const t = setup();
  try {
    await (await t.start().sendMessage("nova", "apples")).done;
    const cut = crashMidRun(t);
    const gateway = t.start();
    await gateway.resumeRun("nova", cut.id).done;
    assert.equal(runOf(t.store.get("nova", cut.id))?.resumed, true);
    const next = t.store.list("nova").findLast((e) => e.body.kind === "run");
    assert.equal(runOf(next)?.resumes, cut.id);
    assert.equal(runOf(next)?.state, "finished");
    assert.equal(next?.threadId, undefined);
    const reply = t.store.list("nova").findLast((e) => e.body.kind === "assistant_text");
    assert.equal(reply?.body.kind === "assistant_text" && reply.body.text, `Nova here. You said: ${RESUME_PROMPT}`);
    // The session went on: the bot remembers the conversation from before the cut.
    const { done } = await gateway.sendMessage("nova", "/history");
    await done;
    const remembered = t.store.list("nova").findLast((e) => e.body.kind === "assistant_text");
    assert.equal(
      remembered?.body.kind === "assistant_text" && remembered.body.text,
      `I remember: apples | ${RESUME_PROMPT}`,
    );
  } finally {
    t.cleanup();
  }
});

test("durable: a run cut off in a thread resumes in that thread", async () => {
  const t = setup();
  try {
    const first = await t.start().sendMessage("nova", "apples");
    await first.done;
    await (await t.start().sendMessage("nova", "side note", undefined, first.entry.id)).done;
    const cut = crashMidRun(t, first.entry.id);
    const gateway = t.start();
    await gateway.resumeRun("nova", cut.id).done;
    const next = t.store.list("nova").findLast((e) => e.body.kind === "run");
    assert.equal(next?.threadId, first.entry.id);
  } finally {
    t.cleanup();
  }
});

test("durable: a clean shutdown marks the runs it stops as cut off; a user's Stop doesn't", async () => {
  const t = setup();
  try {
    const gateway = t.start();
    const stopped = await gateway.sendMessage("nova", "/slow");
    await new Promise((r) => setTimeout(r, 20));
    gateway.interrupt("nova");
    await stopped.done;
    const byUser = runOf(t.store.list("nova").findLast((e) => e.body.kind === "run"));
    assert.equal(byUser?.state, "interrupted");
    assert.equal(byUser?.cutOff, undefined);

    const quitting = await gateway.sendMessage("nova", "/slow");
    await new Promise((r) => setTimeout(r, 20));
    await gateway.shutdown();
    await quitting.done;
    const byApp = runOf(t.store.list("nova").findLast((e) => e.body.kind === "run"));
    assert.equal(byApp?.state, "interrupted");
    assert.equal(byApp?.cutOff, true);
  } finally {
    t.cleanup();
  }
});

test("durable: only the latest cut-off run of a conversation can be resumed, once, while the bot is idle", async () => {
  const t = setup();
  try {
    await (await t.start().sendMessage("nova", "apples")).done;
    const cut = crashMidRun(t);
    const gateway = t.start();
    assert.throws(() => gateway.resumeRun("nova", "no-such-run"), BotRuleError);
    const userStopped = t.store.list("nova").find((e) => e.body.kind === "run" && e.id !== cut.id);
    assert.throws(() => gateway.resumeRun("nova", userStopped?.id ?? ""), BotRuleError, "not cut off");

    const slow = await gateway.sendMessage("nova", "/slow");
    assert.throws(() => gateway.resumeRun("nova", cut.id), BotBusyError);
    await slow.done;
    assert.throws(() => gateway.resumeRun("nova", cut.id), BotRuleError, "a later run exists");

    const t2 = setup();
    try {
      await (await t2.start().sendMessage("nova", "apples")).done;
      const cut2 = crashMidRun(t2);
      const g2 = t2.start();
      await g2.resumeRun("nova", cut2.id).done;
      assert.throws(() => g2.resumeRun("nova", cut2.id), BotRuleError, "resumed once already");
    } finally {
      t2.cleanup();
    }
  } finally {
    t.cleanup();
  }
});

test("http: resume answers 202, 400 or 409", async () => {
  const t = setup();
  await (await t.start().sendMessage("nova", "apples")).done;
  const cut = crashMidRun(t);
  const gateway = t.start();
  const server = createHttpServer({
    gateway,
    bots: t.bots,
    store: t.store,
    providers: t.providers,
    credentials: new Credentials(new MemoryKeyStore(), {}),
    token: "secret",
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: "{}",
    });
  try {
    assert.equal((await post("/bots/nova/runs/nope/resume")).status, 400);
    assert.equal((await post(`/bots/nova/runs/${cut.id}/resume`)).status, 202);
    assert.equal((await post(`/bots/nova/runs/${cut.id}/resume`)).status, 409, "the resumed run is still going");
    while (gateway.isRunning("nova")) await new Promise((r) => setTimeout(r, 5));
    assert.equal((await post(`/bots/nova/runs/${cut.id}/resume`)).status, 400, "already resumed");
  } finally {
    server.closeAllConnections();
    server.close();
    t.cleanup();
  }
});

test("durable: no resume after the conversation started over, and a stop right before quitting stays a stop", async () => {
  const t = setup();
  try {
    await (await t.start().sendMessage("nova", "apples")).done;
    const cut = crashMidRun(t);
    const gateway = t.start();
    gateway.startFresh("nova");
    assert.throws(() => gateway.resumeRun("nova", cut.id), /started over/);

    const run = await gateway.sendMessage("nova", "/slow");
    await new Promise((r) => setTimeout(r, 20));
    gateway.interrupt("nova");
    await gateway.shutdown(); // quitting while the stopped run is still unwinding
    await run.done;
    const last = runOf(t.store.list("nova").findLast((e) => e.body.kind === "run"));
    assert.equal(last?.cutOff, undefined, "the user stopped it");
    await assert.rejects(gateway.sendMessage("nova", "hi"), /shutting down/, "nothing new starts while quitting");
  } finally {
    t.cleanup();
  }
});

test("durable: a resume that fails can be tried again; one cut before any save tells the bot what it was answering", async () => {
  const t = setup();
  try {
    await (await t.start().sendMessage("nova", "apples")).done;
    // Cut before the session saved anything: no checkpoint on the run.
    const runId = "cut-early";
    t.store.append("nova", { kind: "user_message", text: "refactor X" }, { runId });
    const cut = t.store.append("nova", { kind: "run", provider: "fake", state: "running" }, { id: runId, runId });
    t.start();

    const prompts: string[] = [];
    let fail = true;
    const fake = t.providers.get("fake") as AgentProvider;
    const flaky: AgentProvider = {
      id: "fake",
      async run(req: RunRequest, cb) {
        prompts.push(req.prompt);
        if (fail) return { status: "failed", error: "bad key" };
        return fake.run(req, cb);
      },
    };
    const gateway = new Gateway(t.bots, t.store, new Map([["fake", flaky]]), new LocalFolderComputers(t.dir));
    await gateway.resumeRun("nova", cut.id).done;
    assert.equal(runOf(t.store.get("nova", cut.id))?.resumed, undefined, "a failed resume doesn't settle it");
    fail = false;
    await gateway.resumeRun("nova", cut.id).done;
    assert.equal(runOf(t.store.get("nova", cut.id))?.resumed, true);
    assert.match(prompts[0] ?? "", /The message you were answering:\nrefactor X/);
  } finally {
    t.cleanup();
  }
});
