# #17 Start fresh, roll back, and thread from a message

Issue: #17 · Milestone: Phase 3 · Bots, cards and polish · Requirements: BC-2 · Stories: US-10

## Goal

Three ways to change a conversation's direction:

- **Start fresh:** begin a new conversation with a bot, keeping the old one readable.
- **Roll back:** take the conversation back to before one of your messages. The bot forgets everything from there
  on, and your message goes back in the composer to change and resend.
- **Thread:** reply to one message in a side conversation, without derailing the main chat.

## Scope

- In:
  - Start fresh from the bot's sidebar menu.
  - Roll back from a user message's hover actions, in the main chat or in a thread.
  - "Reply in a thread" from a user or bot message's hover actions. This opens a thread view with "Back to chat",
    and the root message shows how many replies its thread has.
  - Provider support for the forking all of these rely on: Claude, the built-in loop (OpenAI-compatible, Gemini,
    Ollama and so on) and the fake provider.
- Out:
  - A sidebar list of a bot's threads ("Threads for …"); threads open from their root message.
  - Threads inside threads.
  - The reference's other hover actions (reactions, copy, feedback): those are #18, which adds them to the hover bar
    built here.
  - Start fresh and roll back buttons on errors. The reference offers them when a provider blocks a message, which
    we don't detect yet.
  - Undoing a roll back. Rolled-back entries stay in the log, hidden, so this could be added later.

## Reference

From the reference's renderer and coordinator, read-only (`app.asar`, as in #43):

- The gateway has `startFreshConversation`, `rollBackConversation` and `createThreadFromMessage(entry_id)`.
- Start fresh asks "Reset this conversation?" ("The conversation history starts over… memory, files, routines,
  and settings are kept"). The confirm button is "Reset", and Cancel has the focus.
- Roll back puts the rolled-back user message back into the composer when the composer is empty.
- Entries carry `replyTo` (thread) and `branched` (forked). The hover bar on a message is react, "Reply in a
  thread" (a reply arrow) and more (36-msg-hover.png, 38-msg-more.png). A thread view has "Back to chat".

The words and icons here are our own.

## Design

### One mechanism: forking a provider session at a checkpoint

Each of the three features restarts a provider session from an earlier point:

| Feature | Restarts from |
| --- | --- |
| Start fresh | no session |
| Roll back | the end of the run before the rolled-back message |
| Thread | the end of the run that holds the root message |

How providers support this:

- **Checkpoints.** During a run, a provider reports `{ type: "checkpoint", at }`: an opaque string naming the point
  its session has reached. The last one counts. The gateway saves it, with the session id, on the run entry as
  `checkpoint: { sessionId, at }`.
- **Resuming from a checkpoint.** `RunRequest.resumeAt` asks the provider to continue `sessionId` from that point
  in a **new** session. The original is never changed, so older checkpoints stay valid. The new session's id
  arrives as the usual `session` event.

Per provider:

- **Built-in loop:** the checkpoint is the number of messages saved. Resuming copies that many messages into a new
  session file. A checkpoint past the end of the session fails the run with a clear error.
- **Claude:** the checkpoint is the uuid of the last top-level message in the session's chain (assistant, or user
  with tool results). Resuming passes `resume`, `resumeSessionAt` and `forkSession: true`. That is the SDK's
  documented truncating fork, and the fork point is the last entry of the kept turn, as the SDK asks.
- **Fake:** keeps each session's prompts in memory. The checkpoint is their count, and the prompt `/history` lists
  them, so tests can see what a session remembers.

A new contract test holds every provider to this: a finished run reports a checkpoint, and a run with `resumeAt`
continues in a new session.

### Conversations and where their sessions live

A bot has a main conversation and any number of threads.

- **Thread entries:** an entry in a thread carries `threadId`, the id of its root entry in the main chat.
- **Main session:** stored on the bot as before (`sessionId`, `sessionProvider`), plus `sessionAt`, a checkpoint to
  fork from on the next run.
- **Thread sessions:** stored in `threadSessions[rootId]` with the same three fields.
- **Not public:** all of it is the gateway's business and left out of `PublicBot`.
- **Provider switch:** switching provider drops every session, threads included.
- **Busy:** a run in a thread occupies the bot like any run (one run per bot).

When a run starts with a pending `sessionAt`, it's passed as `resumeAt`. The first `session` event of the run then
replaces the session id and clears `sessionAt`. If the run fails before that event, the fork is tried again next
time.

