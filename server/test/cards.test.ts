// Cards (#19): the rules, the gateway's waiting and locking, the HTTP route, and the card tool in the loop and Claude.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { LoopProvider } from "../src/agent/loop.ts";
import { SessionStore } from "../src/agent/sessions.ts";
import { BotRegistry } from "../src/bots.ts";
import { CardRequestError, checkCardAnswer, describeAnswer, parseCardRequest } from "../src/cards.ts";
import { LocalFolderComputers } from "../src/computer.ts";
import { Gateway } from "../src/gateway.ts";
import { createHttpServer } from "../src/http.ts";
import { Credentials, MemoryKeyStore } from "../src/keys.ts";
import { ClaudeProvider, type QueryFn } from "../src/providers/claude.ts";
import { SHOW_CARD_TOOL, showCard } from "../src/providers/claude-cards.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import type { ProviderRegistry } from "../src/providers/index.ts";
import { TranscriptStore } from "../src/transcript.ts";
import type {
  AgentProvider,
  CardAnswer,
  CardRequest,
  FormCard,
  ProviderId,
  RunCallbacks,
  TranscriptEntry,
} from "../src/types.ts";
import { Recorder } from "./contract/provider-contract.ts";
import { calls, ScriptedModel, says } from "./support/scripted-model.ts";

const BOTH = ["widget", "form"] as const;
const FORM: FormCard = {
  kind: "form",
  title: "Sign up",
  fields: [
    { name: "name", label: "Name", type: "text", required: true },
    { name: "size", label: "Size", type: "select", options: ["S", "M"] },
    { name: "news", label: "News", type: "checkbox" },
    { name: "notes", label: "Notes", type: "textarea" },
  ],
};

// ---------- rules

test("card rules: a widget and a form are cleaned up; anything else gets a message the model can act on", () => {
  assert.deepEqual(parseCardRequest({ kind: "widget", prompt: " Size? ", options: ["S", " M "] }, BOTH), {
    kind: "widget",
    prompt: "Size?",
    options: [
      { label: "S", value: "S" },
      { label: "M", value: "M" },
    ],
  });
  const form = parseCardRequest(
    {
      kind: "form",
      title: "Sign up",
      fields: [
        { name: "name", label: "Name", type: "text", required: true, placeholder: "Ada" },
        { name: "news", label: "News", type: "checkbox", required: true },
      ],
      submit_label: "Go",
    },
    BOTH,
  );
  assert.deepEqual(form, {
    kind: "form",
    title: "Sign up",
    fields: [
      { name: "name", label: "Name", type: "text", required: true, placeholder: "Ada" },
      { name: "news", label: "News", type: "checkbox" },
    ],
    submitLabel: "Go",
  });

  const refused = (input: unknown, kinds: readonly ("widget" | "form")[] = BOTH) =>
    assert.throws(() => parseCardRequest(input, kinds), CardRequestError);
  refused({ kind: "poll" });
  refused({ kind: "widget", prompt: "Size?", options: ["S"] });
  refused({ kind: "widget", prompt: "Size?", options: ["S", "S"] });
  refused({ kind: "form", title: "x", fields: [] });
  refused({ kind: "form", title: "x", fields: [{ name: "1st", label: "A", type: "text" }] });
  refused({ kind: "form", title: "x", fields: [{ name: "a", label: "A", type: "date" }] });
  refused({ kind: "form", title: "x", fields: [{ name: "a", label: "A", type: "select", options: ["one"] }] });
  refused({
    kind: "form",
    title: "x",
    fields: [
      { name: "a", label: "A", type: "text" },
      { name: "a", label: "B", type: "text" },
    ],
  });
  assert.throws(
    () => parseCardRequest({ kind: "form", title: "x", fields: [{ name: "a", label: "A", type: "text" }] }, ["widget"]),
    /can't show form cards\. Ask in plain text instead/,
  );
});

