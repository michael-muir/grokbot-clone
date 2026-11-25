// Tests for provider settings: keys in the keychain (never leaked), key routes, the connection test, per-bot base
// URL, and switching a bot's provider.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { SessionStore } from "../src/agent/sessions.ts";
import { BotRegistry } from "../src/bots.ts";
import { LocalFolderComputers } from "../src/computer.ts";
import { Gateway } from "../src/gateway.ts";
import { createHttpServer } from "../src/http.ts";
import { Credentials, KeychainKeyStore, MemoryKeyStore, needsKey } from "../src/keys.ts";
import { ClaudeProvider } from "../src/providers/claude.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { ProviderRegistry } from "../src/providers/index.ts";
import { OPENAI_PRESETS, openAICompatibleProvider } from "../src/providers/openai-compatible.ts";
import { TranscriptStore } from "../src/transcript.ts";
import type { AgentProvider, ProviderId, TranscriptEntry } from "../src/types.ts";
import { MockOpenAI, textReply } from "./support/mock-openai.ts";

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "grokbot-settings-"));
  dirs.push(d);
  return d;
};

const mock = new MockOpenAI((r) =>
  r.path.endsWith("/models")
    ? { status: 200, json: { data: [{ id: "gpt-test" }, { id: "gpt-other" }] } }
    : { sse: textReply("Hello from the new provider.") },
);
let mockUrl = "";
before(async () => {
  mockUrl = await mock.start();
});
after(async () => {
  await mock.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const preset = (id: ProviderId) => {
  const p = OPENAI_PRESETS.find((x) => x.id === id);
  assert.ok(p);
  return p;
};

async function setup(credentials: Credentials) {
  const dataDir = tempDir();
  const sessions = new SessionStore(dataDir);
  const providers: ProviderRegistry = new Map<ProviderId, AgentProvider>([
    ["fake", new FakeProvider(1)],
    ["openai", openAICompatibleProvider(preset("openai"), sessions, {}, credentials)],
    ["ollama", openAICompatibleProvider(preset("ollama"), sessions, {}, credentials)],
  ]);
  const bots = new BotRegistry(dataDir, [
    { id: "nova", name: "Nova", provider: "fake", avatar: { shape: "star", color: "violet" } },
  ]);
  const store = new TranscriptStore(dataDir);
  const gateway = new Gateway(bots, store, providers, new LocalFolderComputers(dataDir));
  const server = createHttpServer({ gateway, bots, store, providers, credentials });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const responses: string[] = [];
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    responses.push(text);
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : undefined, text };
  };
  const waitForRun = async () => {
    for (let i = 0; i < 300; i++) {
      const run = store
        .list("nova")
        .filter((e) => e.body.kind === "run")
        .at(-1);
      if (run?.body.kind === "run" && run.body.state !== "running") return run.body.state;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("run didn't finish");
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return { dataDir, store, call, responses, waitForRun, close };
}

/** Every file under `dir`, recursively, as text. */
function allFiles(dir: string): { path: string; text: string }[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? allFiles(p) : [{ path: p, text: readFileSync(p, "utf8") }];
  });
}

/** Captures console output for the duration of `fn`. */
async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const saved = methods.map((m) => console[m]);
  for (const m of methods) {
    console[m] = (...args: unknown[]) => {
      lines.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(" "));
    };
  }
  try {
    await fn();
  } finally {
    methods.forEach((m, i) => {
      console[m] = saved[i] ?? console[m];
    });
  }
  return lines;
}

test("a saved key is used, and never appears in responses, logs or files on disk", async () => {
  const canary = `sk-canary-${randomUUID()}`;
  const t = await setup(new Credentials(new MemoryKeyStore(), {}));
  try {
    const logs = await captureLogs(async () => {
      assert.equal((await t.call("PUT", "/providers/openai/key", { key: canary })).status, 204);
      const list = await t.call("GET", "/providers");
      const openai = (list.json as unknown as { id: string; keySource: string; configured: boolean }[]).find(
        (p) => p.id === "openai",
      );
      assert.deepEqual([openai?.keySource, openai?.configured], ["keychain", true]);

      const test1 = await t.call("POST", "/providers/openai/test", { baseUrl: `${mockUrl}/v1` });
      assert.deepEqual(test1.json, { ok: true, models: ["gpt-other", "gpt-test"] });

      const patched = await t.call("PATCH", "/bots/nova", {
        provider: "openai",
        model: "gpt-test",
        baseUrl: `${mockUrl}/v1`,
      });
      assert.equal(patched.status, 200);
      assert.equal((await t.call("POST", "/bots/nova/messages", { text: "hello" })).status, 202);
      assert.equal(await t.waitForRun(), "finished");
      await t.call("GET", "/bots");
      await t.call("GET", "/bots/nova/transcript");

      // A failing request must not echo the key either.
      mock.setScript(() => ({ status: 401, json: { error: { message: "Incorrect API key provided." } } }));
      const failed = await t.call("POST", "/providers/openai/test", { baseUrl: `${mockUrl}/v1` });
      assert.equal(failed.json?.ok, false);
      mock.setScript((r) =>
        r.path.endsWith("/models") ? { status: 200, json: { data: [{ id: "gpt-test" }] } } : { sse: textReply("Hi.") },
      );
    });

    // The key reached the model server, so it really was used.
    assert.ok(mock.requests.some((r) => r.headers.authorization === `Bearer ${canary}`));
    for (const text of t.responses) assert.ok(!text.includes(canary), `response leaked the key: ${text}`);
    for (const line of logs) assert.ok(!line.includes(canary), `log leaked the key: ${line}`);
    for (const file of allFiles(t.dataDir)) assert.ok(!file.text.includes(canary), `${file.path} contains the key`);
  } finally {
    await t.close();
  }
});

