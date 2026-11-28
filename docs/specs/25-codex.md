# #25 Codex provider adapter

Issue: #25 · Milestone: Phase 3 · Bots, cards and polish · Requirements: PR-2

## Goal

A bot can run on Codex: OpenAI's coding agent, through the user's own signed-in Codex CLI. The `codex` placeholder
becomes a working provider that passes the provider contract.

The owner chose to keep it in v1 (2026-11-28).

## Scope

- **In:**
  - A `CodexProvider` that drives `codex app-server` (JSON-RPC over stdio):
    - streamed replies;
    - steps (commands, file changes) as status rows;
    - Codex's approval requests as our approval cards;
    - sessions (threads), resumed and forked at a checkpoint (roll back, threads);
    - usage (tokens);
    - Stop.
  - Isolation from the user's own Codex setup.
  - Listing models.
  - Offline contract tests on a scripted server.
  - A short live check on the owner's signed-in account.
- **Out:**
  - **Signing in from our app.** The user signs in with `codex login` themselves. Settings shows whether Codex is
    there and signed in, through `listModels`.
  - **Codex's other server requests:** `requestUserInput`, MCP elicitation, permissions and dynamic tool calls. They
    get a clear error, and the turn goes on without them.
  - **Cards (#19) and secrets (#20) for Codex.** Codex has no tool of ours to call. Its replies are text, and a
    secret card isn't offered.

## Design

### Talking to Codex (`server/src/providers/codex.ts`)

**One process per run:** `codex app-server`, with `childEnv()` (no gateway token or provider keys) and the bot's
workspace as its cwd.

**Framing:** JSON-RPC 2.0, one message per line. A small client matches responses to requests, routes
notifications, and answers server requests.

**Setup:**

1. `initialize` with `{clientInfo: {name: "smartyprompts"…}}`, then the `initialized` notification.
2. The thread:
   - **Fork:** with `sessionId` and `resumeAt`, `thread/fork {threadId, lastTurnId: resumeAt}`. That's the
     checkpoint.
   - **Resume:** with only `sessionId`, `thread/resume {threadId}`.
   - **New:** otherwise `thread/start`.

   Each carries `cwd`, `approvalPolicy: "untrusted"`, `sandbox: "workspace-write"`, `model` and
   `developerInstructions` (the bot's instructions). The thread id is the session: it's emitted as `session`.
3. `turn/start {threadId, input: [{type: "text", text: prompt}]}`.

**Events:**

| Codex sends | We emit |
| --- | --- |
| `item/agentMessage/delta` | `text_delta` (block = item id) |
| `item/completed` agentMessage | `text` |
| `item/started` commandExecution | `tool_start` "Running …" |
| `item/started` fileChange | `tool_start` "Changing files" |
| `item/completed` commandExecution | `tool_end` (ok = completed with exit 0) |
| `item/completed` fileChange | `tool_end` (ok = completed) |
| `thread/tokenUsage/updated` | `usage`, from `last` (that response's tokens) |
| `turn/completed` | `checkpoint` (the turn's id), then the outcome |

The outcome comes from the turn's status:

- `completed` gives `finished`;
- `interrupted` gives `interrupted`;
- `failed` gives `failed` with the turn's error message.

An `error` notification that won't be retried is kept as the failure's message.

**Approvals:**

- `item/commandExecution/requestApproval` becomes an approval card: tool `Bash`, "Running <command>", with the
  command and cwd.
- `item/fileChange/requestApproval` becomes one too: tool `Edit`, "Changing files", with the reason.
- Our decision maps to `accept` or `decline`, and Stop to `cancel`.
- The legacy `execCommandApproval` and `applyPatchApproval` map to `approved`, or `{denied: {rejection}}`.
- Any other server request gets a JSON-RPC error ("not supported here").

**Stop:** `turn/interrupt {threadId, turnId}`. If no `turn/completed` arrives within 2 s, the process is killed
anyway. Either way the run returns `interrupted` promptly.

**The end of a run:** the process is closed, and is killed if it lingers. If it exits unexpectedly, the run fails
with its last stderr line. That line is trimmed, and keys never appear in it: the env has none.

### Isolation from the user's Codex setup

`thread/start` loads `~/.codex/config.toml`. On the owner's machine that brings in:

- **Plugins:** computer use, browser, app tools.
- **Their own MCP servers.**
- **A `notify` hook** that runs a program at every turn end.

A bot must not inherit tools that act outside its workspace (ground rules). So every run passes:

- `--disable apps plugins remote_plugin computer_use browser_use browser_use_external in_app_browser hooks
  image_generation code_mode_host`;
- `-c notify=[]`.

It also switches off each MCP server Codex still lists as enabled. Those come from `codex mcp list --json`, run with
the same flags. Only the names are read, and each gets `-c mcp_servers.<name>.enabled=false`. All of this is checked
live: with these flags no MCP server starts, and a thread still opens.

The user's model choice, reasoning effort and trusted projects are kept. Their sign-in is reused, never read or
copied by us.

### Provider registration and Settings

- **The provider:** `codex` becomes `CodexProvider`.
- **Settings:**
  - **Configured** when the `codex` executable is found: `CODEX_PATH` or the PATH.
  - **Models:** `listModels` calls `model/list` (non-hidden ids). If Codex isn't signed in, its error is shown.

## Interfaces

```ts
class CodexProvider implements AgentProvider   // id "codex"
  constructor(opts?: { connect?: () => CodexConnection; command?: string })
interface CodexConnection { send(line: string): void; onLine(fn: (line: string) => void): void; onExit(fn: (info: string) => void): void; close(): void }
codexArgs(mcpNames: string[]): string[]        // the isolation flags
```

## Test plan

| Acceptance criterion | Shown by |
| --- | --- |
| Passes the provider contract test | `provider contract: codex` (all of it, on a scripted app-server) |

Other tests (`codex.test.ts`):

- **Events:** a reply streams and finalizes; a command step becomes `tool_start`/`tool_end`.
- **Approvals:**
  - Codex's approval requests become approval cards, and accept or decline goes back.
  - Stop during an approval sends `cancel`.
- **Sessions:** resume uses `thread/resume`; `resumeAt` uses `thread/fork` with `lastTurnId`; the checkpoint is
  the turn id.
- **Usage:** sums `last` per update.
- **Failures:** a failed turn fails with its message; an unexpected exit fails with stderr.
- **Server requests:** unsupported ones get an error reply.
- **Isolation:** `codexArgs` disables plugins and hooks, clears `notify`, and turns each listed MCP server off.

**Live check:** with the owner's signed-in Codex. Through the gateway, a bot on Codex is asked for a one-line reply
with no tools. Check that it streams, finishes and records usage, and that a second message resumes the same thread.

## Risks and open questions

- **Protocol changes.** The app-server protocol is marked experimental and may change. The adapter reads only the
  fields above, and unknown notifications are ignored.
- **Global instructions.** The user's `~/.codex/AGENTS.md`, if any, still applies, as Codex's own instructions.
  Codex has no switch to leave it out without moving `CODEX_HOME`, which would lose the sign-in.
