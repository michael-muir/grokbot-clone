// Cursor (#26): the provider contract and Cursor's own behavior, on a scripted ACP server that speaks the protocol.
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  CursorProvider,
  firstPrompt,
  isolatedEnv,
  outcomeOf,
  prepareHome,
  workspaceHooks,
} from "../src/providers/cursor.ts";
import { type LineConnection, launchSpec } from "../src/providers/stdio-rpc.ts";
import type { ApprovalDecision, ProviderEvent, RunCallbacks, RunRequest } from "../src/types.ts";
import { type ContractScenario, describeProviderContract } from "./contract/provider-contract.ts";

type Json = Record<string, unknown>;

/** The bots' Cursor home for these tests: the turn log lives there. */
const HOME = mkdtempSync(join(tmpdir(), "cursor-home-test-"));
after(() => rmSync(HOME, { recursive: true, force: true }));

interface Script {
  /** What a prompt does: send updates, ask permission (awaiting the answer); resolves with the stop reason. */
  prompt(server: ScriptedAcp, sessionId: string, text: string): Promise<string>;
}

/** A scripted `cursor-agent acp`: answers setup requests, records what it was sent, and runs a prompt script. */
class ScriptedAcp implements LineConnection {
  readonly requests: { method: string; params: Json }[] = [];
  readonly answers: unknown[] = [];
  private lineFns: ((line: string) => void)[] = [];
  private exitFns: ((detail: string) => void)[] = [];
  private nextServerId = 1000;
  private waiting = new Map<number, (result: unknown) => void>();
  cancelled = false;
  closed = false;
  private readonly script: Script;
  private readonly newId: string;
  private cancelPrompt: () => void = () => {};

  constructor(script: Script, newId = "s-new") {
    this.script = script;
    this.newId = newId;
  }

