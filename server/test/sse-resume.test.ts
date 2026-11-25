// Tests for resuming the transcript stream: connections dropped mid-stream and during an approval, the backlog
// order, Last-Event-ID, stale connections and backoff.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BotRegistry } from "../src/bots.ts";
import { type StreamState, SubscriptionError, subscribeTranscript } from "../src/client/subscribe.ts";
import { TranscriptView } from "../src/client/transcript-view.ts";
import { LocalFolderComputers } from "../src/computer.ts";
import { Gateway } from "../src/gateway.ts";
import { createHttpServer } from "../src/http.ts";
import { Credentials, MemoryKeyStore } from "../src/keys.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { ProviderRegistry } from "../src/providers/index.ts";
import { TranscriptStore } from "../src/transcript.ts";
import type { ProviderId, TranscriptEntry } from "../src/types.ts";

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function stop(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}

async function setup(delayMs: number) {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-sse-"));
  dirs.push(dir);
  const bots = new BotRegistry(dir, [
    { id: "nova", name: "Nova", provider: "fake", avatar: { shape: "star", color: "violet" } },
  ]);
  const store = new TranscriptStore(dir);
  const providers: ProviderRegistry = new Map<ProviderId, FakeProvider>([["fake", new FakeProvider(delayMs)]]);
  const gateway = new Gateway(bots, store, providers, new LocalFolderComputers(dir));
  const credentials = new Credentials(new MemoryKeyStore(), {});
  const server = createHttpServer({ gateway, bots, store, providers, credentials });
  const url = await listen(server);
  return { store, gateway, server, url };
}

/** Subscribes a view; records every delivered (id, updatedSeq) so repeats can be detected. */
function follow(url: string) {
  const view = new TranscriptView();
  const delivered: string[] = [];
  const states: StreamState[] = [];
  const controller = new AbortController();
  const done = subscribeTranscript(url, "nova", {
    signal: controller.signal,
    backoff: { initialMs: 20, maxMs: 100 },
    onState: (s) => states.push(s),
    onEntry: (e) => {
      delivered.push(`${e.id}@${e.updatedSeq}`);
      view.apply(e);
    },
  });
  return { view, delivered, states, stop: () => controller.abort(), done };
}

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const runState = (entries: TranscriptEntry[]) => {
  const run = entries.filter((e) => e.body.kind === "run").at(-1);
  return run?.body.kind === "run" ? run.body.state : undefined;
};

test("connections dropped again and again mid-stream: every entry once, in order", async () => {
  const t = await setup(15);
  const client = follow(t.url);
  try {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const { done } = await t.gateway.sendMessage("nova", words);
    // Cut every open connection a few times while the reply streams.
    let drops = 0;
    const dropper = setInterval(() => {
      t.server.closeAllConnections();
      drops++;
    }, 120);
    await done;
    clearInterval(dropper);
    assert.ok(drops >= 3, `dropped ${drops} times`);

    const final = t.store.list("nova");
    await until(
      () =>
        runState(client.view.entries()) === "finished" &&
        client.view.cursor === Math.max(...final.map((e) => e.updatedSeq)),
    );
    assert.deepEqual(client.view.entries(), final, "the client's view matches the server's transcript");
    assert.equal(new Set(client.delivered).size, client.delivered.length, "no change was delivered twice");
    assert.ok(client.states.filter((s) => s === "reconnecting").length >= 3);
  } finally {
    client.stop();
    await client.done;
    await stop(t.server);
  }
});

