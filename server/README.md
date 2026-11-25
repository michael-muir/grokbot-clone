# GrokBot Clone: agent gateway

A small Node server between the GrokBot Clone desktop UI and the agent backends. The UI only sees
**transcript entries** (modeled on Grok Bot's own transcript), so each bot can run on Claude, Codex or Cursor
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
```

Without an API key, switch a bot to the scripted `fake` provider:

```bash
curl -X PATCH localhost:8787/bots/grok-bot -H 'content-type: application/json' -d '{"provider":"fake"}'
curl -X POST  localhost:8787/bots/grok-bot/messages -H 'content-type: application/json' -d '{"text":"hello"}'
curl localhost:8787/bots/grok-bot/events      # live stream (SSE)
```

The fake provider also understands `/tool` (an approval card), `/slow` (to test interrupt) and `/fail`.

## API

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/health` | | |
| GET | `/bots` | | |
| PATCH | `/bots/:id` | `{name?, provider?, model?}` | Changing provider drops the old provider's session |
| GET | `/bots/:id/transcript?since=N` | | Entries whose `updatedSeq` > N |
| GET | `/bots/:id/events?since=N` | | Server-Sent Events: the backlog, then live updates |
| POST | `/bots/:id/messages` | `{text}` | 202. 409 while the bot is still working |
| POST | `/bots/:id/interrupt` | | 202. 409 when idle |
| POST | `/bots/:id/approvals/:entryId` | `{allow, reason?}` | Answers an approval card |

If `GATEWAY_TOKEN` is set, every request needs `Authorization: Bearer <token>`. The server listens on
127.0.0.1 only, because agents can run commands on this machine.

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

## Providers

| Provider | Status | How |
|---|---|---|
| `claude` | Ready (needs `ANTHROPIC_API_KEY`) | Claude Agent SDK `query()`: streaming text, tool rows, `canUseTool` → approval cards, session resume. Read-only tools run without asking; everything else asks. Ignores the host's own Claude Code settings (`settingSources: []`). Default model `claude-opus-5-5`. |
| `codex` | Placeholder | Planned: Codex SDK or `codex app-server` |
| `cursor` | Placeholder | Planned: Cursor CLI in print mode with JSON streaming |
| `fake` | Ready | Scripted, offline. For UI work and tests |

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
