// Secret request cards (#20): the value goes to the keychain and the bot's commands, and nowhere else: not the
// transcript, not the bots file, not the model's history, not the log.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { LoopProvider } from "../src/agent/loop.ts";
import { SessionStore } from "../src/agent/sessions.ts";
import { defaultShell } from "../src/agent/shell.ts";
import { BotRegistry } from "../src/bots.ts";
import { CardRequestError, parseCardRequest } from "../src/cards.ts";
import { LocalFolderComputers } from "../src/computer.ts";
import { Gateway } from "../src/gateway.ts";
import { createHttpServer } from "../src/http.ts";
import { Credentials, MemoryKeyStore } from "../src/keys.ts";
import { ClaudeProvider, type QueryFn } from "../src/providers/claude.ts";
import { appTools, REQUEST_SECRET_TOOL, RUN_COMMAND_TOOL, runCommand } from "../src/providers/claude-cards.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { ProviderRegistry } from "../src/providers/index.ts";
import { BotSecrets, MemorySecretStore, redact, secretNameProblem } from "../src/secrets.ts";
import { TranscriptStore } from "../src/transcript.ts";
import type { ProviderId, RunCallbacks } from "../src/types.ts";
import { calls, ScriptedModel, says } from "./support/scripted-model.ts";

const VALUE = "hunter2-very-secret-9431";
const echo = (name: string) => (defaultShell().name === "PowerShell" ? `Write-Output $env:${name}` : `echo "$${name}"`);

/** Every file under `dir`, read as text. */
function allText(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...allText(path));
    else out.push({ path, text: readFileSync(path, "utf8") });
  }
  return out;
}

