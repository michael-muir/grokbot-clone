// Runs the provider contract against every provider, offline. Claude runs on a scripted stand-in for the SDK.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Options, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeProvider, type QueryFn } from "../src/providers/claude.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { AgentProvider, RunCallbacks, RunOutcome, RunRequest } from "../src/types.ts";
import {
  type ContractScenario,
  describeProviderContract,
  runScenario,
  sequenceViolations,
} from "./contract/provider-contract.ts";

// ---------- fake ----------

const FAKE_PROMPTS: Record<ContractScenario, string> = {
  reply: "hello",
  tool: "/tool",
  slow: "/slow",
  fail: "/fail",
};

describeProviderContract("fake", {
  create: () => new FakeProvider(1),
  prompt: (s) => FAKE_PROMPTS[s],
});

// ---------- claude (scripted SDK) ----------

/** Shapes follow the SDK's message types; only the fields the adapter reads are filled in. */
const sdk = (m: object): SDKMessage => m as SDKMessage;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });

async function* streamedReply(id: string, words: string[], delayMs: number, signal?: AbortSignal) {
  yield sdk({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id } } });
  yield sdk({
    type: "stream_event",
    parent_tool_use_id: null,
    event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  });
  for (const [i, word] of words.entries()) {
    await sleep(delayMs, signal);
    yield sdk({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: (i ? " " : "") + word } },
    });
  }
  yield sdk({
    type: "assistant",
    parent_tool_use_id: null,
    uuid: `${id}-uuid`,
    message: { id, role: "assistant", content: [{ type: "text", text: words.join(" ") }] },
  });
}

function scriptedQuery(scenario: ContractScenario): QueryFn {
  return async function* ({ options }: { prompt: string; options: Options }) {
    const signal = options.abortController?.signal;
    // Resuming at a point forks: the SDK starts a new session (forkSession) holding the old one up to there.
    const session = options.resume && options.forkSession ? "claude-fork-1" : (options.resume ?? "claude-session-1");
    yield sdk({ type: "system", subtype: "init", session_id: session });

    if (scenario === "fail") {
      yield sdk({
        type: "result",
        subtype: "error_during_execution",
        errors: ["Scripted failure."],
        total_cost_usd: 0,
      });
      return;
    }

    if (scenario === "tool") {
      const input = { command: "echo hello" };
      yield sdk({
        type: "assistant",
        parent_tool_use_id: null,
        uuid: "msg-tool-uuid",
        message: {
          id: "msg-tool",
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input }],
        },
      });
      const decision: PermissionResult | null | undefined = await options.canUseTool?.("Bash", input, {
        signal: signal ?? new AbortController().signal,
        toolUseID: "toolu_1",
        requestId: "req-1",
      });
      const allowed = decision?.behavior === "allow";
      yield sdk({
        type: "user",
        parent_tool_use_id: null,
        uuid: "tool-result-uuid",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", is_error: !allowed, content: allowed ? "hello" : "denied" },
          ],
        },
      });
    }

    const slow = scenario === "slow";
    yield* streamedReply("msg-reply", ["Hi", "there,", "this", "is", "Claude."], slow ? 200 : 1, signal);
    yield sdk({ type: "result", subtype: "success", total_cost_usd: 0.01 });
  };
}

describeProviderContract("claude", {
  create: (scenario) => new ClaudeProvider(scriptedQuery(scenario)),
});

test("claude: an API error (no credit) fails the run instead of posting the error as a reply", async () => {
  const query: QueryFn = async function* () {
    yield sdk({ type: "system", subtype: "init", session_id: "s-err" });
    yield sdk({
      type: "assistant",
      parent_tool_use_id: null,
      error: "billing_error",
      message: { id: "msg-err", role: "assistant", content: [{ type: "text", text: "Credit balance is too low" }] },
    });
    yield sdk({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Credit balance is too low",
      total_cost_usd: 0,
    });
  };
  const emitted: string[] = [];
  const outcome = await new ClaudeProvider(query, () => "test-key").run(
    {
      botId: "b",
      botName: "B",
      prompt: "hi",
      workspaceDir: ".",
      instructions: "",
      signal: new AbortController().signal,
    },
    {
      emit: (e) => emitted.push(e.type),
      requestApproval: async () => ({ allow: false, reason: "no" }),
    },
  );
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.status === "failed" && outcome.error, "Anthropic: Credit balance is too low");
  assert.ok(!emitted.includes("text"), "the error text is not shown as the bot's reply");
});

