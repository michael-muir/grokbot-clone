// Tests for the built-in agent loop: the provider contract on a scripted model, then loop-specific behavior.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeUnansweredCalls, LoopProvider } from "../src/agent/loop.ts";
import type { ChatMessage } from "../src/agent/model.ts";
import { SessionStore } from "../src/agent/sessions.ts";
import { shellTool, type Tool } from "../src/agent/tools.ts";
import { BotRegistry } from "../src/bots.ts";
import { LocalFolderComputers } from "../src/computer.ts";
import { Gateway } from "../src/gateway.ts";
import { TranscriptStore } from "../src/transcript.ts";
import type { ApprovalDecision, RunOutcome, RunRequest, TranscriptEntry } from "../src/types.ts";
import { type ContractScenario, describeProviderContract, Recorder } from "./contract/provider-contract.ts";
import { calls, fails, ScriptedModel, says } from "./support/scripted-model.ts";

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "grokbot-loop-"));
  dirs.push(d);
  return d;
};
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A tool that records its calls. Not read-only unless asked, so it needs approval. */
function fakeTool(name: string, opts: { readOnly?: boolean; run?: Tool["run"] } = {}): Tool & { ran: number } {
  const tool = {
    ran: 0,
    spec: { name, description: `The ${name} tool`, inputSchema: { type: "object", properties: {} } },
    readOnly: opts.readOnly ?? false,
    summarize: () => `Doing ${name}`,
    run: async (input: Record<string, unknown>, ctx: Parameters<Tool["run"]>[1]) => {
      tool.ran++;
      return opts.run ? opts.run(input, ctx) : { ok: true, output: `${name} done` };
    },
  };
  return tool;
}

// ---------- the provider contract ----------

function contractModel(scenario: ContractScenario): ScriptedModel {
  switch (scenario) {
    case "reply":
      return new ScriptedModel([says("Hi there, this is the loop.")]);
    case "tool":
      return new ScriptedModel([calls([{ id: "call-1", name: "do_thing", input: {} }]), says("All done.")]);
    case "slow":
      return new ScriptedModel([says("This reply streams quite slowly on purpose.", 200)]);
    case "fail":
      return new ScriptedModel([fails("Scripted failure.")]);
  }
}

describeProviderContract("loop", {
  create: (scenario) =>
    new LoopProvider({
      id: "fake",
      adapter: contractModel(scenario),
      sessions: new SessionStore(tempDir()),
      tools: [fakeTool("do_thing")],
    }),
});

// ---------- loop behavior ----------

function setup(model: ScriptedModel, tools: Tool[], maxSteps?: number) {
  const dataDir = tempDir();
  const sessions = new SessionStore(dataDir);
  const provider = new LoopProvider({ id: "fake", adapter: model, sessions, tools, maxSteps });
  const run = async (
    prompt: string,
    opts: { sessionId?: string; decide?: (r: unknown) => ApprovalDecision; signal?: AbortSignal } = {},
  ) => {
    const rec = new Recorder(opts.decide ?? (() => ({ allow: true })));
    const req: RunRequest = {
      botId: "b",
      botName: "B",
      prompt,
      sessionId: opts.sessionId,
      workspaceDir: dataDir,
      instructions: "Be brief.",
      signal: opts.signal ?? new AbortController().signal,
    };
    const outcome: RunOutcome = await provider.run(req, rec);
    return { outcome, rec };
  };
  return { sessions, run };
}