  send(line: string): void {
    const msg = JSON.parse(line) as Json;
    if (typeof msg.method !== "string") {
      const id = Number(msg.id);
      const answer = msg.result ?? { error: msg.error };
      this.answers.push(answer);
      this.waiting.get(id)?.(answer);
      return;
    }
    const params = (msg.params ?? {}) as Json;
    this.requests.push({ method: msg.method, params });
    const reply = (result: unknown) => this.emit({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
      case "initialize":
        reply({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
        return;
      case "session/new":
        reply({
          sessionId: this.newId,
          models: { availableModels: [{ modelId: "auto" }, { modelId: "gpt-x[fast=true]" }] },
        });
        return;
      case "session/load":
        // Like Cursor: the history is replayed before the answer.
        this.update(String(params.sessionId), {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "old" },
        });
        this.update(String(params.sessionId), {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Old reply." },
        });
        reply(null);
        return;
      case "session/set_model":
        reply({});
        return;
      case "session/cancel":
        this.cancelled = true;
        this.cancelPrompt();
        return;
      case "session/prompt": {
        const text = String(((params.prompt as Json[])[0] ?? {}).text ?? "");
        const cancelled = new Promise<string>((resolve) => {
          this.cancelPrompt = () => resolve("cancelled");
        });
        Promise.race([this.script.prompt(this, String(params.sessionId), text), cancelled]).then(
          (stopReason) => reply({ stopReason }),
          (err: Error) => this.emit({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: err.message } }),
        );
        return;
      }
      default:
        this.emit({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown" } });
    }
  }

  onLine(fn: (line: string) => void): void {
    this.lineFns.push(fn);
  }
  onExit(fn: (detail: string) => void): void {
    this.exitFns.push(fn);
  }
  close(): void {
    this.closed = true;
  }

  emit(msg: Json): void {
    setImmediate(() => {
      for (const fn of this.lineFns) fn(JSON.stringify(msg));
    });
  }
  update(sessionId: string, update: Json): void {
    this.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  }
  /** Sends a server request and resolves with the client's answer. */
  ask(method: string, params: Json): Promise<unknown> {
    const id = this.nextServerId++;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.emit({ jsonrpc: "2.0", id, method, params });
    });
  }
  die(detail: string): void {
    for (const fn of this.exitFns) fn(detail);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chunk = (s: ScriptedAcp, sid: string, text: string) =>
  s.update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

async function words(s: ScriptedAcp, sid: string, list: string[], delayMs = 1): Promise<string> {
  for (const [i, w] of list.entries()) {
    if (s.cancelled) return "cancelled";
    await sleep(delayMs);
    if (s.cancelled) return "cancelled";
    chunk(s, sid, (i ? " " : "") + w);
  }
  await sleep(1);
  return "end_turn";
}

const PERMISSION_OPTIONS = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];

const SCRIPTS: Record<ContractScenario, Script> = {
  reply: { prompt: (s, sid) => words(s, sid, ["Hi", "there."]) },
  slow: { prompt: (s, sid) => words(s, sid, ["one", "two", "three", "four", "five", "six"], 200) },
  fail: {
    prompt: async () => {
      throw new Error("Scripted failure.");
    },
  },
  tool: {
    prompt: async (s, sid) => {
      const toolCall = { toolCallId: "t1", title: "echo hello", kind: "execute", rawInput: { command: "echo hello" } };
      s.update(sid, { sessionUpdate: "tool_call", ...toolCall, status: "pending" });
      const answer = (await s.ask("session/request_permission", {
        sessionId: sid,
        // Like Cursor: the input came with the tool call, not with the permission request.
        toolCall: { ...toolCall, rawInput: {} },
        options: PERMISSION_OPTIONS,
      })) as Json;
      const outcome = answer.outcome as Json;
      if (outcome.outcome === "cancelled") return "cancelled";
      const allowed = outcome.optionId === "allow-once";
      s.update(sid, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: allowed ? "completed" : "failed" });
      return words(s, sid, [allowed ? "Done." : "Okay, skipped."]);
    },
  },
};

describeProviderContract("cursor", {
  create: (scenario) =>
    new CursorProvider({
      homeDir: HOME,
      connect: async () => new ScriptedAcp(SCRIPTS[scenario]),
      stopGraceMs: 300,
    }),
});

// ---------- Cursor specifics

function runWith(
  script: Script,
  extra: Partial<RunRequest> = {},
  answer: (signal: AbortSignal) => Promise<ApprovalDecision> = async () => ({ allow: true }),
  newId = "s-new",
) {
  const server = new ScriptedAcp(script, newId);
  const events: ProviderEvent[] = [];
  const asked: string[] = [];
  const inputs: Record<string, unknown>[] = [];
  const provider = new CursorProvider({ homeDir: HOME, connect: async () => server, stopGraceMs: 300 });
  const controller = new AbortController();
  const callbacks: RunCallbacks = {
    emit: (e) => events.push(e),
    requestApproval: async (r, signal) => {
      asked.push(`${r.tool}: ${r.summary}`);
      inputs.push(r.input);
      return answer(signal);
    },
  };
  const done = provider.run(
    {
      botId: "b",
      botName: "B",
      prompt: "hello",
      workspaceDir: tmpdir(),
      instructions: "Be brief.",
      signal: controller.signal,
      ...extra,
    },
    callbacks,
  );
  return { server, events, asked, inputs, done, controller };
}

test("cursor: a new session carries the instructions in its first prompt, and the model is set", async () => {
  const r = runWith(SCRIPTS.reply, { model: "gpt-x[fast=true]" });
  const outcome = await r.done;
  assert.deepEqual(outcome, { status: "finished", sessionId: "s-new" });
  assert.deepEqual(r.server.requests.find((q) => q.method === "session/set_model")?.params, {
    sessionId: "s-new",
    modelId: "gpt-x[fast=true]",
  });
  const prompt = r.server.requests.find((q) => q.method === "session/prompt")?.params.prompt as Json[];
  assert.match(String(prompt[0]?.text), /^<instructions>\nBe brief\.\n<\/instructions>\n\nhello$/);
  assert.equal(r.server.closed, true);
});

test("cursor: a session is loaded, its replayed history isn't emitted, and the prompt is sent as it is", async () => {
  const r = runWith(SCRIPTS.reply, { sessionId: "s-7" });
  assert.deepEqual(await r.done, { status: "finished", sessionId: "s-7" });
  assert.ok(r.server.requests.some((q) => q.method === "session/load" && q.params.sessionId === "s-7"));
  const texts = r.events.filter((e) => e.type === "text").map((e) => (e.type === "text" ? e.text : ""));
  assert.deepEqual(texts, ["Hi there."], "only this run's reply");
  const prompt = r.server.requests.find((q) => q.method === "session/prompt")?.params.prompt as Json[];
  assert.equal(prompt[0]?.text, "hello");
});

test("cursor: text streams in blocks that tool calls end, and tool calls are steps", async () => {
  const r = runWith(
    {
      prompt: async (s, sid) => {
        chunk(s, sid, "Let me look.");
        s.update(sid, {
          sessionUpdate: "tool_call",
          toolCallId: "r1",
          title: "Read notes.md",
          kind: "read",
          status: "pending",
        });
        s.update(sid, {
          sessionUpdate: "tool_call",
          toolCallId: "k1",
          title: "Thinking",
          kind: "think",
          status: "pending",
        });
        s.update(sid, { sessionUpdate: "tool_call_update", toolCallId: "r1", status: "completed" });
        chunk(s, sid, "Found it.");
        await sleep(5);
        return "end_turn";
      },
    },
    {},
  );
  await r.done;
  assert.deepEqual(
    r.events.filter((e) => e.type !== "session" && e.type !== "checkpoint"),
    [
      { type: "text_delta", blockId: "cursor-text-1", text: "Let me look." },
      { type: "text", blockId: "cursor-text-1", text: "Let me look." },
      { type: "tool_start", toolUseId: "r1", tool: "Read", summary: "Read notes.md" },
      { type: "tool_end", toolUseId: "r1", ok: true },
      { type: "text_delta", blockId: "cursor-text-2", text: "Found it." },
      { type: "text", blockId: "cursor-text-2", text: "Found it." },
    ],
  );
});

test("cursor: permissions become cards; allow and deny answer once; Stop cancels; questions are skipped", async () => {
  const allowed = runWith(SCRIPTS.tool);
  await allowed.done;
  assert.deepEqual(allowed.asked, ["Bash: echo hello"]);
  assert.deepEqual(allowed.inputs, [{ command: "echo hello" }]);
  assert.deepEqual(allowed.server.answers, [{ outcome: { outcome: "selected", optionId: "allow-once" } }]);

  const denied = runWith(SCRIPTS.tool, {}, async () => ({ allow: false, reason: "no" }));
  await denied.done;
  assert.deepEqual(denied.server.answers, [{ outcome: { outcome: "selected", optionId: "reject-once" } }]);

  let stop: () => void = () => {};
  const stopped = runWith(SCRIPTS.tool, {}, (signal) => {
    const answer = new Promise<ApprovalDecision>((resolve) =>
      signal.addEventListener("abort", () => resolve({ allow: false, reason: "The run was stopped." }), { once: true }),
    );
    stop();
    return answer;
  });
  stop = () => stopped.controller.abort();
  assert.equal((await stopped.done).status, "interrupted");
  await sleep(20);
  assert.deepEqual(stopped.server.answers, [{ outcome: { outcome: "cancelled" } }]);
  assert.equal(stopped.server.cancelled, true, "session/cancel was sent");

  const question = runWith({
    prompt: async (s, sid) => {
      await s.ask("session/request_permission", {
        sessionId: sid,
        toolCall: { toolCallId: "q1", title: "Which color?", kind: "other" },
        options: [
          { optionId: "red", name: "Red", kind: "allow_once" },
          { optionId: "__ask_question_skip__", name: "Skip", kind: "reject_once" },
        ],
      });
      return words(s, sid, ["Fine."]);
    },
  });
  await question.done;
  assert.deepEqual(question.asked, [], "no card for a question");
  assert.deepEqual(question.server.answers, [{ outcome: { outcome: "selected", optionId: "__ask_question_skip__" } }]);
});

test("cursor: stop reasons, an unexpected exit, and unsupported requests", async () => {
  assert.deepEqual(outcomeOf("end_turn", "s"), { status: "finished", sessionId: "s" });
  assert.deepEqual(outcomeOf("max_tokens", "s"), { status: "finished", sessionId: "s" });
  assert.deepEqual(outcomeOf("cancelled", "s"), { status: "interrupted", sessionId: "s" });
  assert.equal(outcomeOf("refusal", "s").status, "failed");

  const dying = runWith({
    prompt: async (s) => {
      s.die("Not logged in. Run agent login.");
      return new Promise(() => {});
    },
  });
  const outcome = await dying.done;
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error ?? "", /Not logged in/);

  const asking = runWith({
    prompt: async (s, sid) => {
      const answer = (await s.ask("fs/read_text_file", { sessionId: sid, path: "/etc/passwd" })) as Json;
      assert.ok(answer.error, "an error, not a file");
      return words(s, sid, ["Fine."]);
    },
  });
  assert.equal((await asking.done).status, "finished");
});

