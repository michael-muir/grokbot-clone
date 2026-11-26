// Bot activity: the gateway's snapshot stream of which bots are running, and the client that follows it.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BotRegistry } from "../src/bots.ts";
import { GatewayClient } from "../src/client/gateway-client.ts";
import { subscribeActivity } from "../src/client/subscribe.ts";
import { LocalFolderComputers } from "../src/computer.ts";
import { Gateway } from "../src/gateway.ts";
import { createHttpServer } from "../src/http.ts";
import { Credentials, MemoryKeyStore } from "../src/keys.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { ProviderRegistry } from "../src/providers/index.ts";
import { TranscriptStore } from "../src/transcript.ts";
import type { BotActivity, ProviderId } from "../src/types.ts";

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-activity-"));
  const bots = new BotRegistry(dir, [
    { id: "nova", name: "Nova", provider: "fake", avatar: { shape: "circle", color: "amber" } },
    { id: "rex", name: "Rex", provider: "fake", avatar: { shape: "circle", color: "blue" } },
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
    heartbeatMs: 50,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    gateway,
    server,
    url,
    cleanup() {
      server.closeAllConnections();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const running = (bots: BotActivity[]) =>
  bots
    .filter((b) => b.running)
    .map((b) => b.botId)
    .join(",");

async function until(check: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("GET /activity sends a snapshot, then one when a run starts and one when it ends", async () => {
  const t = await setup();
  const abort = new AbortController();
  try {
    const seen: string[] = [];
    const client = new GatewayClient({ baseUrl: t.url, token: "secret" });
    const following = client.activity({ signal: abort.signal, onActivity: (bots) => seen.push(running(bots)) });
    await until(() => seen.length === 1);
    assert.deepEqual(seen, [""], "the first snapshot: nothing running, every bot listed");

    const { done } = await t.gateway.sendMessage("rex", "hello");
    await done;
    await until(() => seen.length === 3);
    assert.deepEqual(seen, ["", "rex", ""]);
    abort.abort();
    await following;
  } finally {
    abort.abort();
    t.cleanup();
  }
});

test("subscribeActivity reconnects after the connection drops and gets a fresh snapshot", async () => {
  const t = await setup();
  const abort = new AbortController();
  try {
    const states: string[] = [];
    let snapshots = 0;
    const client = new GatewayClient({ baseUrl: t.url, token: "secret" });
    const following = client.activity({
      signal: abort.signal,
      backoff: { initialMs: 10, maxMs: 20 },
      onState: (s) => states.push(s),
      onError: () => {},
      onActivity: () => snapshots++,
    });
    await until(() => snapshots === 1);
    t.server.closeAllConnections(); // the gateway drops every stream
    await until(() => snapshots === 2);
    assert.ok(states.includes("reconnecting"));
    assert.equal(states.at(-1), "live");
    abort.abort();
    await following;
  } finally {
    abort.abort();
    t.cleanup();
  }
});

test("GET /activity needs the token", async () => {
  const t = await setup();
  try {
    assert.equal((await fetch(`${t.url}/activity`)).status, 401);
  } finally {
    t.cleanup();
  }
});

test("subscribeActivity drops malformed items and reports them, keeping the good ones", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: [{"botId":"nova","running":true},null,{"id":"x"}]\n\n'));
      c.close();
    },
  });
  const fakeFetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
  const abort = new AbortController();
  const got: BotActivity[][] = [];
  const errors: string[] = [];
  const following = subscribeActivity("http://gateway", {
    signal: abort.signal,
    fetch: fakeFetch,
    onError: (e) => errors.push(e instanceof Error ? e.message : String(e)),
    onActivity: (bots) => {
      got.push(bots);
      abort.abort();
    },
  });
  await following;
  assert.deepEqual(got, [[{ botId: "nova", running: true }]]);
  assert.ok(errors.some((e) => e.includes("2 malformed")));
});
