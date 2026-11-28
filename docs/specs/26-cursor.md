# #26 Cursor provider adapter

Issue: #26 · Milestone: Phase 3 · Bots, cards and polish · Requirements: PR-2

## Goal

A bot can run on Cursor's agent, through the user's own signed-in Cursor CLI (`cursor-agent`). The `cursor`
placeholder becomes a working provider that passes the provider contract.

## The owner's decision (2026-11-28)

The issue named print mode (`-p --output-format stream-json`). That mode can't ask before acting: a tool is either
allowed up front or refused, so a bot would never show approval cards.

The CLI also has a hidden `agent acp` command: an Agent Client Protocol server over stdio. It asks permission per
tool call. The owner chose **ACP**. It's undocumented, so a Cursor update could change it. If one does, the offline
contract tests still pass and the live check shows the break; the adapter reads only the fields below.

ACP talks to the local CLI over stdio. No Cursor endpoint is called by us: the CLI does that, as it does for the user.

## Scope

- **In:**
  - A `CursorProvider` that drives `cursor-agent acp`:
    - streamed replies;
    - tool calls as steps;
    - Cursor's permission requests as approval cards;
    - sessions, resumed with `session/load`;
    - checkpoints and forks (roll back, threads), emulated with a turn log;
    - the bot's model;
    - Stop.
  - Isolation from the user's own Cursor setup.
  - Listing models.
  - Offline contract tests on a scripted ACP server.
  - A short live check on the owner's signed-in account.
  - Sharing the stdio JSON-RPC client with the Codex provider, instead of a second copy.
