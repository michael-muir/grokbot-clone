// Creating bots, avatars and the main bot, in the gateway and over HTTP.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BotRegistry } from "../src/bots.ts";
import { LocalFolderComputers } from "../src/computer.ts";
import { BotRuleError, Gateway, uniqueId } from "../src/gateway.ts";
import { createHttpServer } from "../src/http.ts";
import { Credentials, MemoryKeyStore } from "../src/keys.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { ProviderRegistry } from "../src/providers/index.ts";
import { TranscriptStore } from "../src/transcript.ts";
import type { ProviderId } from "../src/types.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "smarty-create-"));
  const bots = new BotRegistry(dir, [
    {
      id: "main",
      name: "Main",
      provider: "fake",
      model: "fake-1",
      baseUrl: "http://127.0.0.1:9",
      avatar: { shape: "circle", color: "white" },
    },
  ]);
  const store = new TranscriptStore(dir);
  const providers: ProviderRegistry = new Map<ProviderId, FakeProvider>([["fake", new FakeProvider(1)]]);
  const gateway = new Gateway(bots, store, providers, new LocalFolderComputers(dir));
  return { dir, bots, store, gateway, providers };
}

test("bots: ids come from names, path-safe and unique", () => {
  const none = new Set<string>();
  assert.equal(uniqueId("Nova", none), "nova");
  assert.equal(uniqueId("  Nova  Two! ", none), "nova-two");
  assert.equal(uniqueId("Café Bot", none), "cafe-bot");
  assert.equal(uniqueId("🤖", none), "bot");
  assert.equal(uniqueId("../..", none), "bot");
  assert.equal(uniqueId("Nova", new Set(["nova", "nova-2"])), "nova-3");
  assert.equal(uniqueId("x".repeat(100), none).length, 30);
  for (const id of ["nova", "nova-two", "cafe-bot", "bot", "nova-3"]) assert.match(id, /^[a-z0-9-]+$/);
  // Windows reserves these as device names, so they can't be folders.
  assert.equal(uniqueId("Con", none), "con-2");
  assert.equal(uniqueId("NUL", none), "nul-2");
  assert.equal(uniqueId("com1", none), "com1-2");
  assert.equal(uniqueId("Connie", none), "connie");
});

test("bots: creating a bot gives it a unique id from its name and the main bot's model", async () => {
  const t = setup();
  try {
    const nova = t.gateway.createBot({ name: " Nova " });
    assert.deepEqual(nova, {
      id: "nova",
      name: "Nova",
      provider: "fake",
      model: "fake-1",
      baseUrl: "http://127.0.0.1:9",
      // The first color no bot uses yet.
      avatar: { shape: "circle", color: "brown" },
    });
    const again = t.gateway.createBot({ name: "Nova", avatar: { shape: "star", color: "purple" } });
    assert.equal(again.id, "nova-2");
    assert.deepEqual(again.avatar, { shape: "star", color: "purple" });
    assert.deepEqual(
      new BotRegistry(t.dir).list().map((b) => b.id),
      ["main", "nova", "nova-2"],
      "saved, in order",
    );
    // It's a working bot with its own conversation.
    await (await t.gateway.sendMessage("nova", "hello")).done;
    assert.ok(t.store.list("nova").some((e) => e.body.kind === "assistant_text"));
    assert.equal(t.store.list("main").length, 0);

    assert.throws(() => t.gateway.createBot({ name: "   " }), BotRuleError);
    assert.throws(() => t.gateway.createBot({ name: "x".repeat(41) }), BotRuleError);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("bots: making a bot main moves it first, shows it, and survives a restart", () => {
  const t = setup();
  try {
    t.gateway.createBot({ name: "Nova" });
    t.gateway.createBot({ name: "Orbit" });
    t.gateway.updateBot("orbit", { hidden: true, pinned: true });
    const orbit = t.gateway.updateBot("orbit", { main: true });
    assert.equal(orbit.hidden, false, "the main bot is always shown");
    assert.deepEqual(
      t.bots.list().map((b) => b.id),
      ["orbit", "main", "nova"],
    );
    assert.equal(t.bots.mainId(), "orbit");
    assert.deepEqual(
      new BotRegistry(t.dir).list().map((b) => b.id),
      ["orbit", "main", "nova"],
    );
    assert.throws(() => t.gateway.updateBot("nova", { main: true, hidden: true }), BotRuleError);
    // The old main bot is an ordinary bot now.
    assert.equal(t.gateway.updateBot("main", { hidden: true }).hidden, true);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("HTTP: POST /bots creates a bot, and PATCH changes avatars and the main bot; bad input is refused", async () => {
  const t = setup();
  const server = createHttpServer({
    gateway: t.gateway,
    bots: t.bots,
    store: t.store,
    providers: t.providers,
    credentials: new Credentials(new MemoryKeyStore(), {}),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, method = "POST") =>
    fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const created = await post("/bots", { name: "Nova", avatar: { shape: "hexagon", color: "teal" } });
    assert.equal(created.status, 201);
    const nova = await created.json();
    assert.equal(nova.id, "nova");
    assert.deepEqual(nova.avatar, { shape: "hexagon", color: "teal" });
    assert.equal(nova.sessionId, undefined);

    for (const bad of [
      {},
      { name: 5 },
      { name: "" },
      { name: "x".repeat(41) },
      { name: "A", avatar: { shape: "blob", color: "teal" } },
      { name: "A", avatar: { shape: "circle", color: "chartreuse" } },
      { name: "A", avatar: "circle" },
    ]) {
      assert.equal((await post("/bots", bad)).status, 400, JSON.stringify(bad));
    }

    const restyled = await post("/bots/nova", { avatar: { shape: "drop", color: "pink" } }, "PATCH");
    assert.equal(restyled.status, 200);
    assert.deepEqual((await restyled.json()).avatar, { shape: "drop", color: "pink" });
    assert.equal((await post("/bots/nova", { avatar: { shape: "drop" } }, "PATCH")).status, 400);
    assert.equal((await post("/bots/nova", { name: "y".repeat(41) }, "PATCH")).status, 400);
    assert.equal((await post("/bots/nova", { main: false }, "PATCH")).status, 400);

    assert.equal((await post("/bots/nova", { main: true }, "PATCH")).status, 200);
    const list = await (await fetch(`${base}/bots`)).json();
    assert.deepEqual(
      list.map((b: { id: string }) => b.id),
      ["nova", "main"],
    );
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("bots: a refused change doesn't move the main bot, and a deleted bot's id isn't reused", async () => {
  const t = setup();
  try {
    t.gateway.createBot({ name: "Nova" });
    assert.throws(() => t.gateway.updateBot("nova", { main: true, provider: "claude" }));
    assert.equal(t.bots.mainId(), "main", "the refused change left the main bot alone");

    let notified = 0;
    const stop = t.gateway.subscribeActivity(() => notified++);
    t.gateway.updateBot("nova", { main: true });
    stop();
    assert.ok(notified > 0, "attached clients hear that the bots changed");

    t.gateway.updateBot("main", { main: true });
    await t.gateway.deleteBot("nova");
    assert.equal(t.gateway.createBot({ name: "Nova" }).id, "nova-2");
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});
