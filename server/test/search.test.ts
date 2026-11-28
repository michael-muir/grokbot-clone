// Search (#23): each bot's latest message for the palette, and messages that contain a query.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BotRegistry } from "../src/bots.ts";
import { LocalFolderComputers } from "../src/computer.ts";
import { Gateway } from "../src/gateway.ts";
import { createHttpServer } from "../src/http.ts";
import { Credentials, MemoryKeyStore } from "../src/keys.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { ProviderRegistry } from "../src/providers/index.ts";
import { searchTranscripts } from "../src/search.ts";
import { TranscriptStore } from "../src/transcript.ts";
import type { EntryBody, ProviderId, TranscriptEntry } from "../src/types.ts";

let n = 0;
const entry = (botId: string, body: EntryBody, extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  seq: n,
  updatedSeq: n,
  id: `e${n}`,
  botId,
  body,
  createdAt: 1000 + n++,
  updatedAt: 0,
  ...extra,
});
const user = (botId: string, text: string, extra?: Partial<TranscriptEntry>) =>
  entry(botId, { kind: "user_message", text }, extra);
const bot = (botId: string, text: string, extra?: Partial<TranscriptEntry>) =>
  entry(botId, { kind: "assistant_text", text, streaming: false }, extra);

test("search: previews are each bot's latest visible message; messages match any case, skip hidden entries, newest first, with a snippet around the hit", () => {
  const long = `${"x".repeat(200)} the Invoice is ready ${"y".repeat(200)}`;
  const nova = [
    user("nova", "send the invoice"),
    bot("nova", long),
    bot("nova", "invoice draft", { hidden: true }),
    user("nova", "in a thread about invoices", { threadId: "e0" }),
    entry("nova", { kind: "run", provider: "fake", state: "finished" }),
  ];
  const pip = [user("pip", "hello"), bot("pip", "Hi\n  there!")];
  const r = searchTranscripts(
    ["nova", "pip"],
    new Map([
      ["nova", nova],
      ["pip", pip],
    ]),
    "  INVOICE ",
  );
  assert.deepEqual(r.previews, [
    { botId: "nova", text: `${long.slice(0, 119)}…` },
    { botId: "pip", text: "Hi there!" },
  ]);
  assert.deepEqual(
    r.messages.map((m) => [m.entryId, m.threadId]),
    [
      ["e3", "e0"],
      ["e1", undefined],
      ["e0", undefined],
    ],
  );
  const hit = r.messages[1]?.snippet ?? "";
  assert.ok(hit.includes("the Invoice is ready") && hit.startsWith("…") && hit.endsWith("…"), hit);
  assert.ok(hit.length <= 102, `${hit.length}`);
  assert.deepEqual(searchTranscripts(["nova"], new Map([["nova", nova]]), "i").messages, [], "too short to search");
  assert.equal(searchTranscripts(["nova"], new Map([["nova", nova]]), "invoice", 1).messages.length, 1);
});

test("http: /search answers previews and hits, and refuses an overlong query", async () => {
  const dir = mkdtempSync(join(tmpdir(), "smarty-search-"));
  const bots = new BotRegistry(dir, [
    { id: "nova", name: "Nova", provider: "fake", avatar: { shape: "star", color: "purple" } },
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
    token: "t",
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (q: string) =>
    fetch(`${base}/search?q=${encodeURIComponent(q)}`, { headers: { authorization: "Bearer t" } });
  try {
    await (await gateway.sendMessage("nova", "plan the garden")).done;
    const res = await get("GARDEN");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { previews: unknown[]; messages: { botId: string }[] };
    assert.equal(body.previews.length, 1);
    assert.equal(body.messages.length, 2, "the message and the bot's echo");
    assert.equal((await get("x".repeat(201))).status, 400);
    bots.update("nova", { hidden: true });
    const hidden = (await (await get("garden")).json()) as { previews: unknown[]; messages: unknown[] };
    assert.deepEqual([hidden.previews.length, hidden.messages.length], [0, 0], "hidden bots aren't searched");
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