test("card rules: an answer must fit its card exactly", () => {
  const widget = parseCardRequest({ kind: "widget", prompt: "Size?", options: ["S", "M"] }, BOTH);
  assert.deepEqual(checkCardAnswer(widget, { kind: "widget", value: "M" }), {
    ok: true,
    answer: { kind: "widget", value: "M" },
  });
  assert.equal(checkCardAnswer(widget, { kind: "widget", value: "XL" }).ok, false);
  assert.equal(checkCardAnswer(widget, { kind: "form", values: {} }).ok, false);

  assert.deepEqual(checkCardAnswer(FORM, { kind: "form", values: { name: " Ada ", size: "M", news: true } }), {
    ok: true,
    answer: { kind: "form", values: { name: "Ada", size: "M", news: true, notes: "" } },
  });
  const why = (values: unknown) => {
    const r = checkCardAnswer(FORM, { kind: "form", values });
    return r.ok ? "" : r.error;
  };
  assert.match(why({ name: "" }), /Name" is required/);
  assert.match(why({ name: "Ada", size: "XL" }), /choices for "Size"/);
  assert.match(why({ name: "Ada", news: "yes" }), /on or off/);
  assert.match(why({ name: "Ada", extra: "x" }), /fields the form doesn't/);
  assert.match(why({ name: "x".repeat(2001) }), /too long/);
  assert.equal(why({ name: "Ada", notes: "x".repeat(10_000) }), "", "a textarea takes more");
});

test("card rules: the model reads the pick, or one line per field", () => {
  const widget = parseCardRequest({ kind: "widget", prompt: "Size?", options: ["S", "M"] }, BOTH);
  assert.equal(describeAnswer(widget, { kind: "widget", value: "S" }), "The user picked: S");
  assert.equal(
    describeAnswer(FORM, { kind: "form", values: { name: "Ada", size: "", news: false, notes: "" } }),
    "The user filled in the form:\n- Name (name): Ada\n- Size (size): (left empty)\n- News (news): no\n- Notes (notes): (left empty)",
  );
});

// ---------- gateway

function setup(provider: AgentProvider = new FakeProvider(1)) {
  const dir = mkdtempSync(join(tmpdir(), "smarty-cards-"));
  const bots = new BotRegistry(dir, [
    { id: "nova", name: "Nova", provider: "fake", avatar: { shape: "star", color: "purple" } },
  ]);
  const store = new TranscriptStore(dir);
  const providers: ProviderRegistry = new Map<ProviderId, AgentProvider>([["fake", provider]]);
  const gateway = new Gateway(bots, store, providers, new LocalFolderComputers(dir));
  return { dir, bots, store, gateway, providers, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function until<T>(get: () => T | undefined, ms = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = get();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const pendingCard = (store: TranscriptStore) =>
  store.list("nova").find((e) => e.body.kind === "card" && e.body.state === "pending");
const cardBody = (e: TranscriptEntry | undefined) => (e?.body.kind === "card" ? e.body : undefined);

test("cards: a widget card is posted pending, answered, and locked with its answer; the answer reaches the same run", async () => {
  const t = setup();
  try {
    const { done } = await t.gateway.sendMessage("nova", "/widget", undefined, undefined, BOTH);
    const card = await until(() => pendingCard(t.store));
    assert.deepEqual(t.gateway.answerCard("nova", card.id, { kind: "widget", value: "XL" }), {
      result: "invalid",
      error: "Pick one of the options.",
    });
    assert.deepEqual(t.gateway.answerCard("nova", card.id, { kind: "widget", value: "Medium" }), { result: "ok" });
    await done;
    const after = t.store.get("nova", card.id);
    assert.deepEqual(cardBody(after)?.state, "answered");
    assert.deepEqual(cardBody(after)?.answer, { kind: "widget", value: "Medium" });
    assert.deepEqual(t.gateway.answerCard("nova", card.id, { kind: "widget", value: "Small" }), {
      result: "not-pending",
    });
    const reply = t.store.list("nova").find((e) => e.body.kind === "assistant_text");
    assert.equal(reply?.body.kind === "assistant_text" && reply.body.text, 'Got it: "Medium"');
    assert.equal(reply?.runId, card.runId, "the reply comes in the run that asked");
    const runs = t.store.list("nova").filter((e) => e.body.kind === "run");
    assert.equal(runs.length, 1);
  } finally {
    t.cleanup();
  }
});

test("cards: a form answer is checked, then locked with the cleaned values", async () => {
  const t = setup();
  try {
    const { done } = await t.gateway.sendMessage("nova", "/form", undefined, undefined, BOTH);
    const card = await until(() => pendingCard(t.store));
    const r = t.gateway.answerCard("nova", card.id, { kind: "form", values: { subscribe: true } });
    assert.equal(r.result, "invalid");
    assert.deepEqual(
      t.gateway.answerCard("nova", card.id, { kind: "form", values: { name: " Ada ", subscribe: true } }),
      {
        result: "ok",
      },
    );
    await done;
    assert.deepEqual(cardBody(t.store.get("nova", card.id))?.answer, {
      kind: "form",
      values: { name: "Ada", subscribe: true },
    });
  } finally {
    t.cleanup();
  }
});

test("cards: a run stopped while a card waits leaves it expired", async () => {
  const t = setup();
  try {
    const { done } = await t.gateway.sendMessage("nova", "/widget", undefined, undefined, BOTH);
    const card = await until(() => pendingCard(t.store));
    t.gateway.interrupt("nova");
    await done;
    assert.equal(cardBody(t.store.get("nova", card.id))?.state, "expired");
    assert.equal(t.gateway.answerCard("nova", card.id, { kind: "widget", value: "Small" }).result, "not-pending");
  } finally {
    t.cleanup();
  }
});

test("cards: a card left pending by a crash is expired on startup", () => {
  const t = setup();
  try {
    const card: CardRequest = { kind: "widget", prompt: "Size?", options: [{ label: "S", value: "S" }] };
    const e = t.store.append("nova", { kind: "card", card, state: "pending" });
    new Gateway(t.bots, t.store, t.providers, new LocalFolderComputers(t.dir));
    assert.equal(cardBody(t.store.get("nova", e.id))?.state, "expired");
  } finally {
    t.cleanup();
  }
});

test("cards: without card kinds the bot asks in plain text, and a kind the client didn't declare is refused", async () => {
  const t = setup();
  try {
    const { done } = await t.gateway.sendMessage("nova", "/form", undefined, undefined, ["widget"]);
    await done;
    const kinds = t.store.list("nova").map((e) => e.body.kind);
    assert.ok(!kinds.includes("card"), "no form card for a client that can't show one");
    const reply = t.store.list("nova").find((e) => e.body.kind === "assistant_text");
    assert.equal(reply?.body.kind === "assistant_text" && reply.body.text, "What's your name?");
  } finally {
    t.cleanup();
  }

  // The gateway's own check, behind the tools': a provider asking anyway gets an error, and no card waits forever.
  let refused = "";
  const pushy: AgentProvider = {
    id: "fake",
    async run(_req, cb) {
      try {
        await cb.requestCard?.({ kind: "form", title: "x", fields: [] }, new AbortController().signal);
      } catch (err) {
        refused = (err as Error).message;
      }
      return { status: "finished" };
    },
  };
  const u = setup(pushy);
  try {
    const { done } = await u.gateway.sendMessage("nova", "hi");
    await done;
    assert.match(refused, /can't show form cards/);
    assert.ok(!u.store.list("nova").some((e) => e.body.kind === "card"));
  } finally {
    u.cleanup();
  }
});

test("http: cards answer 200, 400 with the reason, 404 when not waiting; unknown card kinds are dropped", async () => {
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
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  try {
    assert.equal((await post("/bots/nova/messages", { text: "/widget", cardKinds: ["poll", "widget"] })).status, 202);
    const card = await until(() => pendingCard(t.store));
    assert.deepEqual(await post(`/bots/nova/cards/${card.id}`, { answer: { kind: "widget", value: "XL" } }), {
      status: 400,
      body: { error: "Pick one of the options." },
    });
    assert.equal(
      (await post(`/bots/nova/cards/${card.id}`, { answer: { kind: "widget", value: "Large" } })).status,
      200,
    );
    assert.equal(
      (await post(`/bots/nova/cards/${card.id}`, { answer: { kind: "widget", value: "Large" } })).status,
      404,
    );
    await until(() => (t.gateway.isRunning("nova") ? undefined : true));
  } finally {
    server.closeAllConnections();
    server.close();
    t.cleanup();
  }
});

// ---------- the loop's show_card

test("loop: show_card is offered only with card kinds, and a refused kind tells the model to ask in plain text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "smarty-loopcards-"));
  try {
    const model = new ScriptedModel([
      calls([
        {
          id: "c1",
          name: "show_card",
          input: { kind: "form", title: "x", fields: [{ name: "a", label: "A", type: "text" }] },
        },
      ]),
      says("Okay, in text then."),
      calls([{ id: "c2", name: "show_card", input: { kind: "widget", prompt: "Size?", options: ["S", "M"] } }]),
      says("Thanks."),
      says("Hi."),
    ]);
    const provider = new LoopProvider({ id: "fake", adapter: model, sessions: new SessionStore(dir) });
    const asked: CardRequest[] = [];
    const run = (cardKinds?: ("widget" | "form")[]) => {
      const rec = new Recorder(() => ({ allow: true }));
      const cb: RunCallbacks = {
        emit: (e) => rec.emit(e),
        requestApproval: (r, s) => rec.requestApproval(r, s),
        requestCard: async (card) => {
          asked.push(card);
          return { kind: "widget", value: "M" };
        },
      };
      return provider
        .run(
          {
            botId: "b",
            botName: "B",
            prompt: "go",
            workspaceDir: dir,
            instructions: "",
            signal: new AbortController().signal,
            ...(cardKinds ? { cardKinds } : {}),
          },
          cb,
        )
        .then((outcome) => ({ outcome, rec }));
    };

    await run(["widget"]);
    const offered = (i: number) => model.requests[i]?.tools.map((t) => t.name) ?? [];
    assert.ok(offered(0).includes("show_card"));
    const refusal = model.requests[1]?.messages.find((m) => m.role === "tool");
    assert.match(
      refusal?.role === "tool" ? refusal.output : "",
      /Invalid input: This app can't show form cards\. Ask in plain text instead\./,
    );

    await run(["widget"]);
    assert.equal(asked.length, 1);
    const result = model.requests[3]?.messages.findLast((m) => m.role === "tool");
    assert.equal(result?.role === "tool" && result.output, "The user picked: M");

    await run();
    assert.ok(!offered(4).includes("show_card"), "no card kinds, no card tool");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- Claude's show_card

test("claude: show_card is offered only with card kinds, and answers through requestCard", async () => {
  const seen: Options[] = [];
  const query: QueryFn = async function* ({ options }) {
    seen.push(options);
    yield { type: "system", subtype: "init", session_id: "s" } as never;
    yield { type: "result", subtype: "success", total_cost_usd: 0 } as never;
  };
  const provider = new ClaudeProvider(query, () => "test-key");
  const base = {
    botId: "b",
    botName: "B",
    prompt: "hi",
    workspaceDir: ".",
    instructions: "",
    signal: new AbortController().signal,
  };
  const cb = {
    emit: () => {},
    requestApproval: async () => ({ allow: true as const }),
    requestCard: async (): Promise<CardAnswer> => ({ kind: "widget", value: "M" }),
  };
  await provider.run({ ...base, cardKinds: ["widget"] }, cb);
  await provider.run(base, cb);
  assert.ok(seen[0]?.mcpServers?.smarty, "the card server is there with card kinds");
  assert.ok(seen[0]?.allowedTools?.includes(SHOW_CARD_TOOL), "and the tool needs no approval");
  assert.equal(seen[1]?.mcpServers, undefined, "no card kinds, no card tool");
  assert.ok(!seen[1]?.allowedTools?.includes(SHOW_CARD_TOOL));

  const handler = showCard(["widget"], cb.requestCard, base.signal);
  assert.deepEqual(await handler({ kind: "widget", prompt: "Size?", options: ["S", "M"] }), {
    content: [{ type: "text", text: "The user picked: M" }],
  });
  const refused = await handler({ kind: "form", title: "x", fields: [] });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]?.text ?? "", /Invalid input: This app can't show form cards/);
  const stopped = await showCard(
    ["widget"],
    async () => undefined,
    base.signal,
  )({
    kind: "widget",
    prompt: "Size?",
    options: ["S", "M"],
  });
  assert.equal(stopped.isError, true);
});