test("claude: an API error that the SDK retries past still finishes the run", async () => {
  const query: QueryFn = async function* () {
    yield sdk({ type: "system", subtype: "init", session_id: "s-retry" });
    yield sdk({
      type: "assistant",
      parent_tool_use_id: null,
      error: "overloaded",
      message: { id: "msg-busy", role: "assistant", content: [{ type: "text", text: "Overloaded" }] },
    });
    yield* streamedReply("msg-ok", ["Done."], 1);
    yield sdk({ type: "result", subtype: "success", is_error: false, result: "Done.", total_cost_usd: 0.01 });
  };
  const texts: string[] = [];
  const outcome = await new ClaudeProvider(query, () => "test-key").run(
    {
      botId: "b",
      botName: "B",
      prompt: "hi",
      workspaceDir: ".",
      instructions: "",
      signal: new AbortController().signal,
    },
    {
      emit: (e) => {
        if (e.type === "text") texts.push(e.text);
      },
      requestApproval: async () => ({ allow: false, reason: "no" }),
    },
  );
  assert.equal(outcome.status, "finished");
  assert.deepEqual(texts, ["Done."], "only the real reply is shown");
});

test("claude: Stop returns at once even while the SDK keeps streaming through its shutdown grace period", async () => {
  // Like the real SDK: after abort it keeps delivering messages (~2 s grace), then a "success" result.
  const query: QueryFn = async function* () {
    yield sdk({ type: "system", subtype: "init", session_id: "s-stop" });
    yield sdk({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "message_start", message: { id: "m" } },
    });
    yield sdk({
      type: "stream_event",
      parent_tool_use_id: null,
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    });
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 50));
      yield sdk({
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `${i} ` } },
      });
    }
    yield sdk({ type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.01 });
  };
  const controller = new AbortController();
  let deltasAfterStop = 0;
  let stoppedAt = 0;
  const started = Date.now();
  const run = new ClaudeProvider(query, () => "test-key").run(
    { botId: "b", botName: "B", prompt: "count", workspaceDir: ".", instructions: "", signal: controller.signal },
    {
      emit: (e) => {
        if (e.type === "text_delta" && stoppedAt) deltasAfterStop++;
        if (e.type === "text_delta" && !stoppedAt && Date.now() - started > 300) {
          stoppedAt = Date.now();
          controller.abort();
        }
      },
      requestApproval: async () => ({ allow: false, reason: "no" }),
    },
  );
  const outcome = await run;
  const ms = Date.now() - stoppedAt;
  assert.equal(outcome.status, "interrupted");
  assert.ok(ms < 200, `returned ${ms} ms after Stop`);
  assert.equal(deltasAfterStop, 0, "nothing more reaches the transcript after Stop");
});

test("claude: a run on a session waits until the stopped run's process has shut down", async () => {
  const events: string[] = [];
  let shutDownAt = 0;
  // Each query streams forever until asked to close; closing takes 300 ms, like Claude Code's graceful exit.
  const query: QueryFn = ({ options }) => {
    events.push(`start ${options.resume ?? "new"}`);
    let i = 0;
    return {
      [Symbol.asyncIterator]() {
        return {
          next: async () => {
            await new Promise((r) => setTimeout(r, 20));
            const msg =
              i++ === 0
                ? sdk({ type: "system", subtype: "init", session_id: "s-1" })
                : sdk({
                    type: "stream_event",
                    parent_tool_use_id: null,
                    event: { type: "message_start", message: { id: `m${i}` } },
                  });
            return { done: false, value: msg };
          },
          return: async () => {
            await new Promise((r) => setTimeout(r, 300));
            shutDownAt = Date.now();
            events.push("closed");
            return { done: true, value: undefined };
          },
        };
      },
    };
  };
  const provider = new ClaudeProvider(query, () => "test-key");
  const callbacks = { emit: () => {}, requestApproval: async () => ({ allow: false, reason: "no" }) as const };
  const request = (signal: AbortSignal, sessionId?: string) => ({
    botId: "b",
    botName: "B",
    prompt: "go",
    workspaceDir: ".",
    instructions: "",
    signal,
    ...(sessionId ? { sessionId } : {}),
  });

  const first = new AbortController();
  const running = provider.run(request(first.signal), callbacks);
  await new Promise((r) => setTimeout(r, 100));
  first.abort();
  const stopped = await running;
  assert.equal(stopped.status, "interrupted");
  assert.equal(stopped.sessionId, "s-1");

  const second = new AbortController();
  const next = provider.run(request(second.signal, "s-1"), callbacks);
  await new Promise((r) => setTimeout(r, 450));
  second.abort();
  await next;
  assert.deepEqual(events.slice(0, 3), ["start new", "closed", "start s-1"], "the second run started after the close");
  assert.ok(shutDownAt > 0);
});