test("cursor: listModels lists the signed-in account's models", async () => {
  const provider = new CursorProvider({ homeDir: HOME, connect: async () => new ScriptedAcp(SCRIPTS.reply) });
  assert.deepEqual(await provider.listModels(new AbortController().signal), ["auto", "gpt-x[fast=true]"]);
});

test("cursor: every run gets a home of its own, keeping the sign-in reachable", () => {
  const home = join("data", "cursor-home");
  const real = join("users", "me");
  const win = isolatedEnv(home, { APPDATA: "appdata", ANTHROPIC_API_KEY: "sk-x" }, "win32", real);
  assert.equal(win.HOME, home);
  assert.equal(win.USERPROFILE, home);
  assert.equal(win.CURSOR_CONFIG_DIR, join(home, ".cursor"));
  assert.equal(win.APPDATA, "appdata", "where Windows keeps the sign-in");
  assert.equal(win.ANTHROPIC_API_KEY, undefined, "no keys");
  assert.equal(isolatedEnv(home, {}, "linux", real).XDG_CONFIG_HOME, join(real, ".config"));
  assert.equal(isolatedEnv(home, { XDG_CONFIG_HOME: "xdg" }, "linux", real).XDG_CONFIG_HOME, "xdg");
  assert.equal(isolatedEnv(home, {}, "darwin", real).XDG_CONFIG_HOME, undefined);
});