const lastToolResult = (messages: ChatMessage[]) =>
  messages.filter((m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool").at(-1);

test("read-only tools run without asking", async () => {
  const look = fakeTool("look", { readOnly: true });
  const model = new ScriptedModel([calls([{ id: "c1", name: "look", input: {} }]), says("Seen it.")]);
  const { run } = setup(model, [look]);
  const { outcome, rec } = await run("look around");
  assert.equal(outcome.status, "finished");
  assert.equal(rec.approvals.length, 0);
  assert.equal(look.ran, 1);
  assert.deepEqual(rec.ofType("tool_start")[0], {
    type: "tool_start",
    toolUseId: "c1",
    tool: "look",
    summary: "Doing look",
  });
});

test("a denial reaches the model as a tool result, and the tool doesn't run", async () => {
  const act = fakeTool("act");
  const model = new ScriptedModel([calls([{ id: "c1", name: "act", input: {} }]), says("Okay, I won't.")]);
  const { run } = setup(model, [act]);
  const { outcome } = await run("do it", { decide: () => ({ allow: false, reason: "not today" }) });
  assert.equal(outcome.status, "finished");
  assert.equal(act.ran, 0);
  const result = lastToolResult(model.requests[1]?.messages ?? []);
  assert.equal(result?.output, "The user denied this: not today");
  assert.equal(result?.isError, true);
});

test("an unknown tool and a throwing tool are reported to the model, not thrown", async () => {
  const broken = fakeTool("broken", {
    readOnly: true,
    run: async () => {
      throw new Error("kaboom");
    },
  });
  const model = new ScriptedModel([
    calls([
      { id: "c1", name: "nope", input: {} },
      { id: "c2", name: "broken", input: {} },
    ]),
    says("Something went wrong with those."),
  ]);
  const { run } = setup(model, [broken]);
  const { outcome, rec } = await run("try");
  assert.equal(outcome.status, "finished");
  assert.deepEqual(
    rec.ofType("tool_end").map((e) => e.ok),
    [false, false],
  );
  const results = (model.requests[1]?.messages ?? []).filter((m) => m.role === "tool");
  assert.match(results[0]?.role === "tool" ? results[0].output : "", /There is no tool named nope/);
  assert.equal(results[1]?.role === "tool" ? results[1].output : "", "Error: kaboom");
});

test("the step limit ends a run that never stops calling tools", async () => {
  const look = fakeTool("look", { readOnly: true });
  const forever = calls([{ id: "again", name: "look", input: {} }]);
  const model = new ScriptedModel([], forever);
  const { run } = setup(model, [look], 3);
  const { outcome } = await run("loop forever");
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error, "Stopped after 3 steps without finishing.");
  assert.equal(model.requests.length, 3);
});

test("history is saved and the next run continues the same session", async () => {
  const model = new ScriptedModel([says("First answer."), says("Second answer.")]);
  const { run, sessions } = setup(model, []);
  const first = await run("first question");
  assert.ok(first.outcome.sessionId);
  await run("second question", { sessionId: first.outcome.sessionId });
  assert.deepEqual(model.requests[1]?.messages, [
    { role: "user", text: "first question" },
    { role: "assistant", text: "First answer.", toolCalls: [] },
    { role: "user", text: "second question" },
  ]);
  assert.equal(sessions.load(first.outcome.sessionId ?? "").length, 4);
});

test("a run interrupted mid-stream saves what the model said so far", async () => {
  const model = new ScriptedModel([says("one two three four five six", 30)]);
  const { run, sessions } = setup(model, []);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 75);
  const { outcome } = await run("count", { signal: controller.signal });
  assert.equal(outcome.status, "interrupted");
  const saved = sessions.load(outcome.sessionId ?? "");
  assert.equal(saved.length, 2);
  const reply = saved[1];
  assert.ok(reply?.role === "assistant" && reply.text.startsWith("one"));
});

