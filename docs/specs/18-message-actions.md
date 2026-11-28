# #18 Message hover actions: reactions, copy, feedback

Issue: #18 · Milestone: Phase 3 · Bots, cards and polish · Requirements: BC-3, UI-4 · Stories: US-11 · Builds on #17

## Goal

The hover bar on a message (added in #17) does what the reference's does:

- react with an emoji;
- reply in a thread;
- open a "more" menu: copy the message, roll back to it (your own messages), and rate a bot message as a good or
  bad response.

Reactions and ratings are saved with the conversation.

## Scope

- **In:**
  - The hover bar in the reference's order: React, Reply in a thread, More.
  - The reaction picker: 👍 👎 ❤️ 😂 🎉.
  - Reactions shown under the message. Clicking one removes it.
  - The More menu: Copy, Roll back to here (your messages), Good response and Bad response (bot messages).
  - Saving all of it in the transcript.
- **Out:**
  - **A full emoji picker:** the reference's "add more" button. A fixed set is enough for now.
  - **Ratings with categories and a comment:** the reference's feedback vote takes them. The API shape leaves room
    for them.
  - **Sending anything anywhere.** Reactions and ratings stay on this machine. They aren't shown to the model and
    aren't sent to any service, because there's no feedback service to send them to.
  - **"Copy request ID":** we have no request ids worth copying.

## Reference

- **Screens:** 36-msg-hover.png (react, reply, more), 37-reaction.png (the picker: 👍 👎 ❤️ 😂 🎉 and "add more")
  and 38-msg-more.png (the more menu: Copy, Copy request ID).
- **Gateway calls:** `ReactToGrokBotMessage{entry_id, emoji}` and `VoteGrokBotFeedback{entry_id, action, categories,
  comment}`.
- **Our own work:** the icons and words are our own.

## Design

### Gateway

`TranscriptEntry` gains two fields:

- **`reactions?: string[]`:** the user's reactions, in the order added, each once.
- **`feedback?: "up" | "down"`:** the user's rating of a bot message.

Both are written with a new `TranscriptStore.mark(botId, id, patch)`. It's the same in-place update as `hide` (now
built on it): `updatedSeq` goes up, the change streams to clients, and it's kept across restarts.

The gateway owns the rules, through two methods:

- **`react(botId, entryId, emoji, on)`:**
  - Adds or removes one reaction.
  - The emoji must be one of `REACTIONS`.
  - The entry must be a visible message, yours or the bot's.
- **`rate(botId, entryId, vote)`:**
  - Sets or clears (`null`) a bot message's rating.
  - A user message can't be rated.

Neither waits for a run to end: reacting to a reply that's still streaming is fine.

HTTP:

- `POST /bots/:id/entries/:entryId/reactions {emoji, on}` returns 200 with `{reactions}`.
- `POST /bots/:id/entries/:entryId/feedback {vote: "up" | "down" | null}` returns 200 with `{feedback}`.
- Both answer 400 for a bad body or an entry that can't take it.

### App

**Hover bar** (`ChatRow`): icon buttons beside the bubble, as in #17. They show on hover and on keyboard focus.

- **React** opens the picker.
- **Reply in a thread:** main chat only.
- **More** opens the menu:
  - **Copy:** copies the message's text, as written (a bot message's Markdown source). The button then says
    "Copied" for a moment, and a screen reader hears it.
  - **Roll back to here:** your messages only.
  - **Good response / Bad response:** bot messages only. They're check items, and choosing the checked one clears
    it.

**Picker and menu:** popups beside their button, kept inside the window.

- **Keyboard:** arrow keys move between items, Home and End jump to the ends, and Escape or Tab closes. Focus goes
  back to the button that opened them.
- **Closing:** a click elsewhere, scrolling the chat, a resize or the window losing focus also closes them.
- **Shared code:** the menu reuses the bot menu's popup, generalized from `BotMenu` into `PopupMenu`.
- **Portal:** popups render on `document.body`. Inside the chat, the virtualized list's transform would make
  `position: fixed` relative to the list, not the window.
- **Toggle:** clicking the open button again closes its popup.

**Reactions** show under the bubble as small chips.

- Each chip is a button: "Remove 👍".
- A message with reactions keeps them visible without hovering.

**Rows** (`rows.ts`): `RowActions` becomes `{ react, thread, copy, rollBack, rate }`, all booleans. The last three
fill the More menu.

**Hover bar changes:** "Roll back to here" moves from its own icon into More, as in the reference, where the bar has
three buttons.

## Interfaces

```ts
// server/src/types.ts
export const REACTIONS = ["👍", "👎", "❤️", "😂", "🎉"] as const;
interface TranscriptEntry { …; reactions?: string[]; feedback?: "up" | "down" }

// TranscriptStore
mark(botId, id, patch: { hidden?: true; reactions?: string[]; feedback?: "up" | "down" | undefined }): TranscriptEntry

// Gateway
react(botId, entryId, emoji, on): string[]
rate(botId, entryId, vote: "up" | "down" | null): "up" | "down" | null

// HTTP, GatewayClient, IPC (react, rate)
POST /bots/:id/entries/:entryId/reactions {emoji, on}       -> 200 {reactions}
POST /bots/:id/entries/:entryId/feedback  {vote}            -> 200 {feedback}
```

## Test plan

| Acceptance criterion | Shown by |
| --- | --- |
| React, copy, thumbs up/down, reply in thread | `rows: the hover bar offers react and more on every message, a thread in the main chat, roll back for yours and ratings for the bot's`; manual check of each button (below) |
| Persist reactions and feedback | `messages: reactions are added once, removed, and kept across a restart`; `messages: a bot message's rating is set, changed and cleared, and kept across a restart`; `messages: only visible messages take reactions, only bot messages take ratings, only known emoji`; `http: reactions and feedback answer 200, and 400 for what they refuse` |

Other tests:

- `transcript: mark changes an entry in place and streams it`.
- `ipc: react and rate arguments are checked`.

**Manual check, 2026-11-27.** In the app, on the fake provider, in an isolated profile on port 9411:

- **Hover bar:** a bot message shows React, Reply in a thread and More, in the reference's order.
- **Reactions:**
  - The picker opens under its button with focus on 👍.
  - Arrow keys and Enter react, and the chips show under the bubble.
  - Clicking ❤️ removed it.
  - Focus went back to "Add reaction".
- **Copy:** the clipboard held "Nova here. You said: apples". The More button and the status region both said
  "Copied".
- **Rating:** "Good response" showed checked the next time the menu opened. Escape closed the menu and focus went
  back to More.
- **Your messages:** More has Copy and Roll back to here. Roll back to here opens #17's confirmation.
- **Restart:** after stopping and relaunching the app on the same data, the 👍 reaction and the Good response
  rating were still there.

This check found the picker opening about 100 px off. Inside the virtualized list, `position: fixed` is relative to
the list's transform, so the popups now render in a portal.

## Risks and open questions

- **Feedback goes nowhere.** It's saved and shown back to the user only. When the product has a feedback channel,
  sending it will need the owner's decision and consent.
