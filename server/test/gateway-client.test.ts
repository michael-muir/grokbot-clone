// Gateway client tests: every method against the real HTTP server on the fake provider, token auth, errors.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BotRegistry } from "../src/bots.ts";
import { GatewayClient, GatewayError } from "../src/client/gateway-client.ts";
import { LocalFolderComputers } from "../src/computer.ts";
import { Gateway } from "../src/gateway.ts";
import { createHttpServer } from "../src/http.ts";
import { Credentials, MemoryKeyStore } from "../src/keys.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { ProviderRegistry } from "../src/providers/index.ts";
import { TranscriptStore } from "../src/transcript.ts";
import type { ProviderId, TranscriptEntry } from "../src/types.ts";

async function withGateway(fn: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-client-"));
  const bots = new BotRegistry(dir, [
    { id: "nova", name: "Nova", provider: "fake", avatar: { shape: "star", color: "violet" } },
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
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitFor<T>(fn: () => T | undefined, ms = 2000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out");
}

test("client: bots, messages, a live subscription, approvals and the transcript", async () => {
  await withGateway(async (base) => {
    const client = new GatewayClient({ baseUrl: base, token: "secret" });
    assert.equal(await client.health(), true);
    const bots = await client.listBots();
    assert.equal(bots[0]?.name, "Nova");
    assert.equal("sessionId" in (bots[0] ?? {}), false);

    const seen: TranscriptEntry[] = [];
    const stop = new AbortController();
    const live = client.subscribe("nova", { signal: stop.signal, onEntry: (e) => seen.push(e) });

    await client.sendMessage("nova", "/tool");
    const card = await waitFor(() => seen.find((e) => e.body.kind === "approval" && e.body.state === "pending"));
    await client.answerApproval("nova", card.id, { allow: true });
    await waitFor(() => seen.find((e) => e.body.kind === "run" && e.body.state === "finished"));
    stop.abort();
    await live;

    const all = await client.transcript("nova");
    assert.ok(all.some((e) => e.id === card.id));
    const later = await client.transcript("nova", card.updatedSeq);
    assert.ok(later.every((e) => e.updatedSeq > card.updatedSeq));

    const renamed = await client.updateBot("nova", { name: "Nova 2" });
    assert.equal(renamed.name, "Nova 2");
  });
});

test("client: interrupt, providers, and errors carry the gateway's message and status", async () => {
  await withGateway(async (base) => {
    const client = new GatewayClient({ baseUrl: base, token: "secret" });
    await assert.rejects(client.interrupt("nova"), (err) => {
      assert.ok(err instanceof GatewayError);
      assert.equal(err.status, 409);
      assert.equal(err.message, "Nothing is running");
      return true;
    });
    await client.sendMessage("nova", "/slow");
    await client.interrupt("nova");

    const providers = await client.listProviders();
    assert.deepEqual(
      providers.map((p) => [p.id, p.needsKey, p.keySource]),
      [["fake", false, null]],
    );
    await assert.rejects(client.listModels("fake"), (err) => err instanceof GatewayError && err.status === 404);
    await assert.rejects(client.setKey("fake", "k"), (err) => err instanceof GatewayError && err.status === 400);
    await assert.rejects(client.transcript("nobody"), (err) => err instanceof GatewayError && err.status === 404);
  });
});

test("client: a wrong token is an error, an unreachable gateway is just not healthy yet", async () => {
  await withGateway(async (base) => {
    const wrong = new GatewayClient({ baseUrl: base, token: "nope" });
    await assert.rejects(wrong.health(), (err) => err instanceof GatewayError && err.status === 401);
    await assert.rejects(wrong.listBots(), (err) => err instanceof GatewayError && err.status === 401);
  });
  const nobody = new GatewayClient({ baseUrl: "http://127.0.0.1:9" });
  assert.equal(await nobody.health(), false);
});

test("client: a non-JSON error page becomes a plain status message", async () => {
  const client = new GatewayClient({
    baseUrl: "http://gateway.test",
    fetch: async () => new Response("<html>Bad Gateway</html>", { status: 502 }),
  });
  await assert.rejects(
    client.listBots(),
    (err) => err instanceof GatewayError && err.message === "The gateway answered 502",
  );
});