test("cursor: a workspace with hooks Cursor would run refuses to start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cursor-hooks-"));
  try {
    assert.equal(workspaceHooks(dir), undefined);
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ permissions: {} }));
    assert.equal(workspaceHooks(dir), undefined, "settings without hooks are fine");
    writeFileSync(join(dir, ".claude", "settings.local.json"), JSON.stringify({ hooks: { PreToolUse: [] } }));
    assert.equal(workspaceHooks(dir), join(dir, ".claude", "settings.local.json"), "the local settings count too");
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [] } }));
    assert.equal(workspaceHooks(dir), join(dir, ".claude", "settings.json"));
    mkdirSync(join(dir, ".cursor"));
    writeFileSync(join(dir, ".cursor", "hooks.json"), "{}");
    assert.equal(workspaceHooks(dir), join(dir, ".cursor", "hooks.json"));

    const r = runWith(SCRIPTS.reply, { workspaceDir: dir });
    const outcome = await r.done;
    assert.equal(outcome.status, "failed");
    assert.match(outcome.error ?? "", /hooks/);
    assert.deepEqual(r.server.requests, [], "Cursor wasn't started");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const promptText = (server: ScriptedAcp): string => {
  const prompt = server.requests.find((q) => q.method === "session/prompt")?.params.prompt as Json[] | undefined;
  return String(prompt?.[0]?.text ?? "");
};