test("an interrupt during an approval leaves a valid history", async () => {
  const act = fakeTool("act");
  const model = new ScriptedModel([
    calls([
      { id: "c1", name: "act", input: {} },
      { id: "c2", name: "act", input: {} },
    ]),
  ]);
  const { run, sessions } = setup(model, [act]);
  const controller = new AbortController();
  const { outcome } = await run("do two things", {
    signal: controller.signal,
    decide: () => {
      controller.abort();
      return { allow: false, reason: "The run was stopped." };
    },
  });
  assert.equal(outcome.status, "interrupted");
  assert.equal(act.ran, 0);
  const saved = sessions.load(outcome.sessionId ?? "");
  const results = saved.filter((m) => m.role === "tool");
  assert.deepEqual(
    results.map((m) => (m.role === "tool" ? m.toolCallId : "")),
    ["c1", "c2"],
    "both calls have a result",
  );
});

test("closeUnansweredCalls fills missing results right after their tool calls", () => {
  const history: ChatMessage[] = [
    { role: "user", text: "hi" },
    {
      role: "assistant",
      text: "",
      toolCalls: [
        { id: "a", name: "t", input: {} },
        { id: "b", name: "t", input: {} },
      ],
    },
    { role: "tool", toolCallId: "a", name: "t", output: "ok", isError: false },
    { role: "user", text: "next" },
  ];
  const closed = closeUnansweredCalls(history);
  assert.deepEqual(
    closed.map((m) => (m.role === "tool" ? `tool:${m.toolCallId}` : m.role)),
    ["user", "assistant", "tool:a", "tool:b", "user"],
  );
});

test("the model sees the tools and a system prompt with the instructions and the OS", async () => {
  const model = new ScriptedModel([says("Hello.")]);
  const { run } = setup(model, [fakeTool("act"), fakeTool("look", { readOnly: true })]);
  await run("hi");
  const req = model.requests[0];
  assert.deepEqual(
    req?.tools.map((t) => t.name),
    ["act", "look"],
  );
  assert.match(req?.system ?? "", /Be brief\./);
  assert.match(req?.system ?? "", /The computer runs /);
});

test("an adapter error ends the run as failed with its message", async () => {
  const model = new ScriptedModel([fails("rate limited")]);
  const { run } = setup(model, []);
  const { outcome } = await run("hi");
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error, "rate limited");
});

test("in the gateway, the loop's shell call shows an approval card like the Claude adapter's", async () => {
  const dataDir = tempDir();
  const bots = new BotRegistry(dataDir, [
    { id: "loopy", name: "Loopy", provider: "fake", avatar: { shape: "circle", color: "blue" } },
  ]);
  const store = new TranscriptStore(dataDir);
  const model = new ScriptedModel([
    calls([{ id: "call-1", name: "shell", input: { command: 'node -e "console.log(1)"' } }]),
    says("Ran it."),
  ]);
  const loop = new LoopProvider({ id: "fake", adapter: model, sessions: new SessionStore(dataDir) });
  const gateway = new Gateway(bots, store, new Map([["fake", loop]]), new LocalFolderComputers(dataDir));

  const { done } = await gateway.sendMessage("loopy", "run something");
  let card: TranscriptEntry | undefined;
  for (let i = 0; i < 200 && !card; i++) {
    await new Promise((r) => setTimeout(r, 10));
    card = store.list("loopy").find((e) => e.body.kind === "approval");
  }
  assert.ok(card, "an approval card was posted");
  assert.deepEqual(card.body, {
    kind: "approval",
    tool: "shell",
    summary: 'Running node -e "console.log(1)"',
    input: { command: 'node -e "console.log(1)"' },
    state: "pending",
  });
  const status = store.list("loopy").find((e) => e.body.kind === "status");
  assert.equal(status?.body.kind === "status" && status.body.label, 'Running node -e "console.log(1)"');

  assert.equal(gateway.answerApproval("loopy", card.id, { allow: true }), true);
  await done;
  const kinds = store.list("loopy").map((e) => e.body.kind);
  assert.deepEqual(kinds, ["user_message", "run", "status", "approval", "assistant_text"]);
  const finalStatus = store.list("loopy").find((e) => e.body.kind === "status");
  assert.equal(finalStatus?.body.kind === "status" && finalStatus.body.state, "done");
});

