# GrokBot Clone

A desktop agent app modeled on the Grok Bot interface, keeping its agent behavior, with a swappable model
backend. Roadmap and issues: GitHub milestones "Phase 1" to "Phase 6".

## How work is done

Every issue follows [`docs/factory/PROCESS.md`](docs/factory/PROCESS.md): spec, build, check, review, approve,
merge, one issue at a time. Specs live in `docs/specs/`.

## Commands

```bash
npm install                 # root: Biome
npm --prefix server install # gateway dependencies
npm run verify              # lint + format check, typecheck, tests (must pass before every commit)
npm run fix                 # apply Biome formatting and safe fixes
```

Node 23.6 or newer. TypeScript runs natively (type stripping), so only erasable syntax is allowed.

## Layout

| Path | What |
| --- | --- |
| `server/` | Agent gateway: HTTP + SSE API, transcript store, approvals, providers |
| `app/` | Desktop app (Electron + React), from Phase 2 |
| `docs/` | Process, specs, future features |
| `design/`, `reference/` | Designs and reference captures. Read-only input, never shipped |

## Coding standards

**Language and types**
- TypeScript, `strict`. No `any`; use `unknown` and narrow. No non-null assertions (`!`); check instead.
- Only erasable syntax: no `enum`, no `namespace`, no parameter properties. Use union types and `as const`.
- Import local files with the `.ts` extension. Use `import type` for types.
- Shared contracts (transcript entries, provider events, cards) live in one place (`server/src/types.ts`) and
  are imported, never redeclared.

**Structure**
- One responsibility per module. Providers only emit `ProviderEvent`s; only the gateway writes transcript
  entries; only `http.ts` knows about HTTP.
- New providers implement `AgentProvider` in `server/src/providers/` and must pass the provider contract tests.
- Prefer small pure functions; keep side effects at the edges.
- No new dependency without a reason in the spec. Pin exact versions.

**Errors and safety**
- Never swallow errors silently. Log with context, or turn them into a transcript `error` entry the user sees.
- Every long-running operation takes an `AbortSignal` and stops promptly when it fires.
- Secrets (API keys, user secrets) never go into the transcript, logs, error messages or model context.
- Anything that acts outside the bot's workspace needs an approval card or a standing grant.
- The gateway binds to 127.0.0.1 unless a token is configured.

**Cross-platform**
- Paths through `node:path`. No hard-coded separators, drive letters or home paths.
- Shortcuts use `CmdOrCtrl`. Shell commands go through one interface per OS.
- Text files use LF (enforced by `.gitattributes`).

**Tests**
- `node:test` with `node:assert/strict`, offline, deterministic, no API keys. Use the `fake` provider or
  recorded fixtures for model providers.
- Every acceptance criterion in an issue maps to a test or to a written manual check.
- Clean up temp directories and servers in `finally`.

**Style**
- Biome decides formatting (2 spaces, double quotes, 120 columns). Run `npm run fix`.
- Comments explain why, not what. Each file starts with a one-line comment saying what it is for.
- User-facing text is short, plain and friendly.

**UI (Phase 2 onward)**
- Match `reference/screens` and `design/previews`. Colors, spacing and type come from tokens, never literals.
- Every interactive element works with the keyboard and has a visible focus state.
- Respect `prefers-reduced-motion`.

## Ground rules

- Never call Cursor or xAI private endpoints. Grok is used only through xAI's public API.
- Don't send messages or tasks to the real Grok Bot app; it acts on a real computer and connected apps.
- Grok Bot's name, mascot, art and copy are for reference only and must be replaced before release.