test("switching provider applies to the next message and posts a notice", async () => {
  const t = await setup(new Credentials(new MemoryKeyStore(), { OPENAI_API_KEY: "sk-env" }));
  try {
    await t.call("PATCH", "/bots/nova", { provider: "openai", model: "gpt-other", baseUrl: `${mockUrl}/v1` });
    const notice = t.store.list("nova").find((e) => e.body.kind === "notice");
    assert.deepEqual(notice?.body, {
      kind: "notice",
      text: "Switched to OpenAI (gpt-other). The conversation starts fresh for the new model.",
    });
    const before = mock.requests.length;
    await t.call("POST", "/bots/nova/messages", { text: "who are you?" });
    assert.equal(await t.waitForRun(), "finished");
    const sent = mock.requests.slice(before).find((r) => r.path.endsWith("/chat/completions"));
    assert.equal(sent?.body?.model, "gpt-other");
    const run = t.store
      .list("nova")
      .filter((e: TranscriptEntry) => e.body.kind === "run")
      .at(-1);
    assert.equal(run?.body.kind === "run" && run.body.provider, "openai");

    // A change that keeps the provider posts no new notice.
    await t.call("PATCH", "/bots/nova", { model: "gpt-test" });
    assert.equal(t.store.list("nova").filter((e) => e.body.kind === "notice").length, 1);
  } finally {
    await t.close();
  }
});

test("key routes validate input, and deleting a saved key falls back to the environment", async () => {
  const t = await setup(new Credentials(new MemoryKeyStore(), { OPENAI_API_KEY: "sk-env" }));
  try {
    assert.equal((await t.call("PUT", "/providers/ollama/key", { key: "x" })).status, 400, "ollama takes no key");
    assert.equal((await t.call("PUT", "/providers/openai/key", { key: "  " })).status, 400);
    assert.equal((await t.call("PUT", "/providers/openai/key", { key: "sk-saved" })).status, 204);
    const source = async () =>
      ((await t.call("GET", "/providers")).json as unknown as { id: string; keySource: string | null }[]).find(
        (p) => p.id === "openai",
      )?.keySource;
    assert.equal(await source(), "keychain");
    assert.equal((await t.call("DELETE", "/providers/openai/key")).status, 204);
    assert.equal(await source(), "env");
    assert.equal((await t.call("PATCH", "/bots/nova", { baseUrl: "file:///etc/passwd" })).status, 400);
    assert.equal((await t.call("POST", "/providers/openai/test", { baseUrl: "ftp://x" })).status, 400);
  } finally {
    await t.close();
  }
});

test("credentials: keychain first, then env; only providers that use keys", () => {
  const store = new MemoryKeyStore();
  const creds = new Credentials(store, { GOOGLE_API_KEY: "g-env" });
  assert.equal(creds.key("gemini"), "g-env");
  assert.equal(creds.source("gemini"), "env");
  store.set("gemini", "g-saved");
  assert.equal(creds.key("gemini"), "g-saved");
  assert.equal(creds.source("gemini"), "keychain");
  assert.equal(creds.key("ollama"), undefined);
  assert.equal(needsKey("ollama"), false);
  assert.equal(needsKey("claude"), true);
});

test("Claude gets the saved key through the SDK's environment, read at run time", async () => {
  let key: string | undefined = "sk-ant-first";
  let seen: string | undefined;
  const provider = new ClaudeProvider(
    async function* ({ options }: { prompt: string; options: Options }) {
      seen = options.env?.ANTHROPIC_API_KEY;
      yield { type: "result", subtype: "success", total_cost_usd: 0 } as never;
    },
    () => key,
  );
  const req = {
    botId: "b",
    botName: "B",
    prompt: "hi",
    workspaceDir: tempDir(),
    instructions: "",
    signal: new AbortController().signal,
  };
  const cb = { emit: () => {}, requestApproval: async () => ({ allow: true as const }) };
  await provider.run(req, cb);
  assert.equal(seen, "sk-ant-first");
  key = "sk-ant-second";
  await provider.run(req, cb);
  assert.equal(seen, "sk-ant-second", "a key changed in Settings is used by the next run");
  assert.equal(provider.info().configured, true);
});

test("the OS keychain store saves, reads and deletes a key", (t) => {
  const store = new KeychainKeyStore(`grokbot-clone-test-${randomUUID()}`);
  try {
    store.set("openai", "sk-keychain-test");
  } catch {
    t.skip("no OS keychain on this machine");
    return;
  }
  try {
    assert.equal(store.get("openai"), "sk-keychain-test");
  } finally {
    store.delete("openai");
  }
  assert.equal(store.get("openai"), undefined);
});
