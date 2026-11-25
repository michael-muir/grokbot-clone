# #8 Scaffold the Electron + React desktop app with a typed gateway client

Issue: #8 · Milestone: Phase 2 · Requirements: UI-1, platforms · Stories: —

## Goal

A desktop window that starts (or attaches to) the gateway, lists the bots, shows a bot's transcript live, and
sends messages, so every later UI issue builds on a working app instead of a blank one.

## Scope

- In: `app/` project (Electron 45, React 19, Vite via electron-vite), typed IPC, a typed HTTP client for the
  gateway, the dev gateway launcher, a per-OS platform folder, a `--smoke` mode for CI, root scripts and CI
  wiring.
- Out: the real UI and its styling (#9 tokens, then the screen issues), packaging and signing (#46), the
  three-OS CI matrix (#45; this issue only adds the app to the existing job), the gateway inside a packaged app
  (#46).

## Design

```
renderer (React, sandboxed, no Node)  ──window.desktop──▶  preload (contextBridge)
        ▲  stream:event                                        │ ipcRenderer.invoke / send
        └──────────────────────────────  main  ◀───────────────┘
                                          │ token in main only
                                          ▼
                              gateway (HTTP + SSE on 127.0.0.1)
```

- **The token stays in main.** The renderer never calls the gateway itself: it would need CORS, and the
  gateway refuses the opaque origin of a `file://` page. Main proxies calls and streams over IPC, so the
  gateway needs no change and the renderer holds no secret.
- **Gateway client** (`server/src/client/gateway-client.ts`): a typed wrapper over the HTTP routes, with token
  auth and an injectable `fetch`. It has no Node APIs, sits next to `subscribe.ts`, and is tested against the
  real HTTP server in `server/test`.
- **Typed IPC** (`app/src/shared/ipc.ts`): one map of call names to argument and result types. Main registers
  one `invoke` handler that accepts only names in the map and checks the argument types before calling the
  client. Streams use `stream:open` / `stream:close` from the renderer and `stream:event` from main. Main
  tracks streams per window and aborts them when the renderer closes them or the window goes away.
- **Gateway launcher** (`app/src/main/gateway-process.ts`): with `GATEWAY_URL` set, it attaches to that
  gateway (token from `GATEWAY_TOKEN`). Otherwise, in development, it spawns `node server/src/main.ts` with
  a free port and a random token, waits for `/health`, and kills the process when the app quits. The data
  directory defaults to the repo's `data/`, as `npm start` in `server/` does, so the app sees the same bots.
- **Platform folder** (`app/src/main/platform/`): `win.ts`, `mac.ts`, `linux.ts` behind one `Platform`
  interface, chosen once in `index.ts`. The first difference is real: macOS keeps the app running when its
  last window closes; Windows and Linux quit.
- **Smoke mode**: `electron . --smoke` starts the gateway, opens the window, waits for the renderer to report
  that it listed the bots, prints `smoke: ok <n> bots`, and exits 0 (1 on failure or after 30 s). #45 runs it
  on all three systems.
- **Cross-platform**: paths through `node:path` and `app.getPath()`, the menu's shortcuts through `CmdOrCtrl`
  roles, no native modules in `app/`.

## Interfaces

```ts
// server/src/types.ts
export type PublicBot = Omit<Bot, "sessionId" | "sessionProvider">;
export interface ProviderSummary extends ProviderInfo { id: ProviderId; needsKey: boolean; keySource: "keychain" | "env" | null }

// server/src/client/gateway-client.ts
export class GatewayError extends Error { status: number }
export class GatewayClient {
  constructor(opts: { baseUrl: string; token?: string; fetch?: typeof fetch });
  health(signal?): Promise<boolean>;
  listBots(): Promise<PublicBot[]>;
  updateBot(id, patch): Promise<PublicBot>;
  transcript(id, since?): Promise<TranscriptEntry[]>;
  sendMessage(id, text): Promise<void>;
  interrupt(id): Promise<void>;
  answerApproval(id, entryId, decision: ApprovalDecision): Promise<void>;
  listProviders(): Promise<ProviderSummary[]>;
  subscribe(id, opts): Promise<void>; // subscribeTranscript with this client's base URL and token
}

// app/src/shared/ipc.ts
export interface Calls { listBots: {args: []; result: PublicBot[]}; … }
export type StreamEvent = { kind: "entry"; entry } | { kind: "state"; state } | { kind: "error"; message };
export interface DesktopApi { call<K extends keyof Calls>(name: K, ...args: Calls[K]["args"]): Promise<Calls[K]["result"]>;
  subscribe(botId, since, onEvent): () => void; connection(): Promise<ConnectionInfo>; smokeReport(bots: number): void }
```

New root scripts: `dev` (opens the app), `typecheck` and `test` cover `app/` too.

## Test plan

| Acceptance criterion (from the issue) | Shown by |
| --- | --- |
| `npm run dev` opens a window connected to a running gateway | Manual: run it, see the bot list and send a message to the fake bot; plus `npm run smoke` (automated) |
| The same commands work on Windows, macOS and Linux | Windows: manual run here. macOS/Linux: the smoke run in the #45 matrix; until then, review against the cross-platform rules |
| Typed IPC | `app/test/ipc.test.ts`: unknown call names and wrong argument types are refused |
| Gateway client with SSE and token auth | `server/test/gateway-client.test.ts`: every method against the real server, 401 without the token, a subscription delivers live entries |
| Gateway started from the app in development | `app/test/gateway-process.test.ts`: spawns the gateway, waits for health, stops it; attach mode uses `GATEWAY_URL` |

Other tests: an error status becomes a `GatewayError` with the gateway's message; a launcher whose gateway
exits early reports the exit instead of waiting out the timeout.

## Risks and open questions

- Electron downloads a ~100 MB binary on install. CI's verify job sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1`,
  since it only typechecks and runs Node tests; the #45 matrix downloads it for the smoke run.
- The packaged app can't run `server/src/main.ts` from the repo. Bundling the gateway is part of #46.