test("a model error mid-stream still closes the streamed text and keeps it in the history", async () => {
  const model = new ScriptedModel([
    async function* () {
      yield { type: "text_delta", text: "Half a " };
      yield { type: "text_delta", text: "thought" };
      throw new Error("connection reset");
    },
  ]);
  const { run, sessions } = setup(model, []);
  const { outcome, rec } = await run("hi");
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error, "connection reset");
  assert.deepEqual(rec.ofType("text"), [{ type: "text", blockId: "1:0", text: "Half a thought" }]);
  const saved = sessions.load(outcome.sessionId ?? "");
  assert.deepEqual(saved.at(-1), { role: "assistant", text: "Half a thought", toolCalls: [] });
});

test("blank or repeated tool call ids are made unique", async () => {
  const look = fakeTool("look", { readOnly: true });
  const model = new ScriptedModel([
    calls([
      { id: "", name: "look", input: {} },
      { id: "dup", name: "look", input: {} },
      { id: "dup", name: "look", input: {} },
    ]),
    says("Looked three times."),
  ]);
  const { run } = setup(model, [look]);
  const { outcome, rec } = await run("look");
  assert.equal(outcome.status, "finished");
  const ids = rec.ofType("tool_start").map((e) => e.toolUseId);
  assert.equal(new Set(ids).size, 3);
  assert.ok(ids.every(Boolean));
});

test("a reused tool call id isn't treated as answered by an earlier result", () => {
  const history: ChatMessage[] = [
    { role: "assistant", text: "", toolCalls: [{ id: "call_0", name: "t", input: {} }] },
    { role: "tool", toolCallId: "call_0", name: "t", output: "ok", isError: false },
    { role: "assistant", text: "", toolCalls: [{ id: "call_0", name: "t", input: {} }] },
  ];
  const closed = closeUnansweredCalls(history);
  assert.equal(closed.length, 4);
  assert.deepEqual(closed[3], {
    role: "tool",
    toolCallId: "call_0",
    name: "t",
    output: "The run was stopped before this tool ran.",
    isError: true,
  });
});

test("tool call ids stay unique across runs of the same session", async () => {
  const look = fakeTool("look", { readOnly: true });
  const model = new ScriptedModel([
    calls([{ id: "call_0", name: "look", input: {} }]),
    says("Once."),
    calls([{ id: "call_0", name: "look", input: {} }]),
    says("Twice."),
  ]);
  const { run, sessions } = setup(model, [look]);
  const first = await run("look");
  await run("look again", { sessionId: first.outcome.sessionId });
  const ids = sessions
    .load(first.outcome.sessionId ?? "")
    .flatMap((m) => (m.role === "assistant" ? m.toolCalls.map((c) => c.id) : []));
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2);
});

test("the system prompt names the shell of the configured shell tool", async () => {
  const bash = shellTool({ name: "bash", command: "bash", args: (s) => ["-c", s] });
  const model = new ScriptedModel([says("Hi.")]);
  const { run } = setup(model, [bash]);
  await run("hi");
  assert.match(model.requests[0]?.system ?? "", /The shell tool uses bash/);
});

test("a tool call whose arguments couldn't be parsed is reported, not run", async () => {
  const look = fakeTool("look", { readOnly: true });
  const model = new ScriptedModel([
    calls([{ id: "c1", name: "look", input: { _invalid_arguments: "Arguments were not valid JSON: {oops" } }]),
    says("Let me fix that."),
  ]);
  const { run } = setup(model, [look]);
  const { outcome, rec } = await run("look");
  assert.equal(outcome.status, "finished");
  assert.equal(look.ran, 0);
  assert.equal(rec.ofType("tool_end")[0]?.ok, false);
  assert.equal(
    lastToolResult(model.requests[1]?.messages ?? [])?.output,
    "Invalid input: Arguments were not valid JSON: {oops",
  );
});
