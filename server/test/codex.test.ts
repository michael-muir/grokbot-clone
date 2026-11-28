// Codex (#25): the provider contract and Codex's own behavior, on a scripted app-server that speaks the protocol.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { type CodexConnection, CodexProvider, codexArgs, findExecutable } from "../src/providers/codex.ts";
import type { ProviderEvent, RunCallbacks, RunRequest } from "../src/types.ts";
import { type ContractScenario, describeProviderContract } from "./contract/provider-contract.ts";

type Json = Record<string, unknown>;

interface Script {
  /** What a turn does: send notifications, ask for approvals (awaiting the answer), end the turn. */
  turn(server: ScriptedServer, threadId: string, turnId: string, prompt: string): Promise<void>;
}

/** A scripted `codex app-server`: answers setup requests, records what it was sent, and runs a turn script. */
class ScriptedServer implements CodexConnection {
  readonly requests: { method: string; params: Json }[] = [];
  readonly answers = new Map<number, unknown>();
  private lineFns: ((line: string) => void)[] = [];
  private exitFns: ((detail: string) => void)[] = [];
  private nextServerId = 1000;
  private waiting = new Map<number, (result: unknown) => void>();
  interrupted = false;
  closed = false;
  private readonly script: Script;
  private turnSeq = 0;

  constructor(script: Script) {
    this.script = script;
  }

