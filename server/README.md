# SmartyPrompts: agent gateway

A small Node server between the SmartyPrompts desktop UI and the agent backends. The UI only sees
**transcript entries** (modeled on Grok Bot's own transcript), so each bot can run on Claude, an OpenAI-compatible API (OpenAI, xAI Grok, OpenRouter), a local model (Ollama, LM Studio), and later Codex or Cursor,
without the UI changing.

```
UI ──HTTP/SSE──▶ Gateway ──▶ AgentProvider (claude | codex | cursor | fake)
                    │              └─ runs in the bot's computer (workspace)
                    └─ TranscriptStore (per bot, JSONL) + approval cards
```

## Run it

Requires Node 23.6 or newer (TypeScript runs natively).

```bash
cd server
npm install
cp .env.example .env      # then set ANTHROPIC_API_KEY
npm start                 # http://127.0.0.1:8787
npm test                  # uses the fake provider, so no API key is needed
npm run typecheck
LIVE_PROVIDER=ollama LIVE_MODEL=qwen3.5:4b npm run test:live   # live end-to-end check, real model
```

Without an API key, switch a bot to the scripted `fake` provider:

```bash
curl -X PATCH localhost:8787/bots/smarty -H 'content-type: application/json' -d '{"provider":"fake"}'
curl -X POST  localhost:8787/bots/smarty/messages -H 'content-type: application/json' -d '{"text":"hello"}'
curl localhost:8787/bots/smarty/events      # live stream (SSE)
```

The fake provider also understands `/tool` (an approval card), `/slow` (to test interrupt) and `/fail`.

## API

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/health` | | |
| GET | `/bots` | | |
| GET | `/providers` | | `[{id, label, local, configured, needsKey, keySource}]`; `keySource` is `keychain`, `env` or `null`, the key itself is never returned |
| PUT | `/providers/:id/key` | `{key}` | 204. Saved in the OS keychain |
| DELETE | `/providers/:id/key` | | 204 |
| POST | `/providers/:id/test` | `{baseUrl?}` | `{ok: true, models}` or `{ok: false, error}`. Lists models with the current key, so it spends no tokens |
| GET | `/providers/:id/models` | | `{models}`; 404 if the provider can't list, 502 if it can't be reached |
| PATCH | `/bots/:id` | `{name?, provider?, model?, baseUrl?}` | Changing provider drops the old session and model, and posts a `notice` entry. `baseUrl` (http or https) points this bot at its own server |
| GET | `/bots/:id/transcript?since=N` | | Entries whose `updatedSeq` > N |
| GET | `/bots/:id/events?since=N` | | Server-Sent Events: the backlog, then live updates |
| POST | `/bots/:id/messages` | `{text}` | 202. 409 while the bot is still working |
| POST | `/bots/:id/interrupt` | | 202. 409 when idle |
| POST | `/bots/:id/approvals/:entryId` | `{allow, reason?}` | Answers an approval card |

If `GATEWAY_TOKEN` is set, every request needs `Authorization: Bearer <token>`. The server listens on
127.0.0.1 only, because agents can run commands on this machine.

### Live updates and resuming

`GET /bots/:id/events` streams the backlog and then live changes, in the order they happened (`updatedSeq`).
Each event's `id` is its `updatedSeq`, so a browser `EventSource` resumes on its own through `Last-Event-ID`, and
`?since=<updatedSeq>` does the same for any client. A comment is sent every 15 seconds as a heartbeat.

`src/client/` has what the desktop app uses: `subscribeTranscript()` reconnects with backoff (0.5 s doubling to
10 s), replaces a connection that's been silent for 45 s, and resumes from the last change it saw;
`TranscriptView` keeps the latest copy of each entry and lists them in conversation order.

### Transcript entries

Each entry has `seq` (its position, never changes), `updatedSeq` (bumped on every change) and a `body`:

| `body.kind` | Shown in the UI as | Updated in place? |
|---|---|---|
| `user_message` | right-aligned bubble in the bot's color | no |
| `assistant_text` | bot bubble. `streaming: true` while text arrives | yes, as text streams |
| `status` | activity row ("Running npm test"), `running` → `done`/`failed` | yes |
| `approval` | approval card, `pending` → `approved`/`denied`/`expired` | yes |
| `run` | turn status and cost, `running` → `finished`/`interrupted`/`failed` | yes |
| `error` | error row | no |
| `notice` | a note from the app ("Switched to Ollama") | no |

## API keys

Keys are saved with `PUT /providers/:id/key` into the OS keychain (Windows Credential Manager, macOS Keychain,
Linux Secret Service) under the service `smarty-prompts` (keys saved under the earlier name `grokbot-clone` move over on first use). They're read on every request, so a new key works on the
next message. A key in the keychain wins over the provider's environment variable (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`), which still works as a fallback. Keys never
appear in API responses, logs, the transcript or files on disk.

