// Gateway tests: message flow, streaming, approvals, interrupts, persistence and the HTTP/SSE API, on the fake provider.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BotRegistry } from "../src/bots.ts";
import { LocalFolderComputers } from "../src/computer.ts";
import { BotBusyError, DENIED_WITHOUT_REASON, Gateway } from "../src/gateway.ts";
import { createHttpServer } from "../src/http.ts";
import { Credentials, MemoryKeyStore } from "../src/keys.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { ProviderRegistry } from "../src/providers/index.ts";
import { TranscriptStore } from "../src/transcript.ts";
import type { EntryBody, ProviderId, TranscriptEntry } from "../src/types.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-test-"));
  const bots = new BotRegistry(dir, [
    { id: "nova", name: "Nova", provider: "fake", avatar: { shape: "star", color: "violet" } },
  ]);
  const store = new TranscriptStore(dir);
  const providers: ProviderRegistry = new Map<ProviderId, FakeProvider>([["fake", new FakeProvider(1)]]);
  const gateway = new Gateway(bots, store, providers, new LocalFolderComputers(dir));
  return { dir, bots, store, gateway, providers, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const bodies = (entries: TranscriptEntry[]) => entries.map((e) => e.body);
const ofKind = <K extends EntryBody["kind"]>(entries: TranscriptEntry[], kind: K) =>
  entries.map((e) => e.body).filter((b): b is Extract<EntryBody, { kind: K }> => b.kind === kind);

async function waitFor<T>(fn: () => T | undefined, ms = 2000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out");
}

test("a message produces user, run, and a streamed-then-final assistant entry", async () => {
  const t = setup();
  try {
    const seen: TranscriptEntry[] = [];
    t.store.subscribe("nova", (e) => seen.push(e));
    const { done } = await t.gateway.sendMessage("nova", "hello there");
    await done;

    const entries = t.store.list("nova");
    assert.deepEqual(
      entries.map((e) => e.body.kind),
      ["user_message", "run", "assistant_text"],
    );
    assert.deepEqual(ofKind(entries, "assistant_text")[0], {
      kind: "assistant_text",
      text: "Nova here. You said: hello there",
      streaming: false,
    });
    assert.equal(ofKind(entries, "run")[0].state, "finished");
    // The assistant entry was updated in place while streaming (several updates, one entry).
    const assistantUpdates = seen.filter((e) => e.body.kind === "assistant_text");
    assert.ok(assistantUpdates.length > 3);
    assert.equal(new Set(assistantUpdates.map((e) => e.id)).size, 1);
    // updatedSeq strictly increases across all updates.
    const seqs = seen.map((e) => e.updatedSeq);
    assert.deepEqual(
      seqs,
      [...seqs].sort((a, b) => a - b),
    );
    // The session is stored for resume.
    assert.equal(t.bots.get("nova")?.sessionId, "fake-session-nova");
  } finally {
    t.cleanup();
  }
});

test("approval card: allow runs the tool, deny reports the reason", async () => {
  const t = setup();
  try {
    for (const allow of [true, false]) {
      const { done } = await t.gateway.sendMessage("nova", "/tool");
      const card = await waitFor(() =>
        t.store.list("nova").find((e) => e.body.kind === "approval" && e.body.state === "pending"),
      );
      assert.equal(
        t.gateway.answerApproval("nova", card.id, allow ? { allow: true } : { allow: false, reason: "not now" }),
        true,
      );
      await done;
      const answered = t.store.get("nova", card.id)?.body;
      assert.equal(answered?.kind === "approval" && answered.state, allow ? "approved" : "denied");
    }
    const statuses = ofKind(t.store.list("nova"), "status").map((s) => s.state);
    assert.deepEqual(statuses, ["done", "failed"]);
    const texts = ofKind(t.store.list("nova"), "assistant_text").map((a) => a.text);
    assert.match(texts[0], /printed hello/);
    assert.match(texts[1], /not now/);
  } finally {
    t.cleanup();
  }
});

test("HTTP: a denial without a reason shows plain Denied, and the model gets a default reason", async () => {
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
  const auth = { authorization: "Bearer secret", "content-type": "application/json" };
  try {
    const { done } = await t.gateway.sendMessage("nova", "/tool");
    const card = await waitFor(() =>
      t.store.list("nova").find((e) => e.body.kind === "approval" && e.body.state === "pending"),
    );
    // What the desktop app sends when the reason field is left empty.
    const answered = await fetch(`${base}/bots/nova/approvals/${card.id}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ allow: false, reason: "  " }),
    });
    assert.equal(answered.status, 200);
    await done;
    const body = t.store.get("nova", card.id)?.body;
    assert.equal(body?.kind === "approval" && body.state, "denied");
    assert.equal(body?.kind === "approval" && body.reason, undefined, "no reason on the card");
    const reply = ofKind(t.store.list("nova"), "assistant_text").at(-1)?.text ?? "";
    assert.ok(reply.includes(DENIED_WITHOUT_REASON), "the model was told the user denied it");
  } finally {
    server.closeAllConnections();
    server.close();
    t.cleanup();
  }
});

test("interrupt stops a run, and a second message while busy is refused", async () => {
  const t = setup();
  try {
    const { done } = await t.gateway.sendMessage("nova", "/slow");
    await assert.rejects(t.gateway.sendMessage("nova", "again"), BotBusyError);
    await waitFor(() => t.store.list("nova").find((e) => e.body.kind === "assistant_text"));
    assert.equal(t.gateway.interrupt("nova"), true);
    await done;
    const run = ofKind(t.store.list("nova"), "run")[0];
    assert.equal(run.state, "interrupted");
    assert.equal(ofKind(t.store.list("nova"), "assistant_text")[0].streaming, false);
    assert.equal(t.gateway.interrupt("nova"), false);
  } finally {
    t.cleanup();
  }
});

test("HTTP: Stop ends a streaming run as interrupted within 2 s", async () => {
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
  const auth = { authorization: "Bearer secret", "content-type": "application/json" };
  try {
    await t.gateway.sendMessage("nova", "/slow");
    await waitFor(() => t.store.list("nova").find((e) => e.body.kind === "assistant_text"));
    const pressed = Date.now();
    const stopped = await fetch(`${base}/bots/nova/interrupt`, { method: "POST", headers: auth });
    assert.equal(stopped.status, 202);
    await waitFor(() => {
      const run = ofKind(t.store.list("nova"), "run")[0];
      return run?.state === "interrupted" ? run : undefined;
    }, 2_000);
    const ms = Date.now() - pressed;
    assert.ok(ms < 2_000, `stopped after ${ms} ms`);
    assert.equal(ofKind(t.store.list("nova"), "assistant_text")[0]?.streaming, false, "the text stops streaming");
  } finally {
    server.closeAllConnections();
    server.close();
    t.cleanup();
  }
});

test("shutdown interrupts every run and waits until each has recorded its end", async () => {
  const t = setup();
  try {
    const { done } = await t.gateway.sendMessage("nova", "/slow");
    await waitFor(() => t.store.list("nova").find((e) => e.body.kind === "assistant_text"));
    await t.gateway.shutdown();
    // Already recorded when shutdown resolves, not some time later.
    assert.equal(ofKind(t.store.list("nova"), "run")[0]?.state, "interrupted");
    assert.equal(t.gateway.isRunning("nova"), false);
    await done;
    await t.gateway.shutdown(); // nothing running: resolves at once
  } finally {
    t.cleanup();
  }
});

test("a failed run records an error entry", async () => {
  const t = setup();
  try {
    const { done } = await t.gateway.sendMessage("nova", "/fail");
    await done;
    // Entries are in conversation order: the run row was created first, the error after.
    assert.deepEqual(bodies(t.store.list("nova")), [
      { kind: "user_message", text: "/fail" },
      { kind: "run", provider: "fake", state: "failed" },
      { kind: "error", message: "Scripted failure." },
    ]);
  } finally {
    t.cleanup();
  }
});

test("a message that can't be recorded doesn't leave the bot busy", async () => {
  const t = setup();
  const append = t.store.append.bind(t.store);
  try {
    t.store.append = () => {
      throw new Error("disk full");
    };
    await assert.rejects(t.gateway.sendMessage("nova", "hello"), /disk full/);
    assert.equal(t.gateway.isRunning("nova"), false);

    t.store.append = append;
    const { done } = await t.gateway.sendMessage("nova", "hello again");
    await done;
    assert.equal(ofKind(t.store.list("nova"), "run")[0].state, "finished");
  } finally {
    t.store.append = append;
    t.cleanup();
  }
});

test("transcript survives a restart", async () => {
  const t = setup();
  try {
    const { done } = await t.gateway.sendMessage("nova", "remember me");
    await done;
    const reloaded = new TranscriptStore(t.dir).list("nova");
    assert.deepEqual(reloaded, t.store.list("nova"));
  } finally {
    t.cleanup();
  }
});

test("HTTP: send a message, read it back over SSE, and answer an approval", async () => {
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
  const auth = { authorization: "Bearer secret", "content-type": "application/json" };
  try {
    assert.equal((await fetch(`${base}/bots`)).status, 401);
    const list = await (await fetch(`${base}/bots`, { headers: auth })).json();
    assert.equal(list[0].name, "Nova");
    assert.equal("sessionId" in list[0], false);

    const sseAbort = new AbortController();
    const sse = await fetch(`${base}/bots/nova/events`, { headers: auth, signal: sseAbort.signal });
    assert.ok(sse.body, "SSE response has a body");
    const reader = sse.body.getReader();
    const decoder = new TextDecoder();
    const events: TranscriptEntry[] = [];
    const pump = (async () => {
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = chunk.split("\n").find((line) => line.startsWith("data: "));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    })();

    const sent = await fetch(`${base}/bots/nova/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "/tool" }),
    });
    assert.equal(sent.status, 202);
    const card = await waitFor(() => events.find((e) => e.body.kind === "approval"));
    const busy = await fetch(`${base}/bots/nova/messages`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ text: "hi" }),
    });
    assert.equal(busy.status, 409);
    const answered = await fetch(`${base}/bots/nova/approvals/${card.id}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ allow: true }),
    });
    assert.equal(answered.status, 200);
    await waitFor(() => events.find((e) => e.body.kind === "run" && e.body.state === "finished"));

    const bad = await fetch(`${base}/bots/nova`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ provider: "gpt" }),
    });
    assert.equal(bad.status, 400);
    sseAbort.abort();
    await pump.catch(() => {});
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    t.cleanup();
  }
});

test("an approval answered the moment its card appears isn't lost", async () => {
  const t = setup();
  try {
    t.store.subscribe("nova", (e) => {
      if (e.body.kind === "approval" && e.body.state === "pending") {
        t.gateway.answerApproval("nova", e.id, { allow: true });
      }
    });
    const { done } = await t.gateway.sendMessage("nova", "/tool");
    await done;
    const card = ofKind(t.store.list("nova"), "approval")[0];
    assert.equal(card?.state, "approved");
    assert.equal(ofKind(t.store.list("nova"), "run")[0]?.state, "finished");
  } finally {
    t.cleanup();
  }
});

test("an update that changes nothing isn't written or broadcast", async () => {
  const t = setup();
  try {
    const entry = t.store.append("nova", { kind: "error", message: "x" });
    const seen: TranscriptEntry[] = [];
    t.store.subscribe("nova", (e) => seen.push(e));
    const same = t.store.update("nova", entry.id, (b) => b);
    assert.equal(same.updatedSeq, entry.updatedSeq);
    assert.equal(seen.length, 0);
  } finally {
    t.cleanup();
  }
});

test("changing a bot's provider drops its model, unless the same change sets one", () => {
  const t = setup();
  try {
    t.bots.update("nova", { model: "claude-opus-5-5" });
    assert.equal(t.bots.update("nova", { provider: "ollama" }).model, undefined);
    assert.equal(t.bots.update("nova", { provider: "openai", model: "gpt-test" }).model, "gpt-test");
    assert.equal(t.bots.update("nova", { name: "Nova 2" }).model, "gpt-test");
  } finally {
    t.cleanup();
  }
});
