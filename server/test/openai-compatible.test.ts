// Tests for the OpenAI-compatible adapter and presets, against a mock server: the provider contract, wire format,
// streaming details, errors, model choice, and the /providers routes.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { LoopProvider } from "../src/agent/loop.ts";
import type { ChatMessage, ModelEvent, ModelRequest } from "../src/agent/model.ts";
import { OpenAICompatibleAdapter, parseArguments, sseData, toWireMessages } from "../src/agent/openai-compatible.ts";
import { SessionStore } from "../src/agent/sessions.ts";
import type { Tool } from "../src/agent/tools.ts";
import { BotRegistry } from "../src/bots.ts";
import { LocalFolderComputers } from "../src/computer.ts";
import { Gateway } from "../src/gateway.ts";
import { createHttpServer } from "../src/http.ts";
import { ClaudeProvider } from "../src/providers/claude.ts";
import type { ProviderRegistry } from "../src/providers/index.ts";
import { OPENAI_PRESETS, openAICompatibleProvider } from "../src/providers/openai-compatible.ts";
import { TranscriptStore } from "../src/transcript.ts";
import type { AgentProvider, ProviderId } from "../src/types.ts";
import { type ContractScenario, describeProviderContract } from "./contract/provider-contract.ts";
import { chunk, done, MockOpenAI, type RecordedRequest, textReply } from "./support/mock-openai.ts";

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "grokbot-oai-"));
  dirs.push(d);
  return d;
};

const doThing: Tool = {
  spec: { name: "do_thing", description: "Does a thing", inputSchema: { type: "object", properties: {} } },
  readOnly: false,
  summarize: () => "Doing the thing",
  run: async () => ({ ok: true, output: "thing done" }),
};

const lastMessageRole = (r: RecordedRequest) => {
  const messages = (r.body?.messages ?? []) as { role: string }[];
  return messages.at(-1)?.role;
};

// The scenario is the first path segment, so one mock server serves the whole contract suite.
const mock = new MockOpenAI((r) => {
  const scenario = r.path.split("/")[1] as ContractScenario;
  switch (scenario) {
    case "reply":
      return { sse: textReply("Hello from the mock model.") };
    case "slow":
      return { sse: textReply("This answer streams slowly on purpose."), delayMs: 200 };
    case "fail":
      return { status: 500, json: { error: { message: "The mock is down." } } };
    case "tool":
      if (lastMessageRole(r) === "tool") return { sse: textReply("All done.") };
      return {
        sse: [
          chunk({
            tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "do_", arguments: "" } }],
          }),
          chunk({ tool_calls: [{ index: 0, function: { name: "thing", arguments: "{" } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: "}" } }] }),
          done,
        ],
      };
  }
  return { status: 404, json: { error: "unknown" } };
});
let base = "";

before(async () => {
  base = await mock.start();
});
after(async () => {
  await mock.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describeProviderContract("openai-compatible", {
  create: (scenario) =>
    new LoopProvider({
      id: "openai",
      adapter: new OpenAICompatibleAdapter({
        baseUrl: `${base}/${scenario}/v1`,
        apiKey: "sk-test",
        local: false,
        defaultModel: "mock-model",
        streamUsage: true,
      }),
      sessions: new SessionStore(tempDir()),
      tools: [doThing],
    }),
});

// ---------- wire format ----------

test("messages convert to the OpenAI wire format", () => {
  const messages: ChatMessage[] = [
    { role: "user", text: "hi" },
    { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "read_file", input: { path: "a.md" } }] },
    { role: "tool", toolCallId: "c1", name: "read_file", output: "contents", isError: false },
    { role: "assistant", text: "Done.", toolCalls: [] },
  ];
  assert.deepEqual(toWireMessages("Be nice.", messages), [
    { role: "system", content: "Be nice." },
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.md"}' } }],
    },
    { role: "tool", tool_call_id: "c1", content: "contents" },
    { role: "assistant", content: "Done." },
  ]);
});

test("tool arguments that aren't a JSON object become a clear invalid-input note", () => {
  assert.deepEqual(parseArguments('{"a":1}'), { a: 1 });
  assert.deepEqual(parseArguments(""), {});
  assert.match(String(parseArguments("{oops")._invalid_arguments), /not valid JSON/);
  assert.match(String(parseArguments("[1]")._invalid_arguments), /Expected a JSON object/);
});

test("SSE events split anywhere across chunks are reassembled", async () => {
  const text = 'data: {"a":1}\r\n\r\ndata: {"b":\ndata: 2}\n\n: comment\n\ndata: [DONE]\n\n';
  const pieces = [text.slice(0, 7), text.slice(7, 19), text.slice(19, 30), text.slice(30)];
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of pieces) c.enqueue(new TextEncoder().encode(p));
      c.close();
    },
  });
  const out: string[] = [];
  for await (const d of sseData(body)) out.push(d);
  assert.deepEqual(out, ['{"a":1}', '{"b":\n2}', "[DONE]"]);
});