- **Out:**
  - **Usage.** ACP reports no token counts, so Cursor runs record none.
  - **Signing in from our app.** The user runs `cursor-agent login`.
  - **Cursor's own questions** (`cursor/ask_question`, sent as a permission request with answer options). Each is
    skipped, and the agent goes on without an answer. Its other extension requests get a JSON-RPC error.
  - **Cards (#19) and secrets (#20)** for Cursor, as for Codex.

## Design

### Shared plumbing (`server/src/providers/stdio-rpc.ts`)

The Codex provider's process and JSON-RPC code moves here, unchanged in behavior:

- **`LineConnection`:** a line-based connection (send, onLine, onExit, close). `CodexConnection` is now this type.
- **`spawnLines(command, args, cwd, env)`:** spawns a process as a `LineConnection`. It keeps the stderr tail, ends
  the run on EPIPE, and starts npm's Windows `.cmd` shims through the shell (`launchSpec`).
- **`Rpc`:** requests, notifications, and answering the server's requests.
- **`findExecutable`:** for `configured`.

### Talking to Cursor (`server/src/providers/cursor.ts`)

**One process per run:** `cursor-agent acp`, with the isolated environment below. The bot's workspace is the
session's `cwd`.

**Setup:**

1. `initialize {protocolVersion: 1, clientCapabilities: {fs: {readTextFile: false, writeTextFile: false},
   terminal: false}}`. Cursor's agent then uses its own tools; we offer no file or terminal access of ours.
2. The session:
   - **Fork:** with `sessionId` and `resumeAt`, `session/new` (see checkpoints below).
   - **Resume:** with only `sessionId`, `session/load {sessionId, cwd, mcpServers: []}`. Cursor replays the
     conversation as `session/update`s before it answers. Those are history, not this run, so updates are ignored
     until the answer comes.
   - **New:** otherwise `session/new {cwd, mcpServers: []}`.

   The session id is emitted as `session`.
3. **Model:** with `model`, `session/set_model {sessionId, modelId}`.
4. **The prompt:** `session/prompt {sessionId, prompt: [{type: "text", text}]}`. ACP has no system prompt field.
   So a new session's first prompt carries the bot's instructions, and on a fork the earlier conversation
   (`firstPrompt`).

**Events** (`session/update`, by `update.sessionUpdate`):

| Cursor sends | We emit |
| --- | --- |
| `agent_message_chunk` (text) | `text_delta`. One block per stretch of text; a tool call ends it, with `text`. |
| `tool_call` | `tool_start`: tool from `kind` (execute: Bash, edit: Edit, read: Read, fetch: WebFetch, search: Grep, else the kind), summary from `title` |
| `tool_call_update` completed or failed | `tool_end` (ok = completed) |
| thoughts, plans, commands, modes, session info, subagents | nothing |

The outcome comes from `session/prompt`'s `stopReason`:

- `end_turn`, `max_tokens` and `max_turn_requests` give `finished`;
- `cancelled` gives `interrupted`;
- `refusal` gives `failed` ("The model declined to answer.");
- an error reply gives `failed` with its message.

**Checkpoints and forks.** Cursor's agent has no `session/fork`, and the contract asks for checkpoints, so the
provider emulates them:

- **The turn log.** It keeps a text log of each session's turns: the prompt, and the reply's text. It uses the
  existing `SessionStore`, under `<cursor-home>/sessions`.
- **The checkpoint.** After each finished or stopped turn, the checkpoint is how many messages the log holds.
- **Stopped turns are logged too.** A turn that Stop ends is logged, even when the grace period or the process's
  exit ends it, because Cursor's session holds it either way.
- **A fork** (`resumeAt`) opens a new Cursor session. Its first prompt carries the conversation up to that
  checkpoint, as `<earlier_conversation>`, and the original session is left as it was.
- **What a fork keeps.** Only text carries over; the tool calls of earlier turns don't. A failed turn isn't logged.

**Permissions:** `session/request_permission {toolCall, options}`.

- **Approval requests.** When the options include `allow-once`, it's a real approval. It becomes a card: the tool
  from `kind`, `title` as the summary, and `rawInput` as the input. If the request has no input, the input of the
  matching `tool_call` is used; Cursor sends it there.
  - Allow gives `allow-once`, and deny gives the `reject-once` option.
  - `allow-always` is never chosen: standing grants are the gateway's.
  - Stop gives `{outcome: "cancelled"}`.
- **Questions.** Anything else is one of Cursor's questions. It gets its reject option ("Skip"), with no card.
- **Other requests** (`fs/*`, `terminal/*`, `cursor/*`) get a JSON-RPC error.

**Stop:** the `session/cancel` notification. If the prompt hasn't ended within 2 s, the process is killed anyway.
Setup and the prompt are raced against that end, so a setup step that hangs can't hold a stopped run: a slow
`session/load` replay, say. Nothing is emitted once the run has returned.

**Steps.** Updates carry only what changed, so each call's kind, title and input are remembered from its
`tool_call`:

- `think` calls never show;
- a repeated final update doesn't make a second step;
- kinds are looked up as own keys only.

### Isolation from the user's Cursor setup

The CLI reads the user's setup from their home folder:

- `~/.cursor/mcp.json` (MCP servers);
- `~/.cursor/hooks.json` and `~/.claude/settings.json` (hooks that run programs);
- plugins, rules and `cli-config.json`, including its approval mode and allowlist.

A bot must not inherit tools or hooks that act outside its workspace. So every run gets its own home folder,
`<dataDir>/cursor-home`: `HOME` and `USERPROFILE` point there, and so does `CURSOR_CONFIG_DIR` (at its `.cursor`).
That folder is kept between runs, so sessions can be resumed.

The sign-in is the user's own and is reused, never read or copied:

- **Windows:** `%APPDATA%\Cursor\auth.json`. `APPDATA` is left as it is.
- **Linux:** `$XDG_CONFIG_HOME/cursor/auth.json`, or `~/.config`. `XDG_CONFIG_HOME` is set to the real one.
  `CURSOR_CONFIG_DIR` still wins for the CLI's config.
- **macOS:** `~/.cursor/auth.json`. The isolated `.cursor/auth.json` is a symlink to the real file. We never open
  it.
  - The link is checked on every start. Cursor may refresh the sign-in by writing a new file in the link's place;
    if it has, that newer file is moved back over the user's own, and the link is made again.

**Hooks in the bot's workspace.** Cursor also runs `<workspace>/.cursor/hooks.json`, and the hooks in
`<workspace>/.claude/settings.json` and `settings.local.json`. A bot can write those files in its own workspace without asking, and the
hooks would then run programs, unasked, on its next start. So a run refuses to start while the workspace has either
kind of hook. The message names the file, for the user to look at.

### Registration and Settings

- **The provider:** `cursor` becomes `CursorProvider`, given the gateway's data dir.
- **Settings:**
  - **Configured** when `cursor-agent` is found: `CURSOR_AGENT_PATH` or the PATH.
  - **Models:** `listModels` opens a session in an empty temp folder and lists its `availableModels` ids.

## Interfaces

```ts
// stdio-rpc.ts
interface LineConnection { send(line: string): void; onLine(fn: (line: string) => void): void; onExit(fn: (detail: string) => void): void; close(): void }
function spawnLines(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): LineConnection
class Rpc { constructor(conn: LineConnection); handle(notify, request): void; request(method, params): Promise<Json>; notify(method, params?): void; ended?: string }
function findExecutable(command: string, env?, exists?): string | undefined

// cursor.ts
class CursorProvider implements AgentProvider   // id "cursor"
  constructor(opts: { homeDir: string; connect?: (cwd: string, signal: AbortSignal) => Promise<LineConnection>; command?: string; stopGraceMs?: number })
function isolatedEnv(homeDir: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): NodeJS.ProcessEnv
function workspaceHooks(workspaceDir: string): string | undefined   // the first hook file found
function firstPrompt(instructions: string, history: ChatMessage[], prompt: string): string
```

## Test plan

| Acceptance criterion | Shown by |
| --- | --- |
| Passes the provider contract test | `provider contract: cursor` (all of it, on a scripted ACP server) |

Other tests (`cursor.test.ts`):

- **Events:** chunks stream into one block, a tool call ends it, and tool calls become steps.
- **Sessions:**
  - `session/load` for a session, and its replay isn't emitted;
  - `session/new` otherwise, with the instructions in the first prompt;
  - the model set with `session/set_model`;
  - each turn's checkpoint;
  - a fork replays only the turns up to its checkpoint, in a new session, and leaves the original whole.
- **Permissions:**
  - allow and deny map to `allow-once` and `reject-once`;
  - Stop during one sends `cancelled`;
  - a question is skipped without a card.
- **Outcomes:** `cancelled` is interrupted, `refusal` fails, an error reply fails, and an unexpected exit fails with
  stderr.
- **Isolation:** `isolatedEnv` per OS. A workspace with hooks refuses to start.
- **Codex** still passes its tests on the shared plumbing.

**Live check:** with the owner's signed-in Cursor. Through the gateway, a bot on Cursor is asked for a one-line
reply with no tools. Check that:

- it streams and finishes;
- a second message resumes the same session;
- a roll back forks into a new session.

## Risks and open questions

- **The ACP command is hidden.** See the owner's decision above.
- **Global skills.** Skills Cursor serves for the account, not from local files, still show in its command list.
  They're instructions, not tools.

## Manual check (2026-11-28)

On the owner's signed-in Cursor CLI (2026.11.19), through a gateway on a throwaway data dir. The bot is "Cursor
check", switched to Cursor, on the default model (Auto):

1. **"Reply with … the word hello. Use no tools."** It streamed "hello" and finished in 7.1 s, with checkpoint
   `{session, "2"}`. Settings listed Cursor as configured.
2. **A second message.** It resumed the same session ("again"), with checkpoint `"4"`.
3. **A roll back to before the second message, then "What was the first word you replied with?"** It forked into a
   new session and answered "hello": the replayed turn carried over, and the rolled-back one didn't show.
4. **"Run the shell command `echo smarty-check` …"** An approval card appeared: Bash, "`echo smarty-check`".
   - Approving it ran the command: the status row was done, and the reply was "smarty-check".
   - This found that the card's input was empty: Cursor sends the input with the tool call. That's fixed, and a
     test covers it.
5. **Isolation.** The bots' Cursor home (`<data>/cursor-home`) held only the CLI's own fresh files, with none of
   the owner's MCP servers, hooks or settings, and the sign-in still worked.
6. **The `.cmd` shim.** It started through the shell with no Node warning.

