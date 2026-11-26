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
    message: { id, role: "assistant", content: [{ type: "text", text: words.join(" ") }] },
  });
}

function scriptedQuery(scenario: ContractScenario): QueryFn {
  return async function* ({ options }: { prompt: string; options: Options }) {
    const signal = options.abortController?.signal;
    yield sdk({ type: "system", subtype: "init", session_id: options.resume ?? "claude-session-1" });

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