/** Captures console output while `fn` runs. */
async function capturingLog<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const keep = (...args: unknown[]) =>
    lines.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(" "));
  console.log = keep;
  console.warn = keep;
  console.error = keep;
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "smarty-secrets-"));
  const bots = new BotRegistry(dir, [
    { id: "nova", name: "Nova", provider: "fake", avatar: { shape: "star", color: "purple" } },
    { id: "pip", name: "Pip", provider: "fake", avatar: { shape: "circle", color: "amber" } },
  ]);
  const store = new TranscriptStore(dir);
  const providers: ProviderRegistry = new Map<ProviderId, FakeProvider>([["fake", new FakeProvider(1)]]);
  const keychain = new MemorySecretStore();
  const gateway = new Gateway(bots, store, providers, new LocalFolderComputers(dir), new BotSecrets(keychain));
  return {
    dir,
    bots,
    store,
    gateway,
    providers,
    keychain,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function until<T>(get: () => T | undefined, ms = 5000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const pending = (store: TranscriptStore, botId: string, kind: "card" | "approval") =>
  store.list(botId).find((e) => e.body.kind === kind && e.body.state === "pending");

// ---------- rules

test("secret rules: names are upper-case variables, and reserved ones are refused", () => {
  assert.equal(secretNameProblem("GITHUB_TOKEN"), undefined);
  for (const bad of ["github_token", "1TOKEN", "A", "TOKEN-1", "X".repeat(65), 5])
    assert.ok(secretNameProblem(bad), String(bad));
  for (const reserved of ["PATH", "HOME", "GATEWAY_TOKEN", "CLAUDE_CODE_X"])
    assert.match(secretNameProblem(reserved) ?? "", /reserved/);
  assert.deepEqual(parseCardRequest({ kind: "secret", name: "API_KEY", label: "API key", reason: null }, ["secret"]), {
    kind: "secret",
    name: "API_KEY",
    label: "API key",
  });
  assert.throws(
    () => parseCardRequest({ kind: "secret", name: "API_KEY", label: "x" }, ["widget"]),
    /can't ask for secrets/,
  );
  assert.throws(() => parseCardRequest({ kind: "secret", name: "path", label: "x" }, ["secret"]), CardRequestError);
});

test("redact: every occurrence, longest first, and short values left alone", () => {
  assert.equal(redact("a=abcd1234 b=abcd1234", { A: "abcd1234" }), "a=[secret A] b=[secret A]");
  assert.equal(redact("x=abcd1234xyz", { SHORT: "abcd1234", LONG: "abcd1234xyz" }), "x=[secret LONG]");
  assert.equal(redact("pin 123", { PIN: "123" }), "pin 123");
});

// ---------- end to end

test("secrets: the value reaches the bot's command, and the transcript, files, model history and log see only its name", async () => {
  const t = setup();
  try {
    const { lines } = await capturingLog(async () => {
      const ask = await t.gateway.sendMessage("nova", "/secret", undefined, undefined, ["secret"]);
      const card = await until(() => pending(t.store, "nova", "card"));
      assert.deepEqual(t.gateway.answerCard("nova", card.id, { kind: "secret", value: VALUE }), { result: "ok" });
      await ask.done;
      const after = t.store.get("nova", card.id);
      assert.deepEqual(after?.body.kind === "card" && after.body.answer, { kind: "secret", saved: true });
      assert.deepEqual(t.bots.get("nova")?.secretNames, ["DEMO_TOKEN"]);
      assert.equal(t.keychain.values.get("nova/DEMO_TOKEN"), VALUE);

      const run = await t.gateway.sendMessage("nova", "/secret-echo", undefined, undefined, ["secret"]);
      const approval = await until(() => pending(t.store, "nova", "approval"));
      t.gateway.answerApproval("nova", approval.id, { allow: true });
      await run.done;
    });
    const reply = t.store.list("nova").findLast((e) => e.body.kind === "assistant_text");
    assert.equal(
      reply?.body.kind === "assistant_text" && reply.body.text,
      "The command printed: [secret DEMO_TOKEN]",
      "the command had the value, and the reply only its name",
    );
    for (const file of allText(t.dir)) assert.ok(!file.text.includes(VALUE), `${file.path} holds the value`);
    for (const line of lines) assert.ok(!line.includes(VALUE), `the log holds the value: ${line}`);
  } finally {
    t.cleanup();
  }
});

test("secrets: a declined, empty or refused secret leaves nothing behind, and the card can be tried again", async () => {
  const t = setup();
  try {
    t.keychain.unavailable = true;
    const first = await t.gateway.sendMessage("nova", "/secret", undefined, undefined, ["secret"]);
    const card = await until(() => pending(t.store, "nova", "card"));
    assert.equal(t.gateway.answerCard("nova", card.id, { kind: "secret", value: "" }).result, "invalid");
    assert.equal(
      t.gateway.answerCard("nova", card.id, { kind: "secret", value: "x".repeat(10_001) }).result,
      "invalid",
    );
    assert.equal(t.gateway.answerCard("nova", card.id, { kind: "widget", value: "x" }).result, "invalid");
    const locked = t.gateway.answerCard("nova", card.id, { kind: "secret", value: VALUE });
    assert.equal(locked.result, "unavailable");
    assert.ok(locked.result === "unavailable" && !locked.error.includes(VALUE), "the error never holds the value");
    assert.equal(t.bots.get("nova")?.secretNames, undefined);
    assert.equal(pending(t.store, "nova", "card")?.id, card.id, "still waiting");

    assert.deepEqual(t.gateway.answerCard("nova", card.id, { kind: "secret", declined: true }), { result: "ok" });
    await first.done;
    const after = t.store.get("nova", card.id);
    assert.deepEqual(after?.body.kind === "card" && after.body.answer, { kind: "secret", saved: false });
    assert.equal(t.keychain.values.size, 0);
  } finally {
    t.cleanup();
  }
});

test("secrets: deleting a bot deletes its secrets, and other bots' stay", async () => {
  const t = setup();
  try {
    const secrets = new BotSecrets(t.keychain);
    secrets.set("pip", "A_TOKEN", "pip-value-1");
    secrets.set("nova", "A_TOKEN", "nova-value-1");
    t.bots.update("pip", { secretNames: ["A_TOKEN"] });
    t.bots.update("nova", { secretNames: ["A_TOKEN"] });
    await t.gateway.deleteBot("pip");
    assert.deepEqual([...t.keychain.values.keys()], ["nova/A_TOKEN"]);
  } finally {
    t.cleanup();
  }
});

test("http: a keychain that can't save answers 503, and bots never show their secret names", async () => {
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
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    t.bots.update("nova", { secretNames: ["X_TOKEN"] });
    const bots = (await (await call("GET", "/bots")).json()) as Record<string, unknown>[];
    assert.ok(bots.every((b) => !("secretNames" in b)));
    t.keychain.unavailable = true;
    assert.equal((await call("POST", "/bots/nova/messages", { text: "/secret", cardKinds: ["secret"] })).status, 202);
    const card = await until(() => pending(t.store, "nova", "card"));
    const res = await call("POST", `/bots/nova/cards/${card.id}`, { answer: { kind: "secret", value: VALUE } });
    assert.equal(res.status, 503);
    assert.ok(!(await res.text()).includes(VALUE));
    t.gateway.interrupt("nova");
    await until(() => (t.gateway.isRunning("nova") ? undefined : true));
  } finally {
    server.closeAllConnections();
    server.close();
    t.cleanup();
  }
});

// ---------- the loop

test("loop: request_secret is offered with secret cards, and a command's output holding the value is redacted for the model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "smarty-loopsecret-"));
  try {
    const model = new ScriptedModel([
      calls([{ id: "c1", name: "shell", input: { command: echo("MY_TOKEN") } }]),
      says("Done."),
    ]);
    const sessions = new SessionStore(dir);
    const provider = new LoopProvider({ id: "fake", adapter: model, sessions });
    const cb: RunCallbacks = { emit: () => {}, requestApproval: async () => ({ allow: true }) };
    const outcome = await provider.run(
      {
        botId: "b",
        botName: "B",
        prompt: "use it",
        workspaceDir: dir,
        instructions: "",
        signal: new AbortController().signal,
        cardKinds: ["secret"],
        secrets: () => ({ MY_TOKEN: VALUE }),
      },
      cb,
    );
    assert.equal(outcome.status, "finished");
    assert.ok(model.requests[0]?.tools.some((t) => t.name === "request_secret"));
    const result = model.requests[1]?.messages.find((m) => m.role === "tool");
    assert.match(result?.role === "tool" ? result.output : "", /\[secret MY_TOKEN\]/, "the command had the value");
    assert.ok(!JSON.stringify(model.requests).includes(VALUE), "no model request holds the value");
    for (const file of allText(dir)) assert.ok(!file.text.includes(VALUE), `${file.path} holds the value`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- Claude

test("claude: request_secret and run_command come with secret cards; run_command needs approval and redacts", async () => {
  const signal = new AbortController().signal;
  const ask = async () => ({ kind: "secret" as const, saved: true });
  const none = () => ({});
  assert.equal(appTools({ kinds: [], ask, signal, workspaceDir: ".", secrets: none }), undefined);
  const withCards = appTools({ kinds: ["widget", "secret"], ask, signal, workspaceDir: ".", secrets: none });
  assert.deepEqual(
    withCards?.allowed,
    ["mcp__smarty__show_card", REQUEST_SECRET_TOOL],
    "run_command isn't pre-approved",
  );
  const secretsOnly = appTools({ kinds: [], ask, signal, workspaceDir: ".", secrets: () => ({ A: "abcd1234" }) });
  assert.ok(secretsOnly, "a bot with secrets gets run_command even from an app without secret cards");
  assert.deepEqual(secretsOnly.allowed, []);

  const dir = mkdtempSync(join(tmpdir(), "smarty-claudesecret-"));
  try {
    const out = await runCommand(dir, () => ({ MY_TOKEN: VALUE }), signal)({ command: echo("MY_TOKEN") });
    assert.match(out.content[0]?.text ?? "", /\[secret MY_TOKEN\]/);
    assert.ok(!(out.content[0]?.text ?? "").includes(VALUE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Claude Code itself never gets the values: its environment is the gateway's, minus secrets.
  const seen: Options[] = [];
  const query: QueryFn = async function* ({ options }) {
    seen.push(options);
    yield { type: "system", subtype: "init", session_id: "s" } as never;
    yield { type: "result", subtype: "success", total_cost_usd: 0 } as never;
  };
  await new ClaudeProvider(query, () => "test-key").run(
    {
      botId: "b",
      botName: "B",
      prompt: "hi",
      workspaceDir: ".",
      instructions: "",
      signal,
      secrets: () => ({ MY_TOKEN: VALUE }),
    },
    { emit: () => {}, requestApproval: async () => ({ allow: true }) },
  );
  assert.ok(seen[0]?.mcpServers?.smarty);
  assert.ok(!JSON.stringify(seen[0]?.env ?? {}).includes(VALUE), "Claude Code's environment has no secret");
  assert.ok(!seen[0]?.allowedTools?.includes(RUN_COMMAND_TOOL));
});