### Start fresh (main conversation)

`POST /bots/:id/fresh`. It's refused while the bot runs or is being deleted.

- It clears the main session and appends a notice: "New conversation. Earlier messages stay above for reference."
- The notice carries `reset: true`, which marks the boundary that a roll back never forks across.
- The provider-switch notice gets `reset: true` too, since it also starts the conversation over.
- Threads keep their own sessions.
- In the app: a "Start fresh" item in the bot's sidebar menu, then a confirmation ("Start a new conversation?",
  with Cancel focused). Its text says the bot won't remember the conversation, the messages stay to read, and its
  files and settings are kept.

### Roll back

`POST /bots/:id/rollback {entryId}` returns `{ text }`, the rolled-back message's text.

- **Refused** while the bot runs, and for anything but a visible user message.
- **Hidden:** that message and every later entry of the same conversation get `hidden: true`. The entries stay in
  the log, and each change streams to clients like any update. Rolling back the main chat also hides the threads
  whose root is hidden, and drops their sessions.
- **The session goes back.** The gateway walks back from the message through the visible entries of the same
  conversation.
  - Runs with no checkpoint are skipped, since their session never changed.
  - The first run with a checkpoint, on the bot's current provider, becomes the fork point (`sessionAt`).
  - Reaching a `reset` notice, a run on another provider, or the start of the conversation means there's nothing to
    keep. A main chat then starts fresh, and a thread forks again from its root.