// ---------- the adapter against the mock ----------

async function collect(adapter: OpenAICompatibleAdapter, req: Partial<ModelRequest> = {}, signal?: AbortSignal) {
  const events: ModelEvent[] = [];
  for await (const ev of adapter.stream(
    { system: "sys", messages: [{ role: "user", text: "hi" }], tools: [doThing.spec], ...req },
    signal ?? new AbortController().signal,
  )) {
    events.push(ev);
  }
  return events;
}

const adapterFor = (opts: Partial<ConstructorParameters<typeof OpenAICompatibleAdapter>[0]> = {}) =>
  new OpenAICompatibleAdapter({ baseUrl: `${base}/x/v1`, apiKey: "sk-test", local: false, streamUsage: true, ...opts });

test("the request carries the model, tools, stream options and the key", async () => {
  mock.setScript(() => ({ sse: textReply("ok") }));
  await collect(adapterFor({ defaultModel: "gpt-test" }));
  const r = mock.requests.at(-1);
  assert.equal(r?.path, "/x/v1/chat/completions");
  assert.equal(r?.headers.authorization, "Bearer sk-test");
  assert.equal(r?.body?.model, "gpt-test");
  assert.equal(r?.body?.stream, true);
  assert.deepEqual(r?.body?.stream_options, { include_usage: true });
  assert.deepEqual(r?.body?.tools, [
    {
      type: "function",
      function: { name: "do_thing", description: "Does a thing", parameters: doThing.spec.inputSchema },
    },
  ]);
});

