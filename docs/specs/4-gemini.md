# #4 Gemini provider

Issue: #4 · Milestone: Phase 1 · Requirements: PR-3 · Stories: US-4

## Goal

Bots can run on Google's Gemini models, with tools through the built-in agent loop (#2).

## Scope

- In: a `ModelAdapter` for the Gemini API (`streamGenerateContent` over SSE, function calling, model listing); a
  `gemini` provider; offline tests on a mock server; a live check.
- Out: keys in the keychain and settings UI (#5, #13); Vertex AI; images and files; cost (#21).

## Design

`GeminiAdapter` calls `POST {base}/models/{model}:streamGenerateContent?alt=sse` with the key in the
`x-goog-api-key` header (never in the URL, so it can't leak into logs or error messages).

| Ours | Gemini |
| --- | --- |
| system prompt | `systemInstruction.parts[].text` |
| `user` message | `content` role `user`, a `text` part |
| `assistant` message | role `model`: a `text` part (if any) and one `functionCall` part per tool call |
| `tool` results | role `user`, one `functionResponse` part per result; results from the same step go in one content |
| tool spec | `tools[0].functionDeclarations[]` with `name`, `description`, `parameters` (left out when the tool takes no input) |

Streamed parts: `text` becomes `text_delta`; thought parts (`thought: true`) are not shown; `functionCall` becomes
a `tool_call`. `usageMetadata` becomes usage. A blocked prompt (`promptFeedback.blockReason`), or a finish such as
`SAFETY` with no content, ends the turn with an error that says why.

**Opaque per-call data.** Recent Gemini models attach a `thoughtSignature` to function calls and require it back
in the next request. `ToolCall` gains an optional `meta` object that adapters can fill and the loop stores with
the history untouched. The Gemini adapter keeps `thoughtSignature` and Gemini's own call id there.

Function call ids are optional in Gemini. When Gemini gives none, the loop makes one (#2). The adapter sends an id
back in `functionResponse` only when Gemini gave one.

Model choice: the bot's model, else `GEMINI_MODEL`; otherwise the run fails with "Choose a model for this bot."
Key: `GEMINI_API_KEY` (or `GOOGLE_API_KEY`). Base URL override: `GEMINI_BASE_URL`.

`listModels` pages through `GET {base}/models` and keeps models whose `supportedGenerationMethods` include
`generateContent`, without the `models/` prefix.

## Interfaces

```ts
new GeminiAdapter({ baseUrl?: string; apiKey?: string; defaultModel?: string; fetch?: typeof fetch })
interface ToolCall { id: string; name: string; input: Record<string, unknown>; meta?: Record<string, unknown> }
```

`gemini` is added to `PROVIDER_IDS`.

## Test plan

| Acceptance criterion | Shown by |
| --- | --- |
| Passes the provider contract test | `provider contract: gemini` against a mock Gemini server |
| End-to-end chat with a tool call works | Live check `LIVE_PROVIDER=gemini npm run test:live` with a key (escalated to the owner), the same file-writing tool call as #3 |

Offline tests: request shape (system instruction, contents, merged function responses, declarations, key header,
no key in the URL); thought signatures round-trip; thought parts hidden; usage; blocked prompt and safety stop;
API error message; abort; model listing with paging and filtering; missing key or model.

## Risks and open questions

- Gemini's schema support is a subset of JSON Schema. Our tool schemas only use types, properties, required,
  descriptions and min/max, which Gemini accepts.