  send(line: string): void {
    const msg = JSON.parse(line) as Json;
    if (typeof msg.method !== "string") {
      // An answer to one of our requests (an approval).
      const id = Number(msg.id);
      this.answers.set(id, msg.result ?? msg.error);
      this.waiting.get(id)?.(msg.result ?? { error: msg.error });
      return;
    }
    const params = (msg.params ?? {}) as Json;
    this.requests.push({ method: msg.method, params });
    if (msg.id === undefined) return;
    const reply = (result: unknown) => this.emit({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
      case "initialize":
        reply({ userAgent: "scripted" });
        return;
      case "thread/start":
        reply({ thread: { id: "thread-new" } });
        return;
      case "thread/resume":
        // Like Codex: a resumed thread replays its last turn's usage before the new turn starts.
        this.notify("thread/tokenUsage/updated", {
          threadId: params.threadId,
          turnId: "turn-old",
          tokenUsage: { last: { inputTokens: 5000, outputTokens: 50 } },
        });
        reply({ thread: { id: params.threadId } });
        return;
      case "thread/fork":
        reply({ thread: { id: `${String(params.threadId)}-fork` } });
        return;
      case "model/list":
        reply({ data: [{ id: "gpt-a" }, { id: "gpt-hidden", hidden: true }, { id: "gpt-b" }] });
        return;
      case "turn/start": {
        const turnId = `turn-${++this.turnSeq}`;
        reply({ turn: { id: turnId, status: "inProgress" } });
        const input = (params.input as Json[] | undefined)?.[0];
        void this.script.turn(this, String(params.threadId), turnId, String(input?.text ?? ""));
        return;
      }
      case "turn/interrupt":
        this.interrupted = true;
        reply({});
        this.notify("turn/completed", {
          threadId: params.threadId,
          turn: { id: params.turnId, status: "interrupted", error: null },
        });
        return;
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
  notify(method: string, params: Json): void {
    this.emit({ jsonrpc: "2.0", method, params });
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

/** A reply streamed in words, then completed, with usage, then the turn's end. */
async function reply(s: ScriptedServer, threadId: string, turnId: string, words: string[], delayMs = 1) {
  for (const [i, w] of words.entries()) {
    if (s.interrupted) return;
    await sleep(delayMs);
    if (s.interrupted) return;
    s.notify("item/agentMessage/delta", { threadId, turnId, itemId: "msg-1", delta: (i ? " " : "") + w });
  }
  s.notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: "msg-1", text: words.join(" ") } });
  s.notify("thread/tokenUsage/updated", {
    threadId,
    turnId,
    tokenUsage: { last: { inputTokens: 100, outputTokens: 7 }, total: { inputTokens: 999, outputTokens: 99 } },
  });
  s.notify("turn/completed", { threadId, turn: { id: turnId, status: "completed", error: null } });
}

const SCRIPTS: Record<ContractScenario, Script> = {
  reply: { turn: (s, t, turn) => reply(s, t, turn, ["Hi", "there."]) },
  slow: { turn: (s, t, turn) => reply(s, t, turn, ["one", "two", "three", "four", "five", "six"], 200) },
  fail: {
    turn: async (s, t, turn) => {
      s.notify("turn/completed", {
        threadId: t,
        turn: { id: turn, status: "failed", error: { message: "Scripted failure." } },
      });
    },
  },
  tool: {
    turn: async (s, t, turn) => {
      const answer = (await s.ask("item/commandExecution/requestApproval", {
        threadId: t,
        turnId: turn,
        itemId: "cmd-1",
        command: "echo hello",
        cwd: ".",
      })) as Json;
      const accepted = answer.decision === "accept";
      if (answer.decision === "cancel") return;
      s.notify("item/started", {
        threadId: t,
        turnId: turn,
        item: { type: "commandExecution", id: "cmd-1", command: "echo hello", status: "inProgress" },
      });
      s.notify("item/completed", {
        threadId: t,
        turnId: turn,
        item: {
          type: "commandExecution",
          id: "cmd-1",
          command: "echo hello",
          status: accepted ? "completed" : "declined",
          exitCode: accepted ? 0 : null,
        },
      });
      await reply(s, t, turn, [accepted ? "Done." : "Okay, skipped."]);
    },
  },
};

describeProviderContract("codex", {
  create: (scenario) =>
    new CodexProvider({ connect: async () => new ScriptedServer(SCRIPTS[scenario]), stopGraceMs: 300 }),
});

// ---------- Codex specifics

function runWith(
  script: Script,
  extra: Partial<RunRequest> = {},
  answer: RunCallbacks["requestApproval"] = async () => ({ allow: true }),
) {
  const server = new ScriptedServer(script);
  const events: ProviderEvent[] = [];
  const asked: string[] = [];
  const provider = new CodexProvider({ connect: async () => server, stopGraceMs: 300 });
  const controller = new AbortController();
  const done = provider.run(
    {
      botId: "b",
      botName: "B",
      prompt: "hello",
      workspaceDir: "/work",
      instructions: "Be brief.",
      signal: controller.signal,
      ...extra,
    },
    {
      emit: (e) => events.push(e),
      requestApproval: async (r, s) => {
        asked.push(r.summary);
        return answer(r, s);
      },
    },
  );
  return { server, events, asked, done, controller };
}

test("codex: a new run starts a thread in the bot's workspace, untrusted and sandboxed, and reports usage and a checkpoint", async () => {
  const r = runWith(SCRIPTS.reply);
  const outcome = await r.done;
  assert.equal(outcome.status, "finished");
  assert.equal(outcome.sessionId, "thread-new");
  const start = r.server.requests.find((q) => q.method === "thread/start")?.params;
  assert.deepEqual(
    {
      cwd: start?.cwd,
      approvalPolicy: start?.approvalPolicy,
      sandbox: start?.sandbox,
      dev: start?.developerInstructions,
    },
    { cwd: "/work", approvalPolicy: "untrusted", sandbox: "workspace-write", dev: "Be brief." },
  );
  assert.deepEqual(
    r.events.filter((e) => e.type === "usage" || e.type === "checkpoint"),
    [
      { type: "usage", inputTokens: 100, outputTokens: 7 },
      { type: "checkpoint", at: "turn-1" },
    ],
  );
  assert.equal(r.server.closed, true, "the process is closed when the run ends");
});

test("codex: a session resumes its thread, and resumeAt forks it at that turn", async () => {
  const resumed = runWith(SCRIPTS.reply, { sessionId: "thread-7" });
  assert.equal((await resumed.done).sessionId, "thread-7");
  assert.ok(resumed.server.requests.some((q) => q.method === "thread/resume" && q.params.threadId === "thread-7"));
  assert.deepEqual(
    resumed.events.filter((e) => e.type === "usage"),
    [{ type: "usage", inputTokens: 100, outputTokens: 7 }],
    "the replayed usage of an earlier turn isn't counted again",
  );
  const forked = runWith(SCRIPTS.reply, { sessionId: "thread-7", resumeAt: "turn-3" });
  assert.equal((await forked.done).sessionId, "thread-7-fork");
  const fork = forked.server.requests.find((q) => q.method === "thread/fork")?.params;
  assert.deepEqual([fork?.threadId, fork?.lastTurnId], ["thread-7", "turn-3"]);
});

test("codex: approvals become cards, a denial declines, and Stop during one cancels", async () => {
  const allowed = runWith(SCRIPTS.tool);
  await allowed.done;
  assert.deepEqual(allowed.asked, ["Running echo hello"]);
  assert.deepEqual([...allowed.server.answers.values()], [{ decision: "accept" }]);

  const denied = runWith(SCRIPTS.tool, {}, async () => ({ allow: false, reason: "no" }));
  await denied.done;
  assert.deepEqual([...denied.server.answers.values()], [{ decision: "decline" }]);

  let stop: () => void = () => {};
  const stopped = runWith(SCRIPTS.tool, {}, (_r, signal) => {
    const answer = new Promise<{ allow: false; reason: string }>((resolve) =>
      signal.addEventListener("abort", () => resolve({ allow: false, reason: "The run was stopped." }), { once: true }),
    );
    stop(); // The user presses Stop while the card is waiting.
    return answer;
  });
  stop = () => stopped.controller.abort();
  const outcome = await stopped.done;
  assert.equal(outcome.status, "interrupted");
  await sleep(20);
  assert.deepEqual([...stopped.server.answers.values()], [{ decision: "cancel" }]);
  assert.equal(stopped.server.interrupted, true, "the turn was interrupted");
});

test("codex: an unexpected exit fails the run with what Codex said; unsupported requests get an error", async () => {
  const dying = runWith({ turn: async (s) => s.die("Not signed in. Run codex login.") });
  const outcome = await dying.done;
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error ?? "", /Not signed in/);

  const asking = runWith({
    turn: async (s, t, turn) => {
      const answer = await s.ask("item/tool/requestUserInput", { threadId: t, turnId: turn });
      assert.ok((answer as Json).error, "an error, not a made-up answer");
      await reply(s, t, turn, ["Fine."]);
    },
  });
  assert.equal((await asking.done).status, "finished");
});

test("codex: listModels lists the signed-in Codex's visible models", async () => {
  const provider = new CodexProvider({ connect: async () => new ScriptedServer(SCRIPTS.reply) });
  assert.deepEqual(await provider.listModels(new AbortController().signal), ["gpt-a", "gpt-b"]);
});

test("codex: every run switches off plugins, hooks, the notify program and the user's MCP servers", () => {
  const args = codexArgs(["paper", "node_repl", "bad name;rm"]);
  for (const f of ["plugins", "apps", "computer_use", "browser_use", "hooks"]) {
    assert.ok(args.join(" ").includes(`--disable ${f}`), f);
  }
  assert.ok(args.includes("notify=[]"));
  assert.ok(args.includes("mcp_servers.paper.enabled=false"));
  assert.ok(args.includes("mcp_servers.node_repl.enabled=false"));
  assert.ok(!args.join(" ").includes("bad name"), "a name that isn't a plain word is never passed on");
});

test("codex: Codex counts as set up only when its executable is found", () => {
  const dir = join("tools", "bin");
  const exe = join(dir, process.platform === "win32" ? "codex.exe" : "codex");
  const exists = (p: string) => p === exe;
  assert.equal(findExecutable("codex", { PATH: dir, PATHEXT: ".EXE" }, exists), exe);
  assert.equal(findExecutable("codex", { PATH: join("elsewhere") }, exists), undefined);
  assert.equal(findExecutable(exe, {}, exists), exe, "a path is checked as it is");
  assert.equal(new CodexProvider({ command: join("no", "such", "codex") }).info().configured, false);
});