test("cursor: each turn leaves a checkpoint, and a fork replays the conversation up to it in a new session", async () => {
  const first = runWith({ prompt: (s, sid) => words(s, sid, ["Red."]) }, { prompt: "Pick a color." }, undefined, "s-a");
  await first.done;
  assert.deepEqual(
    first.events.filter((e) => e.type === "checkpoint"),
    [{ type: "checkpoint", at: "2" }],
  );
  const second = runWith({ prompt: (s, sid) => words(s, sid, ["Blue."]) }, { prompt: "Another?", sessionId: "s-a" });
  await second.done;
  assert.deepEqual(
    second.events.filter((e) => e.type === "checkpoint"),
    [{ type: "checkpoint", at: "4" }],
  );

  // Back to after the first turn: a new session that knows only that turn.
  const fork = runWith(
    { prompt: (s, sid) => words(s, sid, ["Green."]) },
    { prompt: "One more?", sessionId: "s-a", resumeAt: "2" },
    undefined,
    "s-b",
  );
  assert.deepEqual(await fork.done, { status: "finished", sessionId: "s-b" });
  assert.ok(!fork.server.requests.some((q) => q.method === "session/load"), "the original isn't loaded");
  const text = promptText(fork.server);
  assert.equal(
    text,
    firstPrompt(
      "Be brief.",
      [
        { role: "user", text: "Pick a color." },
        { role: "assistant", text: "Red.", toolCalls: [] },
      ],
      "One more?",
    ),
  );
  assert.match(
    text,
    /<earlier_conversation>\nUser: Pick a color\.\n\nYou: Red\.\n<\/earlier_conversation>\n\nOne more\?$/,
  );
  assert.doesNotMatch(text, /Another/);

  // The original still holds both turns.
  const again = runWith(
    { prompt: (s, sid) => words(s, sid, ["Ok."]) },
    { prompt: "Go on.", sessionId: "s-a", resumeAt: "4" },
    undefined,
    "s-c",
  );
  await again.done;
  assert.match(promptText(again.server), /User: Another\?\n\nYou: Blue\./);
  assert.equal((await runWith(SCRIPTS.reply, { sessionId: "s-a", resumeAt: "x" }).done).status, "failed");
});

