// Tests for the Gemini adapter against a mock server: the provider contract, request shape, thought signatures,
// safety and errors, paging through models, and missing key or model.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { GeminiAdapter, toGeminiContents } from "../src/agent/gemini.ts";
import { LoopProvider } from "../src/agent/loop.ts";
import type { ChatMessage, ModelEvent, ModelRequest } from "../src/agent/model.ts";
import { SessionStore } from "../src/agent/sessions.ts";
import type { Tool } from "../src/agent/tools.ts";
import { geminiProvider } from "../src/providers/gemini.ts";
import { type ContractScenario, describeProviderContract } from "./contract/provider-contract.ts";
import { MockOpenAI, type RecordedRequest } from "./support/mock-openai.ts";

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "grokbot-gemini-"));
  dirs.push(d);
  return d;
};

const event = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`;
const parts = (...p: unknown[]) => event({ candidates: [{ content: { role: "model", parts: p } }] });
const textReply = (text: string) => [
  ...text.split(" ").map((w, i) => parts({ text: (i ? " " : "") + w })),
  event({ candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 } }),
];

const doThing: Tool = {
  spec: { name: "do_thing", description: "Does a thing", inputSchema: { type: "object", properties: {} } },
  readOnly: false,
  summarize: () => "Doing the thing",
  run: async () => ({ ok: true, output: "thing done" }),
};

const lastContentHasResponse = (r: RecordedRequest) => {
  const contents = (r.body?.contents ?? []) as { parts: { functionResponse?: unknown }[] }[];
  return Boolean(contents.at(-1)?.parts.some((p) => p.functionResponse));
};

const mock = new MockOpenAI((r) => {
  const scenario = r.path.split("/")[1] as ContractScenario;
  switch (scenario) {
    case "reply":
      return { sse: textReply("Hello from mock Gemini.") };
    case "slow":
      return { sse: textReply("This answer streams slowly on purpose."), delayMs: 200 };
    case "fail":
      return { status: 503, json: { error: { code: 503, message: "The model is overloaded." } } };
    case "tool":
      if (lastContentHasResponse(r)) return { sse: textReply("All done.") };
      return { sse: [parts({ functionCall: { name: "do_thing", args: {} }, thoughtSignature: "sig-1" })] };
  }
  return { status: 404, json: { error: { message: "unknown" } } };
});
let base = "";

before(async () => {
  base = await mock.start();
});
after(async () => {
  await mock.stop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describeProviderContract("gemini", {
  create: (scenario) =>
    new LoopProvider({
      id: "gemini",
      adapter: new GeminiAdapter({
        baseUrl: `${base}/${scenario}/v1beta`,
        apiKey: "g-key",
        defaultModel: "gemini-test",
      }),
      sessions: new SessionStore(tempDir()),
      tools: [doThing],
    }),
});

// ---------- request shape ----------

test("history converts to Gemini contents, with results of one step in one user turn", () => {
  const messages: ChatMessage[] = [
    { role: "user", text: "hi" },
    {
      role: "assistant",
      text: "Checking.",
      toolCalls: [
        { id: "a", name: "read_file", input: { path: "x" }, meta: { geminiId: "g1", thoughtSignature: "sig" } },
        { id: "b", name: "list_files", input: {} },
      ],
    },
    { role: "tool", toolCallId: "a", name: "read_file", output: "contents", isError: false },
    { role: "tool", toolCallId: "b", name: "list_files", output: "denied", isError: true },
    { role: "assistant", text: "Done.", toolCalls: [] },
  ];
  assert.deepEqual(toGeminiContents(messages), [
    { role: "user", parts: [{ text: "hi" }] },
    {
      role: "model",
      parts: [
        { text: "Checking." },
        { functionCall: { id: "g1", name: "read_file", args: { path: "x" } }, thoughtSignature: "sig" },
        { functionCall: { name: "list_files", args: {} } },
      ],
    },
    {
      role: "user",
      parts: [
        { functionResponse: { id: "g1", name: "read_file", response: { output: "contents" } } },
        { functionResponse: { name: "list_files", response: { error: "denied" } } },
      ],
    },
    { role: "model", parts: [{ text: "Done." }] },
  ]);
});

async function collect(adapter: GeminiAdapter, req: Partial<ModelRequest> = {}, signal?: AbortSignal) {
  const events: ModelEvent[] = [];
  const tools = [
    doThing.spec,
    {
      name: "read_file",
      description: "Read",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  ];
  for await (const ev of adapter.stream(
    { system: "Be kind.", messages: [{ role: "user", text: "hi" }], tools, ...req },
    signal ?? new AbortController().signal,
  )) {
    events.push(ev);
  }
  return events;
}

const adapterFor = (opts: Partial<ConstructorParameters<typeof GeminiAdapter>[0]> = {}) =>
  new GeminiAdapter({ baseUrl: `${base}/x/v1beta`, apiKey: "g-secret", defaultModel: "gemini-test", ...opts });

test("the request has the system instruction, declarations and the key in a header only", async () => {
  mock.setScript(() => ({ sse: textReply("ok") }));
  await collect(adapterFor(), { model: "gemini-pro-x" });
  const r = mock.requests.at(-1);
  assert.equal(r?.path, "/x/v1beta/models/gemini-pro-x:streamGenerateContent?alt=sse");
  assert.equal(r?.headers["x-goog-api-key"], "g-secret");
  assert.ok(!r?.path.includes("g-secret"), "the key is never in the URL");
  assert.deepEqual(r?.body?.systemInstruction, { parts: [{ text: "Be kind." }] });
  assert.deepEqual(r?.body?.tools, [
    {
      functionDeclarations: [
        { name: "do_thing", description: "Does a thing" },
        {
          name: "read_file",
          description: "Read",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
      ],
    },
  ]);
});

test("text, hidden thoughts, function calls with signatures, and usage", async () => {
  mock.setScript(() => ({
    sse: [
      parts({ text: "secret reasoning", thought: true }),
      parts({ text: "Let me look." }),
      parts({ functionCall: { id: "fc-9", name: "read_file", args: { path: "a.md" } }, thoughtSignature: "sig-x" }),
      event({
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
      }),
    ],
  }));
  assert.deepEqual(await collect(adapterFor()), [
    { type: "text_delta", text: "Let me look." },
    {
      type: "tool_call",
      call: {
        id: "fc-9",
        name: "read_file",
        input: { path: "a.md" },
        meta: { geminiId: "fc-9", thoughtSignature: "sig-x" },
      },
    },
    { type: "done", usage: { inputTokens: 7, outputTokens: 3 } },
  ]);
});

test("the thought signature goes back to Gemini on the next step", async () => {
  mock.setScript((r) =>
    lastContentHasResponse(r)
      ? { sse: textReply("Read it.") }
      : { sse: [parts({ functionCall: { name: "do_thing", args: {} }, thoughtSignature: "sig-keep" })] },
  );
  const provider = new LoopProvider({
    id: "gemini",
    adapter: adapterFor(),
    sessions: new SessionStore(tempDir()),
    tools: [doThing],
  });
  const outcome = await provider.run(
    {
      botId: "b",
      botName: "B",
      prompt: "go",
      workspaceDir: tempDir(),
      instructions: "",
      signal: new AbortController().signal,
    },
    { emit: () => {}, requestApproval: async () => ({ allow: true }) },
  );
  assert.equal(outcome.status, "finished");
  const second = mock.requests.at(-1)?.body?.contents as { role: string; parts: Record<string, unknown>[] }[];
  const modelTurn = second.find((c) => c.role === "model");
  assert.equal(modelTurn?.parts[0]?.thoughtSignature, "sig-keep");
});

test("a blocked prompt and a safety stop end the turn with the reason", async () => {
  mock.setScript(() => ({ sse: [event({ promptFeedback: { blockReason: "SAFETY" } })] }));
  await assert.rejects(collect(adapterFor()), /Gemini blocked the request \(SAFETY\)/);
  mock.setScript(() => ({ sse: [event({ candidates: [{ finishReason: "RECITATION" }] })] }));
  await assert.rejects(collect(adapterFor()), /Gemini stopped without answering \(RECITATION\)/);
});

test("API errors carry Gemini's message and never the key", async () => {
  mock.setScript(() => ({ status: 400, json: { error: { code: 400, message: "API key not valid." } } }));
  await assert.rejects(collect(adapterFor()), (err: Error) => {
    assert.equal(err.message, "Gemini returned 400: API key not valid.");
    assert.ok(!err.message.includes("g-secret"));
    return true;
  });
});

test("abort stops the stream at once", async () => {
  mock.setScript(() => ({ sse: textReply("one two three four five six"), delayMs: 300 }));
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  await assert.rejects(collect(adapterFor(), {}, controller.signal), { name: "AbortError" });
  assert.ok(Date.now() - started < 1000);
});

test("models are listed across pages, only those that generate content", async () => {
  mock.setScript((r) =>
    r.path.includes("pageToken=p2")
      ? {
          status: 200,
          json: {
            models: [{ name: "models/gemini-b", supportedGenerationMethods: ["generateContent", "countTokens"] }],
          },
        }
      : {
          status: 200,
          json: {
            models: [
              { name: "models/gemini-a", supportedGenerationMethods: ["generateContent"] },
              { name: "models/text-embedding", supportedGenerationMethods: ["embedContent"] },
            ],
            nextPageToken: "p2",
          },
        },
  );
  assert.deepEqual(await adapterFor().listModels(new AbortController().signal), ["gemini-a", "gemini-b"]);
});

test("a missing key or model says what to set", async () => {
  await assert.rejects(collect(adapterFor({ apiKey: undefined })), /Set GEMINI_API_KEY/);
  await assert.rejects(collect(adapterFor({ defaultModel: undefined })), /Choose a model for this bot/);
  assert.equal(geminiProvider(new SessionStore(tempDir()), {}).info().configured, false);
  assert.equal(geminiProvider(new SessionStore(tempDir()), { GOOGLE_API_KEY: "k" }).info().configured, true);
});