## Providers

| Provider | Status | How |
|---|---|---|
| `claude` | Ready (needs `ANTHROPIC_API_KEY`) | Claude Agent SDK `query()`: streaming text, tool rows, `canUseTool` → approval cards, session resume. Read-only tools run without asking; everything else asks. Ignores the host's own Claude Code settings (`settingSources: []`). Default model `claude-opus-5-5`. |
| `openai`, `xai`, `openrouter` | Ready (needs `OPENAI_API_KEY`, `XAI_API_KEY` or `OPENROUTER_API_KEY`) | OpenAI-compatible adapter on the built-in agent loop. Set the model per bot, or with `<PREFIX>_MODEL`. Grok is reached only through xAI's public API. |
| `ollama`, `lmstudio` | Ready (local, no key) | Same adapter, pointed at `127.0.0.1`. Works offline. Uses the bot's model, or the first model the server lists. |
| `gemini` | Ready (needs `GEMINI_API_KEY`) | Gemini API adapter on the built-in agent loop: streamed text and function calls, thought signatures kept with the history. Set the model per bot or with `GEMINI_MODEL`. |
| `codex` | Placeholder | Planned: Codex SDK or `codex app-server` |
| `cursor` | Placeholder | Planned: Cursor CLI in print mode with JSON streaming |
| `fake` | Ready | Scripted, offline. For UI work and tests |

### Built-in agent loop (`src/agent/`)

For chat models that have no agent runtime of their own (OpenAI-compatible APIs, Gemini, local models),
`LoopProvider` runs the agent loop itself: it streams the model's reply, runs the tools it asks for, sends the
results back, and repeats until the model answers without tools (25 steps at most).

| Tool | Asks first? | Does |
| --- | --- | --- |
| `read_file`, `list_files`, `search_files` | no | Read inside the bot's workspace |
| `write_file`, `edit_file` | yes | Change files inside the workspace |
| `shell` | yes | Run a command in the workspace (PowerShell on Windows, the user's shell elsewhere) |

File tools refuse paths that leave the workspace, including through symlinks. The workspace isn't a sandbox
yet (#27), so the shell can reach anything the user can; that's why every command needs approval.

A model API only needs a `ModelAdapter` (`src/agent/model.ts`): turn neutral `ChatMessage`s and `ToolSpec`s
into the API's request, and stream back `text_delta` and `tool_call` events. History is kept per session in
`<data>/sessions/<id>.json`.

### Adding a provider

1. Copy `src/providers/_template.ts` to `src/providers/<name>.ts` and add `<name>` to `ProviderId` in `src/types.ts`.
2. Map the backend's events to `ProviderEvent`s (`session`, `text_delta`, `text`, `tool_start`, `tool_end`) and
   ask for approvals with `requestApproval`. The template's header lists the rules.
3. Register it in `defaultProviders()` in `src/providers/index.ts`.
4. Add it to `test/providers.contract.test.ts` with a harness that makes each scenario happen offline (a
   scripted backend, a recorded stream, or prompt commands like the fake provider), then run `npm test`.

### Provider contract

`test/contract/provider-contract.ts` checks every provider against the same rules, offline:

| Scenario | The provider must |
| --- | --- |
| reply | emit a session, stream text, end each block with its final text, finish |
| tool, approved | ask once, report the tool as ok, finish |
| tool, denied | report the tool as not ok, still finish |
| slow, aborted | return `interrupted` within 2 seconds |
| tool, aborted while the approval is pending | return `interrupted` within 2 seconds |
| fail | return `failed` with an error message, never throw |
| resume | reuse the session id it was given |

It also checks the whole event sequence: no events after `run()` returns, no `tool_end` without a `tool_start`,
no text for a block after its final text. Claude runs against a scripted stand-in for the SDK
(`new ClaudeProvider(queryFn)`), so no API key or network is needed.

## Bot's computer

Each bot works in `data/bots/<id>/computer/`, with a shared skills folder at `agent-data/workflows/`. For now this
is a plain local folder: it keeps bots apart from each other, but it does **not** sandbox them from your machine.
Approval cards are the safety net until the next step, which is replacing `LocalFolderComputers` with
containers (WSL or Docker, plus noVNC for the live view).

Runtime data under `data/` is git-ignored.
