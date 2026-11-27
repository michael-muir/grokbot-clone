// Bot management: pin, hide and delete, in the gateway and over HTTP.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BotRegistry } from "../src/bots.ts";
import { LocalFolderComputers } from "../src/computer.ts";
import { BotBusyError, BotRuleError, Gateway } from "../src/gateway.ts";
import { createHttpServer } from "../src/http.ts";
import { Credentials, MemoryKeyStore } from "../src/keys.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { ProviderRegistry } from "../src/providers/index.ts";
import { TranscriptStore } from "../src/transcript.ts";
import type { ProviderId } from "../src/types.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "smarty-bots-"));
  const bots = new BotRegistry(dir, [
    { id: "main", name: "Main", provider: "fake", avatar: { shape: "circle", color: "white" } },
    { id: "nova", name: "Nova", provider: "fake", avatar: { shape: "star", color: "purple" } },
  ]);
  const store = new TranscriptStore(dir);
  const providers: ProviderRegistry = new Map<ProviderId, FakeProvider>([["fake", new FakeProvider(1)]]);
  const computers = new LocalFolderComputers(dir);
  const gateway = new Gateway(bots, store, providers, computers);
  return { dir, bots, store, gateway, computers, providers };
}

test("bots: pinned and hidden are saved and survive a restart; the main bot can't be hidden", () => {
  const t = setup();
  try {
    assert.equal(t.gateway.updateBot("nova", { pinned: true }).pinned, true);
    assert.equal(t.gateway.updateBot("nova", { hidden: true }).hidden, true);
    const again = new BotRegistry(t.dir).get("nova");
    assert.equal(again?.pinned, true);
    assert.equal(again?.hidden, true);
    assert.throws(() => t.gateway.updateBot("main", { hidden: true }), BotRuleError);
    assert.equal(t.gateway.updateBot("main", { pinned: false }).pinned, false, "other changes to it are fine");
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("bots: deleting removes the bot, its transcript and its computer, and leaves the others", async () => {
  const t = setup();
  try {
    const { done } = await t.gateway.sendMessage("nova", "hello");
    await done;
    const { workspaceDir } = await t.computers.ensure("nova");
    writeFileSync(join(workspaceDir, "notes.txt"), "mine");
    await (await t.gateway.sendMessage("main", "hi")).done;

    await t.gateway.deleteBot("nova");
    assert.equal(t.bots.get("nova"), undefined);
    assert.equal(new BotRegistry(t.dir).get("nova"), undefined, "gone after a restart too");
    // Checked first: reading a bot's transcript (below) sets its folder up again.
    assert.equal(existsSync(join(t.dir, "bots", "nova")), false, "the bot's folder is gone");
    assert.deepEqual(t.store.list("nova"), []);
    assert.deepEqual(new TranscriptStore(t.dir).list("nova"), [], "the transcript file is deleted");
    assert.ok(t.store.list("main").length > 0, "other bots are untouched");
    assert.deepEqual(
      t.gateway.activity().map((a) => a.botId),
      ["main"],
    );
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("bots: the main bot and a running bot can't be deleted", async () => {
  const t = setup();
  try {
    await assert.rejects(t.gateway.deleteBot("main"), BotRuleError);
    const { done } = await t.gateway.sendMessage("nova", "/slow");
    await assert.rejects(t.gateway.deleteBot("nova"), BotBusyError);
    t.gateway.interrupt("nova");
    await done;
    await t.gateway.deleteBot("nova");
    assert.equal(t.bots.get("nova"), undefined);
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
});

test("HTTP: PATCH pinned/hidden, DELETE a bot, and the refusals", async () => {
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
  const json = { "content-type": "application/json" };
  try {
    const patched = await fetch(`${base}/bots/nova`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ pinned: true, hidden: true }),
    });
    assert.equal(patched.status, 200);
    const bot = await patched.json();
    assert.equal(bot.pinned, true);
    assert.equal(bot.hidden, true);

    const bad = await fetch(`${base}/bots/nova`, { method: "PATCH", headers: json, body: '{"pinned":"yes"}' });
    assert.equal(bad.status, 400);
    const hideMain = await fetch(`${base}/bots/main`, { method: "PATCH", headers: json, body: '{"hidden":true}' });
    assert.equal(hideMain.status, 409);

    const delMain = await fetch(`${base}/bots/main`, { method: "DELETE" });
    assert.equal(delMain.status, 409);
    assert.match((await delMain.json()).error, /main bot/);

    const del = await fetch(`${base}/bots/nova`, { method: "DELETE" });
    assert.equal(del.status, 204);
    const again = await fetch(`${base}/bots/nova`, { method: "DELETE" });
    assert.equal(again.status, 404);
    const list = await (await fetch(`${base}/bots`)).json();
    assert.deepEqual(
      list.map((b: { id: string }) => b.id),
      ["main"],
    );
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(t.dir, { recursive: true, force: true });
  }
});
