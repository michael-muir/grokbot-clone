// Usage (#21): tokens and cost per run from each provider, the run entry, the per-day and per-bot summary, and
// GET /usage.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { LoopProvider } from "../src/agent/loop.ts";
import type { ModelEvent } from "../src/agent/model.ts";
import { SessionStore } from "../src/agent/sessions.ts";
import { BotRegistry } from "../src/bots.ts";
import { LocalFolderComputers } from "../src/computer.ts";
import { costBase, Gateway } from "../src/gateway.ts";
import { createHttpServer } from "../src/http.ts";
import { Credentials, MemoryKeyStore } from "../src/keys.ts";
import { ClaudeProvider, type QueryFn } from "../src/providers/claude.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { ProviderRegistry } from "../src/providers/index.ts";
import { TranscriptStore } from "../src/transcript.ts";
import type { AgentProvider, ProviderEvent, ProviderId, RunRequest, TranscriptEntry } from "../src/types.ts";
import { localDate, summarizeUsage } from "../src/usage.ts";
import { ScriptedModel } from "./support/scripted-model.ts";

const usageOf = (events: ProviderEvent[]) => events.filter((e) => e.type === "usage");

// ---------- providers

test("usage: the loop reports each model turn's tokens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "smarty-usage-loop-"));
  try {
    const withUsage = (text: string, inputTokens: number, outputTokens: number) =>
      async function* (): AsyncGenerator<ModelEvent> {
        yield { type: "text_delta", text };
        yield { type: "done", usage: { inputTokens, outputTokens } };
      };
    const provider = new LoopProvider({
      id: "fake",
      adapter: new ScriptedModel([withUsage("Hi.", 120, 7)]),
      sessions: new SessionStore(dir),
    });
    const events: ProviderEvent[] = [];
    await provider.run(
      {
        botId: "b",
        botName: "B",
        prompt: "hi",
        workspaceDir: dir,
        instructions: "",
        signal: new AbortController().signal,
      },
      { emit: (e) => events.push(e), requestApproval: async () => ({ allow: true }) },
    );
    assert.deepEqual(usageOf(events), [{ type: "usage", inputTokens: 120, outputTokens: 7 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const sdk = (m: object) => m as SDKMessage;

function claudeRun(total: number) {
  const query: QueryFn = async function* () {
    yield sdk({ type: "system", subtype: "init", session_id: "s-1" });
    const usage = {
      input_tokens: 10,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 50,
      output_tokens: 30,
    };
    // One API call can arrive as several assistant messages with the same id and usage: counted once.
    for (const text of ["Hello", " there"]) {
      yield sdk({
        type: "assistant",
        parent_tool_use_id: null,
        uuid: `u-${text}`,
        message: { id: "msg-1", role: "assistant", usage, content: [{ type: "text", text }] },
      });
    }
    // A subagent's calls aren't the main loop's.
    yield sdk({
      type: "assistant",
      parent_tool_use_id: "t1",
      message: { id: "msg-sub", usage: { input_tokens: 999, output_tokens: 999 }, content: [] },
    });
    yield sdk({ type: "result", subtype: "success", total_cost_usd: total });
  };
  return new ClaudeProvider(query, () => "k");
}

async function events(provider: AgentProvider, extra: Partial<RunRequest>) {
  const out: ProviderEvent[] = [];
  const outcome = await provider.run(
    {
      botId: "b",
      botName: "B",
      prompt: "hi",
      workspaceDir: ".",
      instructions: "",
      signal: new AbortController().signal,
      ...extra,
    },
    { emit: (e) => out.push(e), requestApproval: async () => ({ allow: true }) },
  );
  return { outcome, usage: usageOf(out) };
}

test("claude: the result's usage and cost become usage events, with the run's share of a session's running cost", async () => {
  const fresh = await events(claudeRun(0.5), {});
  assert.deepEqual(fresh.usage, [
    { type: "usage", inputTokens: 1060, outputTokens: 30, costUsd: 0.5, sessionCostUsd: 0.5 },
  ]);
  assert.equal(fresh.outcome.costUsd, 0.5, "a new session's whole total is this run's");

  const resumed = await events(claudeRun(0.8), { sessionId: "s-1", costBase: 0.5 });
  const share = resumed.usage[0]?.type === "usage" ? resumed.usage[0].costUsd : undefined;
  assert.ok(share !== undefined && Math.abs(share - 0.3) < 1e-9, `share ${share}`);
  assert.ok(resumed.outcome.costUsd !== undefined && Math.abs(resumed.outcome.costUsd - 0.3) < 1e-9);

  const unknown = await events(claudeRun(0.8), { sessionId: "s-1" });
  assert.deepEqual(unknown.usage, [{ type: "usage", inputTokens: 1060, outputTokens: 30, sessionCostUsd: 0.8 }]);
  assert.equal(unknown.outcome.costUsd, undefined, "no base, no cost rather than a wrong one");
});

// ---------- gateway

function setup(providers: ProviderRegistry = new Map<ProviderId, AgentProvider>([["fake", new FakeProvider(1)]])) {
  const dir = mkdtempSync(join(tmpdir(), "smarty-usage-"));
  const bots = new BotRegistry(dir, [
    { id: "nova", name: "Nova", provider: "fake", avatar: { shape: "star", color: "purple" } },
    { id: "pip", name: "Pip", provider: "fake", avatar: { shape: "circle", color: "amber" } },
  ]);
  const store = new TranscriptStore(dir);
  const gateway = new Gateway(bots, store, providers, new LocalFolderComputers(dir));
  return { dir, bots, store, gateway, providers, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const runBody = (store: TranscriptStore, botId = "nova") => {
  const e = store.list(botId).findLast((x) => x.body.kind === "run");
  return e?.body.kind === "run" ? e.body : undefined;
};

test("usage: a run adds up its usage events, keeps the share of cost, and records them even when stopped", async () => {
  const seenBases: (number | undefined)[] = [];
  let stop = false;
  const scripted: AgentProvider = {
    id: "fake",
    async run(req, cb) {
      seenBases.push(req.costBase);
      cb.emit({ type: "session", sessionId: "s-1" });
      cb.emit({ type: "checkpoint", at: "1" });
      cb.emit({ type: "usage", inputTokens: 100, outputTokens: 10 });
      cb.emit({ type: "usage", inputTokens: 50, outputTokens: 5, costUsd: 0.02, sessionCostUsd: 0.07 });
      if (stop) {
        await new Promise((_, reject) => req.signal.addEventListener("abort", () => reject(new Error("stopped"))));
      }
      return { status: "finished", sessionId: "s-1", costUsd: 99 };
    },
  };
  const t = setup(new Map([["fake", scripted]]));
  try {
    await (await t.gateway.sendMessage("nova", "one")).done;
    assert.deepEqual(
      { usage: runBody(t.store)?.usage, cost: runBody(t.store)?.costUsd, session: runBody(t.store)?.sessionCostUsd },
      { usage: { inputTokens: 150, outputTokens: 15 }, cost: 0.02, session: 0.07 },
      "the events' cost wins over the outcome's",
    );
    await (await t.gateway.sendMessage("nova", "two")).done;
    assert.deepEqual(seenBases, [undefined, 0.07], "the next run on the session gets its running total");

    stop = true;
    const third = await t.gateway.sendMessage("nova", "three");
    await new Promise((r) => setTimeout(r, 20));
    t.gateway.interrupt("nova");
    await third.done;
    assert.equal(runBody(t.store)?.state, "interrupted");
    assert.deepEqual(
      runBody(t.store)?.usage,
      { inputTokens: 150, outputTokens: 15 },
      "a stopped run used what it used",
    );
  } finally {
    t.cleanup();
  }
});

test("usage: a run that reports nothing has no usage; a fork's base is the run at the fork point", async () => {
  const quiet: AgentProvider = { id: "fake", run: async () => ({ status: "finished" }) };
  const t = setup(new Map([["fake", quiet]]));
  try {
    await (await t.gateway.sendMessage("nova", "hi")).done;
    assert.equal(runBody(t.store)?.usage, undefined);
    assert.equal(runBody(t.store)?.costUsd, undefined);
  } finally {
    t.cleanup();
  }
  const run = (at: string, total: number): TranscriptEntry =>
    ({
      body: {
        kind: "run",
        provider: "claude",
        state: "finished",
        sessionCostUsd: total,
        checkpoint: { sessionId: "s", at },
      },
    }) as TranscriptEntry;
  const runs = [run("a", 0.1), run("b", 0.3)];
  assert.deepEqual(costBase(runs, "s"), { costBase: 0.3 }, "a plain resume: the last total");
  assert.deepEqual(costBase(runs, "s", "a"), { costBase: 0.1 }, "a fork at a: that run's total");
  assert.deepEqual(costBase(runs, "other"), {});
});

// ---------- summary

test("usage: summarize puts runs on their local day, fills empty days, ranks bots, and sums only reported cost", () => {
  const now = new Date(2026, 10, 27, 15, 0);
  const at = (daysAgo: number, hour = 12) => new Date(2026, 10, 27 - daysAgo, hour).getTime();
  let n = 0;
  const run = (botId: string, createdAt: number, extra: object): TranscriptEntry => ({
    seq: n,
    updatedSeq: n,
    id: `r${n++}`,
    botId,
    createdAt,
    updatedAt: createdAt,
    body: { kind: "run", provider: "fake", state: "finished", ...extra },
  });
  const entries: TranscriptEntry[] = [
    run("nova", at(0, 9), { usage: { inputTokens: 100, outputTokens: 10 }, costUsd: 0.25 }),
    run("nova", at(0, 23), { usage: { inputTokens: 50, outputTokens: 5 } }),
    run("pip", at(2), { usage: { inputTokens: 1000, outputTokens: 100 } }),
    run("pip", at(9), { usage: { inputTokens: 7, outputTokens: 7 } }), // outside 7 days
    run("nova", at(1), {}), // an old run without usage still counts as a run
    { ...run("nova", at(0), {}), body: { kind: "run", provider: "fake", state: "running" } }, // not ended
    { ...run("nova", at(0), {}), body: { kind: "user_message", text: "hi" } },
  ];
  const s = summarizeUsage(entries, { days: 7, now });
  assert.equal(s.days.length, 7);
  assert.equal(s.from, localDate(new Date(2026, 10, 21)));
  assert.equal(s.to, "2026-11-27");
  assert.deepEqual(s.days.at(-1), { date: "2026-11-27", inputTokens: 150, outputTokens: 15, costUsd: 0.25, runs: 2 });
  assert.equal(s.days.at(-2)?.runs, 1);
  assert.deepEqual(s.days.at(-3)?.inputTokens, 1000);
  assert.deepEqual(
    s.bots.map((b) => [b.botId, b.inputTokens + b.outputTokens, b.runs]),
    [
      ["pip", 1100, 1],
      ["nova", 165, 3],
    ],
  );
  assert.deepEqual(s.total, { inputTokens: 1150, outputTokens: 115, costUsd: 0.25, runs: 4 });
  assert.equal(s.costReported, true);
  assert.equal(summarizeUsage(entries.slice(2, 3), { days: 7, now }).costReported, false);
});

test("http: /usage answers the summary for 7, 30 or 90 days with bot names, and refuses others", async () => {
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
  const get = (path: string) => fetch(`${base}${path}`, { headers: { authorization: "Bearer secret" } });
  try {
    await (await t.gateway.sendMessage("nova", "hello")).done;
    await (await t.gateway.sendMessage("pip", "hi")).done;
    const res = await get("/usage?days=30");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      days: unknown[];
      total: { runs: number; inputTokens: number };
      botNames: Record<string, string>;
    };
    assert.equal(body.days.length, 30);
    assert.equal(body.total.runs, 2);
    assert.equal(body.total.inputTokens, 105 + 102);
    assert.deepEqual(body.botNames, { nova: "Nova", pip: "Pip" });
    assert.equal((await get("/usage")).status, 200, "7 by default");
    assert.equal((await get("/usage?days=5")).status, 400);
  } finally {
    server.closeAllConnections();
    server.close();
    t.cleanup();
  }
});