test("interleaved tool call fragments, usage and reasoning are handled", async () => {
  mock.setScript(() => ({
    sse: [
      chunk({ reasoning_content: "thinking hard", content: "Let me check. " }),
      chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "read_file", arguments: '{"pa' } }] }),
      chunk({ tool_calls: [{ index: 1, id: "b", function: { name: "list_files", arguments: "{}" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"x.md"}' } }] }),
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } })}\n\n`,
      done,
    ],
  }));
  const events = await collect(adapterFor({ defaultModel: "m" }));
  assert.deepEqual(events, [
    { type: "text_delta", text: "Let me check. " },
    { type: "tool_call", call: { id: "a", name: "read_file", input: { path: "x.md" } } },
    { type: "tool_call", call: { id: "b", name: "list_files", input: {} } },
    { type: "done", usage: { inputTokens: 12, outputTokens: 5 } },
  ]);
});

test("an API error surfaces the server's message, never the key", async () => {
  mock.setScript(() => ({ status: 401, json: { error: { message: "Incorrect API key provided." } } }));
  await assert.rejects(collect(adapterFor({ defaultModel: "m", apiKey: "sk-very-secret" })), (err: Error) => {
    assert.equal(err.message, "The model server returned 401: Incorrect API key provided.");
    assert.ok(!err.message.includes("sk-very-secret"));
    return true;
  });
});

test("an unreachable server gives a clear error", async () => {
  // Find a free port, then close it, so nothing is listening there.
  const closed = createNetServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
  const { port } = closed.address() as AddressInfo;
  await new Promise<void>((r) => closed.close(() => r()));
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    local: true,
    defaultModel: "m",
    streamUsage: false,
  });
  await assert.rejects(collect(adapter), /Couldn't reach http:\/\/127\.0\.0\.1:\d+\/v1/);
});

test("abort stops the stream at once", async () => {
  mock.setScript(() => ({ sse: textReply("one two three four five six seven eight"), delayMs: 300 }));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  await assert.rejects(collect(adapterFor({ defaultModel: "m" }), {}, controller.signal), { name: "AbortError" });
  assert.ok(Date.now() - started < 1000);
});

test("model choice: bot model, then default, then the first local model; remote needs one", async () => {
  mock.setScript((r) =>
    r.path.endsWith("/models")
      ? { status: 200, json: { data: [{ id: "zeta" }, { id: "alpha" }] } }
      : { sse: textReply("ok") },
  );
  const model = () => mock.requests.filter((r) => r.path.endsWith("/chat/completions")).at(-1)?.body?.model;

  await collect(adapterFor({ defaultModel: "default-m" }), { model: "bot-m" });
  assert.equal(model(), "bot-m");
  await collect(adapterFor({ defaultModel: "default-m" }));
  assert.equal(model(), "default-m");
  const local = adapterFor({ local: true, apiKey: undefined, streamUsage: false });
  await collect(local);
  assert.equal(model(), "zeta", "the first model in the server's own order");
  assert.equal(mock.requests.at(-1)?.headers.authorization, undefined, "local servers get no key");
  assert.equal(mock.requests.at(-1)?.body?.stream_options, undefined);
  await assert.rejects(collect(adapterFor()), /Choose a model for this bot/);
  assert.deepEqual(await local.listModels(new AbortController().signal), ["alpha", "zeta"], "sorted for display");

  // Models installed or removed later are picked up without a restart.
  mock.setScript((r) =>
    r.path.endsWith("/models") ? { status: 200, json: { data: [{ id: "newer" }] } } : { sse: textReply("ok") },
  );
  await collect(local);
  assert.equal(model(), "newer");
});

test("a remote preset without its key says which variable to set", async () => {
  const provider = openAICompatibleProvider(
    OPENAI_PRESETS.find((p) => p.id === "openai") ?? OPENAI_PRESETS[0],
    new SessionStore(tempDir()),
    { OPENAI_MODEL: "m" },
  );
  assert.equal(provider.info().configured, false);
  const events = await collect(
    new OpenAICompatibleAdapter({
      baseUrl: base,
      local: false,
      keyEnv: "OPENAI_API_KEY",
      defaultModel: "m",
      streamUsage: true,
    }),
  ).catch((err: Error) => err.message);
  assert.equal(events, "Set OPENAI_API_KEY (or switch this bot to another provider).");
});

// ---------- the /providers routes ----------

test("GET /providers lists every provider; GET /providers/:id/models lists models or explains why not", async () => {
  mock.setScript((r) =>
    r.path === "/ollama/v1/models"
      ? { status: 200, json: { data: [{ id: "llama3.1" }, { id: "qwen" }] } }
      : { status: 500, json: {} },
  );
  const dataDir = tempDir();
  const sessions = new SessionStore(dataDir);
  const env = {
    OLLAMA_BASE_URL: `${base}/ollama/v1`,
    LMSTUDIO_BASE_URL: "http://127.0.0.1:1/v1",
    XAI_API_KEY: "xai-key",
  };
  const providers: ProviderRegistry = new Map<ProviderId, AgentProvider>([
    ["claude", new ClaudeProvider()],
    ...OPENAI_PRESETS.map((p) => [p.id, openAICompatibleProvider(p, sessions, env)] as const),
  ]);
  const bots = new BotRegistry(dataDir, []);
  const store = new TranscriptStore(dataDir);
  const gateway = new Gateway(bots, store, providers, new LocalFolderComputers(dataDir));
  const server = createHttpServer({ gateway, bots, store, providers });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const list = (await (await fetch(`${url}/providers`)).json()) as {
      id: string;
      configured: boolean;
      local: boolean;
    }[];
    assert.deepEqual(
      list.map((p) => p.id),
      ["claude", "openai", "xai", "openrouter", "ollama", "lmstudio"],
    );
    const byId = Object.fromEntries(list.map((p) => [p.id, p]));
    assert.equal(byId.xai?.configured, true);
    assert.equal(byId.openai?.configured, false);
    assert.equal(byId.ollama?.local, true);

    const models = await fetch(`${url}/providers/ollama/models`);
    assert.equal(models.status, 200);
    assert.deepEqual(await models.json(), { models: ["llama3.1", "qwen"] });

    const unreachable = await fetch(`${url}/providers/lmstudio/models`);
    assert.equal(unreachable.status, 502);
    assert.match(((await unreachable.json()) as { error: string }).error, /Couldn't reach/);

    assert.equal((await fetch(`${url}/providers/claude/models`)).status, 404);
    assert.equal((await fetch(`${url}/providers/nope/models`)).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("an error reported inside the stream fails the turn", async () => {
  mock.setScript(() => ({
    sse: [
      chunk({ content: "Partial" }),
      `data: ${JSON.stringify({ error: { message: "Provider returned error" } })}\n\n`,
      done,
    ],
  }));
  await assert.rejects(
    collect(adapterFor({ defaultModel: "m" })),
    /The model server reported an error: Provider returned error/,
  );
});

test("tool names resent in every fragment aren't doubled, and fragments without an index are joined", async () => {
  mock.setScript(() => ({
    sse: [
      chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "read_file", arguments: '{"pa' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { name: "read_file", arguments: 'th":"x.md"}' } }] }),
      chunk({ tool_calls: [{ id: "b", function: { name: "write_file", arguments: '{"path":"y",' } }] }),
      chunk({ tool_calls: [{ function: { arguments: '"content":"hi"}' } }] }),
      chunk({ tool_calls: [{ id: "c", function: { name: "list_files", arguments: "{}" } }] }),
      done,
    ],
  }));
  const calls = (await collect(adapterFor({ defaultModel: "m" }))).filter((e) => e.type === "tool_call");
  assert.deepEqual(
    calls.map((e) => (e.type === "tool_call" ? e.call : undefined)),
    [
      { id: "a", name: "read_file", input: { path: "x.md" } },
      { id: "b", name: "write_file", input: { path: "y", content: "hi" } },
      { id: "c", name: "list_files", input: {} },
    ],
  );
});