// ---------- the contract catches broken providers ----------

class BrokenProvider implements AgentProvider {
  readonly id = "fake" as const;
  async run(_req: RunRequest, cb: RunCallbacks): Promise<RunOutcome> {
    cb.emit({ type: "session", sessionId: "s" });
    cb.emit({ type: "text_delta", blockId: "b1", text: "never finalized" });
    cb.emit({ type: "tool_end", toolUseId: "t-unknown", ok: true });
    void Promise.resolve()
      .then(() => undefined)
      .then(() => undefined)
      .then(() => cb.emit({ type: "text", blockId: "chained", text: "after a promise chain" }));
    setTimeout(() => cb.emit({ type: "text", blockId: "late", text: "too late" }), 5);
    return { status: "finished", sessionId: "s" };
  }
}

test("provider contract: a broken provider is caught", async () => {
  const r = await runScenario({ create: () => new BrokenProvider() }, "reply");
  const problems = [...r.rec.violations, ...sequenceViolations(r.rec.events)];
  // Both the promise-chain emit and the timer emit are caught.
  assert.equal(problems.filter((p) => p.includes("after run() resolved")).length, 2);
  assert.ok(problems.some((p) => p.includes("without an open tool_start")));
  assert.ok(problems.some((p) => p.includes("never got its final text")));
});

test("claude: the checkpoint is the session's last top-level message, and resuming there forks the session", async () => {
  const seen: Options[] = [];
  const query: QueryFn = async function* ({ options }) {
    seen.push(options);
    yield sdk({ type: "system", subtype: "init", session_id: options.forkSession ? "s-fork" : "s-1" });
    yield sdk({
      type: "assistant",
      parent_tool_use_id: null,
      uuid: "u-call",
      message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] },
    });
    // A subagent's messages aren't the session's own chain.
    yield sdk({ type: "assistant", parent_tool_use_id: "t1", uuid: "u-sub", message: { id: "m2", content: [] } });
    yield sdk({
      type: "user",
      parent_tool_use_id: null,
      uuid: "u-result",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    });
    yield sdk({ type: "result", subtype: "success", total_cost_usd: 0 });
  };
  const provider = new ClaudeProvider(query, () => "test-key");
  const run = async (extra: Partial<RunRequest>) => {
    const checkpoints: string[] = [];
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
      {
        emit: (e) => {
          if (e.type === "checkpoint") checkpoints.push(e.at);
        },
        requestApproval: async () => ({ allow: true }),
      },
    );
    return { outcome, checkpoints };
  };

  const first = await run({});
  assert.deepEqual(first.checkpoints, ["u-call", "u-result"]);
  assert.equal(seen[0]?.forkSession, undefined, "a plain run doesn't fork");
  assert.equal(seen[0]?.resumeSessionAt, undefined);

  const fork = await run({ sessionId: "s-1", resumeAt: "u-call" });
  assert.equal(fork.outcome.sessionId, "s-fork");
  assert.equal(seen[1]?.resume, "s-1");
  assert.equal(seen[1]?.resumeSessionAt, "u-call");
  assert.equal(seen[1]?.forkSession, true);
});