test("a drop while an approval is pending, then an answer: the card and the run finish in the client's view", async () => {
  const t = await setup(1);
  const client = follow(t.url);
  try {
    const { done } = await t.gateway.sendMessage("nova", "/tool");
    await until(() => client.view.entries().some((e) => e.body.kind === "approval"));
    t.server.closeAllConnections();
    const card = client.view.entries().find((e) => e.body.kind === "approval");
    assert.ok(card);
    const answer = await fetch(`${t.url}/bots/nova/approvals/${card.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ allow: true }),
    });
    assert.equal(answer.status, 200);
    await done;
    await until(() => runState(client.view.entries()) === "finished");
    const approved = client.view.get(card.id);
    assert.equal(approved?.body.kind === "approval" && approved.body.state, "approved");
    assert.deepEqual(client.view.entries(), t.store.list("nova"));
  } finally {
    client.stop();
    await client.done;
    await stop(t.server);
  }
});

test("resuming after any point in the backlog loses nothing, even when change order differs from conversation order", () => {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-sse-"));
  dirs.push(dir);
  const store = new TranscriptStore(dir);
  const a = store.append("nova", { kind: "assistant_text", text: "A", streaming: true });
  store.append("nova", { kind: "user_message", text: "B" });
  store.append("nova", { kind: "user_message", text: "C" });
  store.update("nova", a.id, () => ({ kind: "assistant_text", text: "A, finished", streaming: false }));

  const stream = store.changedSince("nova", -1);
  assert.deepEqual(
    stream.map((e) => e.updatedSeq),
    [...stream.map((e) => e.updatedSeq)].sort((x, y) => x - y),
    "the stream is in change order",
  );
  for (let cut = 0; cut <= stream.length; cut++) {
    const seen = stream.slice(0, cut);
    const cursor = Math.max(-1, ...seen.map((e) => e.updatedSeq));
    const resumed = store.changedSince("nova", cursor);
    const ids = new Set([...seen, ...resumed].map((e) => e.id));
    assert.equal(ids.size, 3, `cut after ${cut} events: nothing lost`);
  }
});

test("Last-Event-ID resumes a plain EventSource-style client", async () => {
  const t = await setup(1);
  try {
    const { done } = await t.gateway.sendMessage("nova", "hello");
    await done;
    const all = t.store.changedSince("nova");
    const cut = all[1]?.updatedSeq ?? 0;
    const controller = new AbortController();
    const res = await fetch(`${t.url}/bots/nova/events`, {
      headers: { "last-event-id": String(cut) },
      signal: controller.signal,
    });
    assert.ok(res.body);
    const reader = res.body.getReader();
    let text = "";
    while (!text.includes("data:")) text += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    assert.match(text, /^retry: 2000\n/);
    const firstId = Number(/id: (\d+)/.exec(text)?.[1]);
    assert.equal(firstId, all[2]?.updatedSeq, "the stream continues right after Last-Event-ID");
  } finally {
    await stop(t.server);
  }
});

test("the view ignores stale updates and keeps the newest", () => {
  const view = new TranscriptView();
  const base = { id: "x", botId: "nova", seq: 0, createdAt: 0, updatedAt: 0 };
  assert.equal(view.apply({ ...base, updatedSeq: 5, body: { kind: "error", message: "new" } }), true);
  assert.equal(view.apply({ ...base, updatedSeq: 3, body: { kind: "error", message: "old" } }), false);
  assert.deepEqual(view.get("x")?.body, { kind: "error", message: "new" });
  assert.equal(view.cursor, 5);
});

test("a connection that goes silent is replaced", async () => {
  let connections = 0;
  const silent = createServer((_req, res) => {
    connections++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": connected\n\n"); // then nothing, ever
  });
  const url = await listen(silent);
  const controller = new AbortController();
  const done = subscribeTranscript(url, "nova", {
    signal: controller.signal,
    onEntry: () => {},
    staleAfterMs: 150,
    backoff: { initialMs: 10, maxMs: 10 },
  });
  try {
    await until(() => connections >= 3, 3000);
  } finally {
    controller.abort();
    await done;
    await stop(silent);
  }
});

test("retries back off, and a permanent refusal stops with an error", async () => {
  const attempts: number[] = [];
  let status = 503;
  const flaky = createServer((_req, res) => {
    attempts.push(Date.now());
    res.writeHead(status).end("nope");
  });
  const url = await listen(flaky);
  const controller = new AbortController();
  const done = subscribeTranscript(url, "nova", {
    signal: controller.signal,
    onEntry: () => {},
    backoff: { initialMs: 40, maxMs: 160 },
  });
  try {
    await until(() => attempts.length >= 5, 4000);
    const gaps = attempts.slice(1).map((t, i) => t - (attempts[i] ?? t));
    assert.ok((gaps[3] ?? 0) > (gaps[0] ?? 0), `gaps grow: ${gaps.join(", ")}`);
    status = 404;
    await assert.rejects(done, SubscriptionError);
  } finally {
    controller.abort();
    await stop(flaky);
  }
});