test("cursor: npm's Windows shim starts through the shell with plain arguments only", () => {
  const dir = mkdtempSync(join(tmpdir(), "shim-"));
  try {
    const shim = join(dir, "cursor-agent.cmd");
    writeFileSync(shim, "@echo off");
    const spec = launchSpec(shim, ["acp", "notify=[]", "mcp_servers.paper.enabled=false"]);
    if (process.platform === "win32") {
      assert.deepEqual(spec, {
        file: `"${shim}" acp notify=[] mcp_servers.paper.enabled=false`,
        args: [],
        shell: true,
      });
      assert.throws(() => launchSpec(shim, ["acp & calc"]), /can't be passed through the shell/);
      const odd = join(dir, "100%tools");
      mkdirSync(odd);
      writeFileSync(join(odd, "cursor-agent.cmd"), "@echo off");
      assert.throws(() => launchSpec(join(odd, "cursor-agent.cmd"), ["acp"]), /Windows shell would change/);
    } else {
      assert.equal(spec.shell, false, "only Windows needs a shell for it");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cursor: Stop while a setup step hangs still ends the run promptly", async () => {
  class SilentLoad extends ScriptedAcp {
    override send(line: string): void {
      if ((JSON.parse(line) as Json).method === "session/load") return; // never answered, like a stuck replay
      super.send(line);
    }
  }
  const server = new SilentLoad(SCRIPTS.reply);
  const controller = new AbortController();
  const events: ProviderEvent[] = [];
  let resolved = false;
  const done = new CursorProvider({ homeDir: HOME, connect: async () => server, stopGraceMs: 100 }).run(
    {
      botId: "b",
      botName: "B",
      prompt: "hi",
      workspaceDir: tmpdir(),
      instructions: "",
      signal: controller.signal,
      sessionId: "s-stuck",
    },
    {
      emit: (e) => {
        assert.equal(resolved, false, `no "${e.type}" after the run ended`);
        events.push(e);
      },
      requestApproval: async () => ({ allow: true }),
    },
  );
  await sleep(30);
  const stoppedAt = Date.now();
  controller.abort();
  const outcome = await done;
  resolved = true;
  assert.equal(outcome.status, "interrupted");
  assert.ok(Date.now() - stoppedAt < 1000, "within the grace period");
  assert.equal(server.closed, true);
});

test("cursor: a turn stopped after the grace period is still logged, so a later fork keeps it", async () => {
  // Cursor never answers the cancel: the grace timer ends the run.
  class IgnoresCancel extends ScriptedAcp {
    override send(line: string): void {
      if ((JSON.parse(line) as Json).method === "session/cancel") return;
      super.send(line);
    }
  }
  const server = new IgnoresCancel(
    {
      prompt: async (s, sid) => {
        chunk(s, sid, "Halfway");
        return new Promise(() => {});
      },
    },
    "s-cut",
  );
  const controller = new AbortController();
  const events: ProviderEvent[] = [];
  const done = new CursorProvider({ homeDir: HOME, connect: async () => server, stopGraceMs: 100 }).run(
    { botId: "b", botName: "B", prompt: "Start.", workspaceDir: tmpdir(), instructions: "", signal: controller.signal },
    { emit: (e) => events.push(e), requestApproval: async () => ({ allow: true }) },
  );
  await sleep(50);
  controller.abort();
  assert.equal((await done).status, "interrupted");
  assert.deepEqual(
    events.filter((e) => e.type === "checkpoint"),
    [{ type: "checkpoint", at: "2" }],
  );
  const fork = runWith(SCRIPTS.reply, { prompt: "Go on.", sessionId: "s-cut", resumeAt: "2" }, undefined, "s-cut2");
  await fork.done;
  assert.match(promptText(fork.server), /User: Start\.\n\nYou: Halfway/);
});

test("cursor: think calls never show, updates keep their call's kind, and a repeated end is one step", async () => {
  const r = runWith({
    prompt: async (s, sid) => {
      s.update(sid, {
        sessionUpdate: "tool_call",
        toolCallId: "k1",
        title: "Thinking",
        kind: "think",
        status: "pending",
      });
      s.update(sid, { sessionUpdate: "tool_call_update", toolCallId: "k1", status: "completed" });
      s.update(sid, { sessionUpdate: "tool_call", toolCallId: "e1", title: "ls", kind: "execute", status: "pending" });
      s.update(sid, { sessionUpdate: "tool_call_update", toolCallId: "e1", status: "completed" });
      s.update(sid, { sessionUpdate: "tool_call_update", toolCallId: "e1", status: "completed" });
      s.update(sid, {
        sessionUpdate: "tool_call",
        toolCallId: "c1",
        title: "odd",
        kind: "constructor",
        status: "completed",
      });
      await sleep(5);
      return "end_turn";
    },
  });
  await r.done;
  assert.deepEqual(
    r.events.filter((e) => e.type === "tool_start" || e.type === "tool_end"),
    [
      { type: "tool_start", toolUseId: "e1", tool: "Bash", summary: "ls" },
      { type: "tool_end", toolUseId: "e1", ok: true },
      { type: "tool_start", toolUseId: "c1", tool: "constructor", summary: "odd" },
      { type: "tool_end", toolUseId: "c1", ok: true },
    ],
  );
});

test("cursor: on macOS the sign-in is linked, and a refreshed copy is moved back over the user's own", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cursor-mac-"));
  try {
    const realHome = join(root, "me");
    const home = join(root, "bots");
    mkdirSync(join(realHome, ".cursor"), { recursive: true });
    writeFileSync(join(realHome, ".cursor", "auth.json"), "old");
    try {
      prepareHome(home, "darwin", realHome);
    } catch (err) {
      // Windows without symlink rights: the macOS path can't be exercised here.
      if ((err as NodeJS.ErrnoException).code === "EPERM") return t.skip("no symlink rights");
      throw err;
    }
    const link = join(home, ".cursor", "auth.json");
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    // Cursor refreshes the sign-in by writing a new file in the link's place.
    rmSync(link);
    writeFileSync(link, "new");
    prepareHome(home, "darwin", realHome);
    assert.equal(lstatSync(link).isSymbolicLink(), true, "linked again");
    assert.equal(
      readFileSync(join(realHome, ".cursor", "auth.json"), "utf8"),
      "new",
      "the newer sign-in is the user's",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
