# #2 Built-in agent loop for raw model APIs

Issue: #2 · Milestone: Phase 1 · Requirements: PR-1, PR-3, AG-1, AG-2 · Stories: US-4

## Goal

Any chat model that supports function calling can act as an agent: it streams replies, calls tools in the bot's
workspace, and asks the user before anything that writes or runs commands. The model-specific part shrinks to a
small adapter (#3 OpenAI-compatible, #4 Gemini).

## Scope

- In: the model adapter interface; the loop (`LoopProvider`); core tools (shell, read, write, edit, list,
  search); session history storage so runs resume; approvals; step limit; interrupt; tests on a scripted model.
- Out: real model adapters (#3, #4); per-bot provider settings and keys (#5); token and cost reporting (#21);
  sandboxing (#27). The loop's tools run in the bot's workspace folder, which is not a sandbox yet. The shell can
  reach anything the user can, which is why every shell command needs an approval.

## Design

```
gateway ──run()──▶ LoopProvider ──stream()──▶ ModelAdapter (OpenAI-compatible, Gemini, scripted in tests)
                       │  ▲
                       │  └── tool results go back to the model as messages
                       ├──▶ Tools (read-only run directly; others ask through requestApproval)
                       └──▶ SessionStore (message history per session, JSON on disk)
```

### One run

1. Load the session's history (or start a new session) and append the user's prompt.
2. Call the model with the system prompt, history and tool definitions. Stream its text as `text_delta` events
   (block id `<turn>:<step>`), then end the block with a `text` event.
3. If the model asked for no tools, the run is `finished`.
4. Otherwise, for each tool call in order: emit `tool_start`; if the tool isn't read-only, `requestApproval`
   (with `req.signal`); run it or report the denial; emit `tool_end` (`ok` is false for a denial, an error or an
   unknown tool); add the result to the history.
5. Save the history and go back to step 2, up to `maxSteps` (default 25). Hitting the limit ends the run as
   `failed` with "Stopped after 25 steps without finishing."
6. On abort at any point: stop the model stream and any running command, save the history, return
   `interrupted`. A denial is not a failure: the model is told "The user denied this: <reason>" and carries on.
7. A model or adapter error ends the run as `failed` with its message; `run()` never throws.

History stays valid for every API: if a run stops between a model's tool calls and their results, each
unanswered call gets a result saying the run was stopped before it ran.

### Model adapter

The only part each model API implements. Messages use our own neutral format; each adapter converts them.

### Tools

| Tool | Read-only | Does |
| --- | --- | --- |
| `read_file` | yes | Reads a text file (optionally a line range), capped at 100 KB |
| `list_files` | yes | Lists files matching a glob, up to 500, skipping `.git` and `node_modules` |
| `search_files` | yes | Regex search across files, up to 200 matches |
| `write_file` | no | Creates or overwrites a file |
| `edit_file` | no | Replaces one exact, unique string in a file |
| `shell` | no | Runs a command in the workspace; PowerShell on Windows, the user's shell (or `/bin/sh`) elsewhere; 2-minute default timeout; output capped at 30,000 characters (head and tail kept) |

File tools resolve paths inside the workspace and refuse any path that leaves it (`..`, absolute paths
elsewhere, symlinks pointing out). The shell runs with the workspace as its working directory. On abort or
timeout, its whole process tree is killed (`taskkill /T` on Windows, the process group elsewhere).

Each tool has a short summary for its status row, matching the Claude adapter's wording ("Running npm test",
"Reading notes.md").

### Sessions

`SessionStore` keeps each session's messages in `<dataDir>/sessions/<id>.json`, written after every step. The
session id is a random UUID; a run with a known `sessionId` continues it, an unknown one starts fresh under that
id.

## Interfaces

```ts
// server/src/agent/model.ts
type ChatMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; output: string; isError: boolean };
interface ToolCall { id: string; name: string; input: Record<string, unknown> }
interface ToolSpec { name: string; description: string; inputSchema: JsonSchema }
interface ModelRequest { model?: string; system: string; messages: ChatMessage[]; tools: ToolSpec[] }
type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "done"; usage?: { inputTokens: number; outputTokens: number } };
interface ModelAdapter { stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> }

// server/src/agent/tools.ts
interface Tool {
  spec: ToolSpec;
  readOnly: boolean;
  summarize(input: Record<string, unknown>): string;
  run(input: Record<string, unknown>, ctx: { workspaceDir: string; signal: AbortSignal }): Promise<ToolResult>;
}
interface ToolResult { ok: boolean; output: string }

// server/src/agent/loop.ts
new LoopProvider({ id: ProviderId; adapter: ModelAdapter; sessions: SessionStore; tools?: Tool[]; maxSteps?: number })
```

## Test plan

| Acceptance criterion | Shown by |
| --- | --- |
| Passes the provider contract test | `provider contract: loop` suite, on a scripted model adapter |
| Approval cards appear exactly as with the Claude adapter | Contract approval tests (same rules as Claude), plus a gateway test that the loop's shell call creates a pending `approval` entry with the tool and summary |
| A run stops within 2 s of interrupt | Contract interrupt tests (mid-stream and during an approval), plus a test that a running `shell` command is killed on abort |

Other tests: read-only tools run without approval; a denial reaches the model as a tool result; an unknown tool
and a tool error are reported to the model, not thrown; the step limit; history saved and resumed across runs;
unanswered tool calls are filled after an interrupt; each file tool refuses paths outside the workspace; edit
refuses a missing or repeated string; shell output is truncated; shell timeout.

## Risks and open questions

- Shell differences across systems: commands the model writes for bash won't run in PowerShell. The system
  prompt states the OS and shell so the model writes the right syntax.
- No sandbox until #27. Approvals are the only protection for writes and commands.