- **In the app:** a "Roll back to here" button on user messages, then a confirmation ("Roll back to this
  message?", with Cancel focused). Afterwards the message's text goes into the composer, if it's empty, ready to
  edit and resend.

### Threads

`POST /bots/:id/messages` takes an optional `threadId`.

- **Root:** must be a visible, main-chat user or bot message. A thread starts with its first message; there's no
  separate "create" call, so an opened but unused thread leaves nothing behind.
- **First message:** its session forks from the checkpoint of the root's run. The user message now carries its
  run's id as `runId`, so a user-message root finds its run. Older entries fall back to the first run after the
  root.
- **What the model sees:** the first prompt is prefixed with the root's text, quoted, up to 500 characters:
  "(Replying in a thread to: "…")". This tells the model which message the thread is about. If no fork point exists,
  this quote is all the context it gets. The transcript shows only what the user typed.
- **Main view:**
  - A message's hover bar has "Reply in a thread".
  - A root with replies shows a "1 reply" / "N replies" button under it.
  - Either one opens the thread view.
- **Thread view:**
  - The header gets a "Back to chat" button and the title "Thread".
  - The root comes first, then the thread's entries.
  - The composer says "Reply in thread", and the thread keeps its own draft.
  - Escape on the empty composer, or "Back to chat", returns to the chat.
- **Stays open:** sending in a thread keeps you there. The main chat shows nothing of the thread except the replies
  button.

### Display

- `rows.ts` gets the entries of one view:
  - main: not hidden, no `threadId`;
  - thread: the root, then the thread's visible entries.
- Pending messages carry their `threadId`, so they show in the right view.
- Entry rows gain `replies?: number` and `actions?: { thread; rollBack }`, so the memoized row re-renders when they
  change.
- **Hover bar:** small icon buttons at the bubble's outer edge, shown on hover or keyboard focus. Each has an
  `aria-label` and a tooltip:
  - "Reply in a thread" (main view only);
  - "Roll back to here" (user messages only).

  They're always reachable with Tab, so the keyboard can use them, and they show while focused.
- **Confirmations:** both use one `ConfirmDialog`, generalized from the delete dialog (Cancel focused, Escape
  cancels, Tab stays inside).

## Interfaces

```ts
// server/src/types.ts
interface TranscriptEntry { …; threadId?: string; hidden?: true }
EntryBody notice: { kind: "notice"; text: string; reset?: true }
EntryBody run: { …; checkpoint?: { sessionId: string; at: string } }
ProviderEvent: | { type: "checkpoint"; at: string }
RunRequest: { …; resumeAt?: string }
interface ConversationSession { sessionId?: string; sessionProvider?: ProviderId; sessionAt?: string }
Bot: { …; sessionAt?: string; threadSessions?: Record<string, ConversationSession> }
PublicBot = Omit<Bot, "sessionId" | "sessionProvider" | "sessionAt" | "threadSessions">

// Gateway
startFresh(botId): void
rollBack(botId, entryId): { text: string }
sendMessage(botId, text, clientNonce?, threadId?)

// TranscriptStore
hide(botId, ids: string[]): void

// HTTP
POST /bots/:id/messages  {text, clientNonce?, threadId?} -> 202 {entryId}; 400 bad thread
POST /bots/:id/fresh     -> 200 {ok}; 409 while running
POST /bots/:id/rollback  {entryId} -> 200 {text}; 400 not a visible user message; 409 while running

// GatewayClient and IPC
startFresh(botId), rollBack(botId, entryId) -> string, sendMessage(botId, text, nonce?, threadId?)
```

## Test plan

| Acceptance criterion | Shown by |
| --- | --- |
| Start fresh: new conversation, old one stays readable | `conversation: start fresh drops the session, keeps every entry, and marks the boundary`; `start fresh is refused while the bot is working`; manual check (below) |
| Roll back: hide later entries and reset the provider session to that point | `conversation: roll back hides the message and everything after it, and the next run forks from the run before`; `roll back to the first message starts the conversation over`; `roll back never forks across a fresh start or a provider switch`; `roll back is refused for bot messages, hidden entries and while working`; provider contract `a run from a checkpoint continues in a new session`; `loop: resuming at a checkpoint copies that much history into a new session`; `claude: resuming at a checkpoint forks the session there`; manual check |
| Create a thread from a message | `conversation: a thread's first message forks from the root's run and quotes the root`; `thread messages stay out of the main conversation and keep their own session`; `a thread can't start from a hidden, threaded or non-message entry`; `rows: the main view leaves out hidden and thread entries, and counts replies`; manual check |

Other tests:

- `transcript: hide marks entries hidden, bumps updatedSeq, and survives a reload`.
- `bots: a provider switch drops thread sessions and a pending fork too`.
- `http: fresh, rollback and thread sends map refusals to 400/409`.
- `ipc: the new calls' arguments are checked`.
- The fake's `/history`, as used by the gateway tests above. These tests show, end to end, what the next run
  remembers.

**Manual check, 2026-11-27.** In the app, with the fake provider, in an isolated profile on port 9411:

- **Roll back:**
  - I sent "apples", "pears" and "plums".
  - Hovering "pears" showed the hover bar beside the bubble, where the reference puts it.
  - "Roll back to here" asked first, with Cancel focused.
  - After confirming, only "apples" and its reply were left, and "pears" was back in the composer, focused.
  - `/history` answered that it remembered "apples" and nothing after it.
- **Thread:**
  - "Reply in a thread" on the first reply opened the thread view: "Back to chat", "Thread", the root, and "Reply in
    thread".
  - The first reply in the thread quoted the root.
  - Back in the chat, the root showed "2 replies".
  - Escape in the empty composer went back to the chat.
- **Start fresh:**
  - "Start fresh" in the bot's menu asked "Start a new conversation?", with Cancel focused.
  - After confirming, the notice marked the boundary and the old messages stayed above.
  - `/history` answered that it remembered nothing.
- **Keyboard:**
  - Tab from the chat reaches "Reply in a thread", then "Roll back to here". The bar shows with a focus ring.
  - In the dialogs, Tab stays inside, Escape cancels, and focus returns to the tile.
- **Reduced motion:** the hover bar only fades in (opacity), like the row times. There's no movement to turn off.

The check found three bugs, all fixed before review:

- **Two transcripts on screen.** Opening a thread left the main chat's transcript in place. The transcript and the
  composer had the same React key, so they now have distinct ones.
- **A roll back's text reappeared.** It came back in the next composer shown (a thread's). It's now used once.
- **Focus in the start fresh dialog.** Choosing Start fresh from the menu gave focus back to the tile instead of
  the dialog's Cancel. It's now handled like Delete.

## Risks and open questions

- **Claude refusing a fork.** The SDK can refuse a truncating fork when the discarded range holds something it
  can't attribute to the dropped turn. The run then fails with the SDK's message, and Start fresh is the way out.
  We don't pass `resumeDropsTurn`, so the unvalidated truncation is used.
- **Old transcripts.** Their runs have no checkpoints, so rolling back in them starts fresh, and threads from them
  rely on the quote alone.
- **Files aren't rolled back.** Files the bot changed on its computer stay changed. The confirmation says so.
