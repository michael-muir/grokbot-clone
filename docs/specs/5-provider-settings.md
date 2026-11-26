# #5 Per-bot provider, model and API key settings with keychain storage

Issue: #5 · Milestone: Phase 1 · Requirements: PR-4 · Stories: US-1, US-2

## Goal

Users pick each bot's provider and model, and enter each provider's API key once. Keys live in the operating
system's keychain, never in files, logs, API responses or the transcript.

## Scope

- In: a key store on the OS keychain; key routes; a connection test; per-bot base URL; a transcript notice when a
  bot switches provider; providers read keys at run time.
- Out: the Settings screens (#13); an encrypted-file fallback for Linux machines without a keyring (#46); per-bot
  keys (one key per provider covers US-2).

## Design

### Key store

`KeyStore` interface with two implementations:

- `KeychainKeyStore`: `@napi-rs/keyring` (Windows Credential Manager, macOS Keychain, Linux Secret Service),
  service `smarty-prompts` (keys saved under the earlier name `grokbot-clone` move over on first read), account = provider id. New dependency: it's the only maintained keychain binding with
  prebuilt binaries for all three systems (checked: Windows works here).
- `MemoryKeyStore` for tests.

A provider's key comes from the key store first, then its environment variable (as today), so existing `.env`
setups keep working. `GET /providers` says where a key comes from (`keychain`, `env` or none) and never shows it.

### Keys at run time

Adapters take a `getKey()` function instead of a fixed key, so a key saved in Settings works on the next message
without a restart. `info().configured` is also computed on each call. Claude gets its key the same way, passed to
the SDK through `options.env.ANTHROPIC_API_KEY`.

### Per-bot base URL

`Bot.baseUrl` (optional) overrides the provider's base URL for that bot, such as an Ollama on another machine or
a company proxy. It travels as `RunRequest.baseUrl` → `ModelRequest.baseUrl`. Only `http:` and `https:` URLs are
accepted. Providers that can't use it (Claude, fake) ignore it.

### Switching provider

`Gateway.updateBot()` replaces the direct registry update in the PATCH route. When the provider changes, it posts
a `notice` entry: "Switched to Ollama (qwen3.5:4b). The conversation starts fresh for the new model." The
session and model are dropped as before (#3), so the next message uses the new provider.

### Connection test

`POST /providers/:id/test` with optional `{ baseUrl }` lists the provider's models with the current key (cheap, no
tokens spent) and returns `{ ok: true, models }` or `{ ok: false, error }`. Claude gains `listModels` through
`GET https://api.anthropic.com/v1/models`, which is also its test.

### Routes

| Route | Body | Result |
| --- | --- | --- |
| `PUT /providers/:id/key` | `{ key }` | 204. Stored in the keychain. 400 for an empty key or a provider that takes none |
| `DELETE /providers/:id/key` | | 204 |
| `POST /providers/:id/test` | `{ baseUrl? }` | `{ ok, models? , error? }` |
| `GET /providers` | | adds `keySource: "keychain" \| "env" \| null` and `needsKey` |
| `PATCH /bots/:id` | adds `baseUrl` (string or `""` to clear) | the bot, without session fields |

## Interfaces

```ts
interface KeyStore { get(provider: ProviderId): string | undefined; set(provider: ProviderId, key: string): void;
  delete(provider: ProviderId): void }
type KeySource = "keychain" | "env";
class Credentials { constructor(store: KeyStore, env?: NodeJS.ProcessEnv); key(p): string | undefined;
  source(p): KeySource | undefined }
// EntryBody gains { kind: "notice"; text: string }
// Bot gains baseUrl?: string; RunRequest and ModelRequest gain baseUrl?: string
```

## Test plan

| Acceptance criterion | Shown by |
| --- | --- |
| Keys never appear in API responses, logs or files on disk | A test saves a key through the API, runs a bot, lists providers and bots, tests the connection, then scans every response, every captured log line, and every file under the data directory for the key: none contain it |
| Switching provider applies to the next message | A test switches a bot from `fake` to an OpenAI-compatible mock and sends a message; the mock gets the request with the new model, and a `notice` entry is posted |

Other tests: keychain key wins over env; deleting a key falls back to env; a key saved while the gateway runs is
used by the next run; `baseUrl` per bot reaches the request; invalid `baseUrl` refused; connection test success
and failure; Claude's key reaches the SDK through `options.env`; the keychain store round trip (skipped where no
keychain is available).

## Risks and open questions

- Linux machines without a Secret Service can't store keys yet (#46 adds a fallback). Until then the env variable
  still works there.
