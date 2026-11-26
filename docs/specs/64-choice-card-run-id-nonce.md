# #64 Choice card, run id, client nonce

Issue: #64 · Milestone: Phase 2 · Requirements: TR-3, CD-1 · Source: the #7 capture (`reference/BEHAVIOR.md` 5a)

## Goal

Close the transcript gaps found in the Grok Bot capture that the next issues need:
- **Choice card:** the bot can ask a question with lettered choices, as in onboarding ("What would you like to
  call me?").
- **Run id:** entries written during a run carry its id, so the UI can group a run's rows.
- **Client nonce:** a message the user sends shows at once, and the gateway's copy replaces it.

## Scope

- In:
  - the `choice` entry kind
  - the answer route, gateway, client and IPC for it
  - the `ask_user` tool in the built-in agent loop (OpenAI-compatible providers, Ollama, Gemini)
  - the choice card in the chat
  - `runId` on run entries
  - `clientNonce` on sent messages, with a pending bubble in the chat
- Out:
  - Claude asking questions. Claude Code has its own `AskUserQuestion` tool, and wiring it needs the SDK's
    answer format checked live. A follow-up issue covers it.
  - Choices posted by the app itself (onboarding), which is #14, using the same entry kind.

## Design

### Types (`server/src/types.ts`)

```ts
| { kind: "user_message"; text: string; clientNonce?: string }
| { kind: "choice"; prompt: string; options: { label: string; value: string }[]; allowCustom: boolean;
    state: "pending" | "answered" | "expired"; answer?: string }

interface TranscriptEntry { …; runId?: string }   // the run entry's id, on entries written during that run
interface ChoiceRequest { prompt: string; options: { label: string; value: string }[]; allowCustom: boolean }
interface RunCallbacks { …; requestChoice?(req: ChoiceRequest, signal: AbortSignal): Promise<string | undefined> }
```

`requestChoice` resolves with the answer, or with `undefined` when the run is stopped. In that case the card is
marked expired.

### Gateway

- `ApprovalBroker` becomes a generic `Waiters<T>` (answer by entry id, or a fallback value on abort). It's used for
  both approvals and choices.
- `Gateway.answerChoice(botId, entryId, answer)` returns false unless that card is pending.
- An answer must be one of the options' values, or any text of 1–500 characters when `allowCustom` is set.
- `sendMessage(botId, text, clientNonce?)` stores the nonce on the user entry.
- Entries appended in `execute` get `runId`.

### HTTP

- `POST /bots/:id/choices/:entryId {answer}` answers a card: 200, 400 for a bad answer, 404 when there is no
  pending card.
- `POST /bots/:id/messages` accepts an optional `clientNonce`: a string of 1–100 characters.

### Agent loop

- The `ask_user` tool takes `{ question, options: string[] (2–6), allow_other?: boolean }`. It's read-only, so it
  needs no approval.
- It calls `ctx.ask`, which the loop wires to `cb.requestChoice`.
- The tool result is the user's answer. When the run is stopped, the result says so.
- When a provider has no `requestChoice`, the tool reports that it can't ask questions here.

### Renderer

- **`ChoiceCard`:** the reference's widget card. The prompt is 600 15/22 tertiary, and each choice is a row with a
  letter key cap (A, B, C…) and its label.
  - With `allowCustom`, a last row reads "Something else…" and opens a text field.
  - Once answered, the card shows the chosen answer and the other choices dim.
  - While a send is in flight, the controls are disabled.
- **Pending bubble:** `Chat` keeps sent-but-unconfirmed messages by nonce.
  - `buildRows` takes them as `pending` rows: user bubbles at 0.6 opacity.
  - Each one disappears when an entry with the same nonce arrives, or when the send fails. A failed send keeps the
    draft, as today.

## Test plan

| Task (from the issue) | Shown by |
| --- | --- |
| Add a `choice` entry kind with an answer route | Gateway tests: answering a pending card resumes the run and records the answer; a bad answer is refused (400); stopping marks the card expired; HTTP route. Loop test: `ask_user` returns the answer to the model. IPC validation test |
| Add `runId` to entries written during a run | Gateway test: every entry after the user message in a run carries the run entry's id; the user message has none |
| Accept a client nonce on send and echo it | HTTP test: the nonce comes back on the user entry; an invalid nonce gets 400. Rows test: a pending row shows until an entry with its nonce exists |

Manual check: with Ollama, ask the bot to "ask me to pick a color with the ask_user tool", answer in the card, and
see the reply use it. Also, a sent message appears at once.
