# #3 OpenAI-compatible provider (OpenAI, xAI Grok, OpenRouter, Ollama, LM Studio)

Issue: #3 · Milestone: Phase 1 · Requirements: PR-3 · Stories: US-3, US-4

## Goal

One adapter that speaks the OpenAI Chat Completions API, so a bot can run on OpenAI, xAI's Grok, OpenRouter, or a
local Ollama or LM Studio server, with tools through the built-in agent loop (#2).

## Scope

- In: a `ModelAdapter` for `/chat/completions` with streaming and tool calls; model listing from `/models`;
  five presets registered as providers; `GET /providers` and `GET /providers/:id/models`; keys and base URLs from
  environment variables for now.
- Out: keys in the OS keychain, per-bot base URL and the Test button (#5); the Settings UI (#13); cost (#21).

## Design

### Presets

Each preset is a provider id, a `LoopProvider` around an `OpenAICompatibleAdapter`:

| Id | Label | Base URL (override) | Key | Local |
| --- | --- | --- | --- | --- |
| `openai` | OpenAI | `https://api.openai.com/v1` (`OPENAI_BASE_URL`) | `OPENAI_API_KEY` | no |
| `xai` | xAI Grok | `https://api.x.ai/v1` (`XAI_BASE_URL`) | `XAI_API_KEY` | no |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` (`OPENROUTER_BASE_URL`) | `OPENROUTER_API_KEY` | no |
| `ollama` | Ollama | `http://127.0.0.1:11434/v1` (`OLLAMA_BASE_URL`) | none | yes |
| `lmstudio` | LM Studio | `http://127.0.0.1:1234/v1` (`LMSTUDIO_BASE_URL`) | none | yes |

Grok is reached only through xAI's public API.

### Choosing the model

The bot's `model` wins. Otherwise a `<ID>_MODEL` environment variable. Otherwise a local preset uses the first
model its server lists; a remote preset fails the run with "Choose a model for this bot." A remote preset without
its key fails with "Set OPENAI_API_KEY (or switch provider)." Neither error includes a key.

### Request and stream

- Messages: system prompt as a `system` message; `user`; `assistant` with `tool_calls` (arguments as JSON
  text); `tool` results with `tool_call_id`.
- Tools: `{ type: "function", function: { name, description, parameters } }`.
- `stream: true`; `stream_options.include_usage` for remote presets (some local servers reject it).
- The SSE reader handles events split across network chunks and `[DONE]`. `delta.content` becomes `text_delta`.
  `delta.tool_calls` fragments are joined by `index`; when the stream ends each finished call becomes a
  `tool_call` event. Arguments that aren't valid JSON become `{}` plus a note, so the tool reports bad input to the
  model instead of crashing the run. Reasoning fields (`reasoning`, `reasoning_content`) aren't shown.
- A non-2xx response throws an error with the status and the API's own message.
- Abort is passed to `fetch`, so the stream stops at once.

### Listing models and providers

`AgentProvider` gains an optional `listModels(signal)`. `LoopProvider` forwards it to the adapter. New routes:

- `GET /providers` → `[{ id, label, local, configured }]` (`configured`: has a key, or is local).
- `GET /providers/:id/models` → `{ models: string[] }`; 404 for an unknown id or a provider that can't list;
  502 with the upstream message when listing fails.

`ProviderId` becomes `typeof PROVIDER_IDS[number]`, one list used by the types and the HTTP validation.

## Interfaces

```ts
new OpenAICompatibleAdapter({ baseUrl: string; apiKey?: string; keyEnv?: string; local: boolean;
  defaultModel?: string; streamUsage: boolean; fetch?: typeof fetch })
adapter.listModels(signal): Promise<string[]>
interface AgentProvider { listModels?(signal: AbortSignal): Promise<string[]> }
```

## Test plan

| Acceptance criterion | Shown by |
| --- | --- |
| Works end to end against at least OpenAI and a local Ollama | Ollama: a live check through the gateway with a tool call, recorded in the PR. OpenAI: the same live check with the owner's key (escalated) |
| Works with the network unplugged when pointed at Ollama | Ollama runs on 127.0.0.1 only; the live check uses no internet. Plus a test that a local preset sends no `Authorization` header and needs no key |

Offline tests against a mock OpenAI-compatible server (`node:http`):

- the provider contract suite, with the mock playing each scenario;
- message and tool conversion; tool call fragments joined across chunks and SSE events split mid-line;
- invalid tool arguments; usage reported; reasoning fields ignored;
- an HTTP error surfaces the API message without the key; abort mid-stream;
- model selection (bot model, env default, first local model, remote with no model);
- `GET /providers` and `GET /providers/:id/models`.

## Risks and open questions

- Small local models are unreliable at tool calling. That's a model limitation; the loop already reports bad
  tool input back to the model.
- Some servers differ slightly from OpenAI. The adapter only uses the common subset.
