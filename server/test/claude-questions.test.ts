// Claude's AskUserQuestion becomes choice cards, and the answers go back in the shape Claude Code reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Options, PermissionResult, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeProvider, type QueryFn, summarizeTool } from "../src/providers/claude.ts";
import { answerQuestions } from "../src/providers/claude-questions.ts";
import type { ChoiceRequest, RunCallbacks } from "../src/types.ts";

const sdk = (m: object): SDKMessage => m as SDKMessage;

const QUESTIONS = {
  questions: [
    {
      question: "Which library should we use?",
      header: "Library",
      options: [
        { label: "date-fns", description: "Small" },
        { label: "Luxon", description: "Time zones" },
      ],
      multiSelect: false,
    },
    {
      question: "Where should it live?",
      header: "Place",
      options: [
        { label: "app", description: "" },
        { label: "server", description: "" },
        { label: "app", description: "duplicate" },
      ],
      multiSelect: false,
    },
  ],
};

/** A scripted SDK run: Claude asks AskUserQuestion, then finishes. Records what canUseTool returned. */
function askingQuery(input: Record<string, unknown>, seen: { result?: PermissionResult | null }): QueryFn {
  return async function* ({ options }: { prompt: string; options: Options }) {
    yield sdk({ type: "system", subtype: "init", session_id: "s1" });
    yield sdk({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "m1",
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_q", name: "AskUserQuestion", input }],
      },
    });
    seen.result = await options.canUseTool?.("AskUserQuestion", input, {
      signal: options.abortController?.signal ?? new AbortController().signal,
      toolUseID: "toolu_q",
      requestId: "r1",
    });
    yield sdk({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_q", content: "ok" }] },
    });
    yield sdk({ type: "result", subtype: "success", total_cost_usd: 0 });
  };
}

function callbacks(answers: (string | undefined)[], asked: ChoiceRequest[]): RunCallbacks {
  return {
    emit: () => {},
    requestApproval: async () => {
      throw new Error("a question must not ask for approval");
    },
    requestChoice: async (req) => {
      asked.push(req);
      return answers.shift();
    },
  };
}

const run = (provider: ClaudeProvider, cb: RunCallbacks, signal = new AbortController().signal) =>
  provider.run({ botId: "b", botName: "Bot", prompt: "hi", workspaceDir: "/w", instructions: "", signal }, cb);

test("claude: AskUserQuestion shows a card per question and returns the answers keyed by question", async () => {
  const seen: { result?: PermissionResult | null } = {};
  const asked: ChoiceRequest[] = [];
  const outcome = await run(
    new ClaudeProvider(askingQuery(QUESTIONS, seen), () => "k"),
    callbacks(["Luxon", "somewhere else"], asked),
  );
  assert.equal(outcome.status, "finished");
  assert.deepEqual(asked, [
    {
      prompt: "Which library should we use?",
      options: [
        { label: "date-fns", value: "date-fns" },
        { label: "Luxon", value: "Luxon" },
      ],
      allowCustom: true,
    },
    {
      prompt: "Where should it live?",
      options: [
        { label: "app", value: "app" },
        { label: "server", value: "server" },
      ],
      allowCustom: true,
    },
  ]);
  assert.deepEqual(seen.result, {
    behavior: "allow",
    updatedInput: {
      ...QUESTIONS,
      answers: { "Which library should we use?": "Luxon", "Where should it live?": "somewhere else" },
    },
  });
});

test("claude: a question left unanswered when the run stops is denied, and later questions aren't asked", async () => {
  const asked: ChoiceRequest[] = [];
  const result = await answerQuestions(
    QUESTIONS,
    async (req) => {
      asked.push(req);
      return undefined;
    },
    new AbortController().signal,
  );
  assert.equal(asked.length, 1);
  assert.deepEqual(result, { behavior: "deny", message: "The run was stopped before the user answered." });
});

test("claude: without choice cards, or with a malformed question, AskUserQuestion is denied with a reason", async () => {
  const signal = new AbortController().signal;
  const noCards = await answerQuestions(QUESTIONS, undefined, signal);
  assert.equal(noCards.behavior, "deny");
  assert.match(noCards.behavior === "deny" ? noCards.message : "", /plain text/);

  const never = async () => {
    throw new Error("must not ask");
  };
  for (const bad of [
    {},
    { questions: [] },
    { questions: [{ question: "", options: [{ label: "a" }, { label: "b" }] }] },
    { questions: [{ question: "Pick?", options: [{ label: "a" }, { label: " a " }] }] },
    { questions: [{ question: "Pick?", options: "a,b" }] },
  ]) {
    const result = await answerQuestions(bad, never, signal);
    assert.equal(result.behavior, "deny", JSON.stringify(bad));
  }
});

test("claude: the status row for a question shows the question", () => {
  assert.equal(summarizeTool("AskUserQuestion", QUESTIONS, "/w"), "Asking: Which library should we use?");
  assert.equal(summarizeTool("AskUserQuestion", {}, "/w"), "Asking: ");
});
