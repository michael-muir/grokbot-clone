# #66 Bot right-click menu: pin, copy id, hide, delete

Issue: #66 · Milestone: Phase 2 · Desktop app core · Requirements: none · Stories: none

## Goal

Right-clicking a bot in the sidebar (or Shift+F10 / the Menu key) opens the reference's context menu: pin or
unpin, copy the bot's id, hide it from the sidebar, or delete it, which asks for confirmation and removes its
conversation and computer.

## Scope

- In: the menu and its keyboard use; `pinned` and `hidden` on bots, saved by the gateway; showing hidden bots
  again; deleting a bot with confirmation; the gateway routes and their tests.
- Out (and where it goes instead): the reference's "Move to new section", "Mark as unread" and "New window"
  items (no sections or multi-window yet; with #16, Multiple bots), and creating bots (#16).

## Design

**Gateway.** `Bot` gains `pinned?: boolean` and `hidden?: boolean`. `PATCH /bots/:id` accepts both, as booleans
(400 otherwise). The main bot is the first in the registry (`BotRegistry.mainId()`): it can't be hidden (409)
or deleted (409); it's always at the top of the sidebar.

`DELETE /bots/:id` → 204. `Gateway.deleteBot` refuses the main bot and a bot that's running (409; stop it first,
so nothing writes into what's being deleted), and no run may start while a delete is under way. Files go first,
the registry entry last: the computer (`ComputerManager.remove`, with retries for files Windows still holds),
then the transcript (`TranscriptStore.forget`: the file, the bot's folder once empty, memory). If a file can't
be deleted, the bot is kept and the user is told to close whatever uses it and try again (500 with that
message). Open event streams for the bot end. The bot id is checked against `[a-z0-9-]+` before it becomes a
path.

**App.** `deleteBot` joins the IPC calls; `updateBot` patches may carry `pinned` and `hidden`.

- `sidebar-state.ts`: `sidebarLayout(bots, showHidden)` → `{top, rest, hiddenCount}`. Above the divider: the
  main bot, then pinned bots. Below: the rest. Hidden bots appear only when shown, in their usual place, dimmed.
  `menuFor(bot, isMain)` lists the items: Pin/Unpin, Copy bot ID, Hide from sidebar/Show in sidebar, Delete;
  the main bot gets only Copy bot ID. `afterDelete` moves the open chat to the main bot.
- `BotMenu.tsx`: `role="menu"` positioned beside the tile as in `39-sidebar-ctx.png`, separators before Copy and
  Hide. Focus goes to the first item; Up/Down/Home/End move; Enter activates; Escape, Tab, a click elsewhere,
  window blur or resize close it and return focus to the tile.
- `DeleteBotDialog`: `role="alertdialog"`, "Delete Nova?" / "This removes Nova's conversation and every file on
  its computer. It can't be undone." Cancel has focus (Enter alone never deletes), Tab stays inside, Escape
  cancels. A refusal (still working) shows in the dialog.
- Hiding the open bot moves the chat to the main bot, as deleting it does.
- Escape and Tab close the menu back onto the tile; a click elsewhere leaves focus where the user clicked.
- After an action, focus returns to the bot's tile once the change has rendered. A pinned tile moves in the
  list, which drops its focus, so this runs from an effect after the commit. A hidden or deleted bot's focus goes
  to the main bot.
- An eye button in the sidebar footer appears while bots are hidden: "Show hidden bots (n)" / "Leave hidden
  bots out" (`aria-pressed`).

New tokens: `--size-menu-w`, `--size-menu-item`, `--size-dialog-w`.

## Interfaces

- `PATCH /bots/:id` `{pinned?: boolean, hidden?: boolean}`; `DELETE /bots/:id` → 204 / 404 / 409
- `GatewayClient.deleteBot(botId)`, IPC `deleteBot`
- `BotRegistry.mainId()`, `BotRegistry.remove(id)`, `TranscriptStore.forget(botId)`, `ComputerManager.remove(botId)`

## Test plan

| Task (from the issue) | Shown by |
| --- | --- |
| Context menu (right-click and Shift+F10 / Menu key), keyboard navigable | Manual check over CDP (below); `sidebar: each bot's menu follows its state…` |
| Pin / Unpin, persisted | `bots: pinned and hidden are saved and survive a restart…`, `sidebar: the main bot and pinned bots sit above the divider…`, manual check |
| Copy bot ID | Manual check: clipboard read back `nova` |
| Hide from sidebar, and a way to show hidden bots | `sidebar: … hidden bots only when asked`, manual check |
| Delete, with a confirmation that says what is removed | `bots: deleting removes the bot, its transcript and its computer…`, `bots: the main bot and a running bot can't be deleted`, manual check |
| Gateway routes for hide and delete, with tests | `HTTP: PATCH pinned/hidden, DELETE a bot, and the refusals`; IPC refusals in `ipc.test.ts` |

## Risks and open questions

- Deleting can't be undone. The dialog says so, defaults to Cancel, and the gateway refuses while the bot runs.
