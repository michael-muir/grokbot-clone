# #23 Search palette and keyboard shortcuts

Issue: #23 · Milestone: Phase 3 · Bots, cards and polish · Requirements: UI-4 · Stories: US-23

## Goal

**Ctrl+K** opens a palette that finds bots, messages and actions. **Ctrl+/** opens a sheet of the keyboard
shortcuts, and every shortcut on it works.

## Scope

- **In:**
  - The palette (bots, messages across all bots, actions).
  - `GET /search`.
  - Jumping to a found message, in its bot and thread, scrolled into view and highlighted for a moment.
  - The shortcuts sheet.
  - The shortcuts behind the features we have.
- **Out:** the reference's shortcuts for features we don't have yet, which aren't bound or listed:
  - compact sidebar;
  - find in chat;
  - dictate;
  - add selection;
  - back and forward;
  - the Ctrl+Tab switcher;
  - skills;
  - connected apps;
  - group chat.

  The palette's actions likewise only offer what exists.

## Reference

**`26-search.png`:** a panel near the top with a large input, "Search Bots, Chats, Settings…".

- A **Bots** section lists each bot's avatar, name, and its latest message.
- An **Actions** section has New Bot, New group chat, Keyboard shortcuts (Help), Connect Apps and Check for Updates.

**`25-shortcuts.png`:** "Keyboard shortcuts" in two columns (Essentials, Chat, Navigation, Panels, Window), each
row a name with key caps.

Our version keeps the shapes, with our own words and our list.

## Design

### Shortcuts (`shell/shortcuts.ts`, pure)

`SHORTCUTS` is the one list: an id, a label, an optional hint, a section, and its keys. The sheet renders it.
`matchShortcut(event, isMac)` returns the action for a key event. The modifier is ⌘ on macOS and Ctrl elsewhere.

| Section | Shortcut | Keys |
| --- | --- | --- |
| Essentials | Search | Mod+K, or Mod+Shift+F |
| Essentials | New bot | Mod+N |
| Essentials | Send (hint: "Shift+Enter for a new line") | Enter |
| Essentials | Go to bot | Mod+1–9 |
| Essentials | Settings | Mod+, |
| Essentials | Keyboard shortcuts | Mod+/ |
| Chat | Focus the message box | Mod+I |
| Chat | Stop the reply | Esc, in the message box while it's running |
| Navigation | Previous / next bot | Alt+↑ / Alt+↓ |
| Panels | Bot details | Mod+Alt+B |
| Window | Zoom | Mod+= / Mod+− / Mod+0 |
| Window | Full screen | F11 (macOS: Ctrl+⌘+F) |

Rows marked "listed only" below are already handled elsewhere, so they appear on the sheet without a new binding:

- Settings (the app menu's accelerator);
- zoom and full screen (the View menu's roles);
- Send (the composer).

**Stop with Esc** is new: the composer's Escape stops a running reply when its field is empty. That's the same
gesture as leaving a thread, which only applies outside a run.

**One window listener** (`keydown`, in `App`) acts on matches, skipping events already handled. While a dialog is
open (Settings, a confirmation, the palette, the sheet), only Escape reaches that dialog. Go to bot follows the
sidebar's order: pinned bots, then the rest, the same order the tiles show, without hidden bots.

### Search (`server/src/search.ts`, pure; `GET /search?q=`)

**`searchTranscripts(bots, entriesByBot, q, limit = 20)`** returns:

- **Previews:** each bot's latest visible message (user or bot), cut to 120 characters, for the Bots section.
- **Messages:** with a query of at least 2 characters, the latest visible messages whose text contains it
  (case-insensitive, the words in order), newest first. Each has `{ botId, entryId, threadId?, snippet, createdAt }`.
  The snippet is about 100 characters around the first hit.

Hidden (rolled-back) entries are skipped, and so are secrets: transcripts never hold them (#20).

**HTTP:** `GET /search?q=…` returns `{ previews: {botId, text}[], messages: Hit[] }`. A query over 200 characters
gets a 400.

### Palette (`shell/SearchPalette.tsx`)

**Layout:** a modal near the top, like the reference.

- The input is `role="combobox"`, with `aria-controls` on the list and `aria-activedescendant` on the active option.
- The list holds sections, each option `role="option"`:
  - **Bots:** filtered by name on the client, with their previews.
  - **Messages:** from the server, debounced 150 ms, with stale answers dropped. Each shows the bot's avatar and name
    and the snippet.
  - **Actions:** filtered by label. The list: New bot, Keyboard shortcuts, Settings, Models & keys, Usage, Start
    fresh (with the current bot).

**Keys:** ↑ and ↓ move (wrapping), Enter opens, and Escape or a click outside closes. Focus goes back to where it
was.

**Opening:**

- a bot: selects it;
- a message: selects its bot, opens its thread if it's in one, and scrolls to the message, highlighted for 2 s;
- an action: runs it.

**Jump to a message:** `Chat` takes `focus?: { entryId, threadId?, n }`. The transcript scrolls its row into view
(`virtualizer.scrollToIndex`, centered) and gives it `data-highlight`, which fades out. Under reduced motion the
highlight shows without the fade.

### Shortcuts sheet (`shell/ShortcutsDialog.tsx`)

A modal titled "Keyboard shortcuts":

- **Layout:** sections in two columns (one when narrow), each row a label, a hint, and `<kbd>` caps.
- **Closing:** Escape, the close button, or a click outside.
- **Focus:** stays inside while it's open.

## Interfaces

```ts
// server/src/search.ts
searchTranscripts(bots, entries: Map<string, TranscriptEntry[]>, q: string, limit?): SearchResult
interface SearchResult { previews: { botId: string; text: string }[]; messages: SearchHit[] }
interface SearchHit { botId: string; entryId: string; threadId?: string; snippet: string; createdAt: number }
GET /search?q= -> SearchResult ; GatewayClient.search(q) ; IPC "search"

// app
SHORTCUTS, matchShortcut(e, isMac), keyLabels(keys, isMac)   (shell/shortcuts.ts)
```

## Test plan

| Task | Shown by |
| --- | --- |
| Palette searches bots and messages | `search: previews are each bot's latest visible message; messages match any case, skip hidden entries, newest first, with a snippet around the hit`; `http: /search answers previews and hits, and refuses an overlong query`; `palette: bots and actions filter by name` (pure `filterPalette`); manual check |
| Shortcuts sheet and bindings | `shortcuts: each binding matches its keys with the platform's modifier, and nothing else`; `shortcuts: every shortcut on the sheet is bound or handled elsewhere`; manual check (the sheet, Ctrl+K, Ctrl+N, Ctrl+1, Alt+↓, Ctrl+I, Ctrl+Alt+B, Esc to stop) |

**Manual check, 2026-11-28.** By keyboard, in the app on the fake provider, in an isolated profile on port 9411:

- **Ctrl+K:** opened the palette with focus in the field. It listed the Bots (Nova and Pip, each with its latest
  message) and the Actions.
- **Message in another bot:** typing "lighthouses" listed Pip's two messages. Enter opened Pip, scrolled to the
  message and highlighted it.
- **Message in a thread:** from Pip, "zebra" plus Enter opened Nova's thread with that message highlighted.
- **Ctrl+/:** opened the sheet in two columns, and Escape closed it.
- **Other shortcuts:**
  - Ctrl+Alt+B opened the details panel.
  - Ctrl+N opened Create New Bot.
  - Ctrl+I focused the message box.
  - Alt+↓ went from Nova to Pip.
  - Ctrl+1 went back to Nova.
  - Esc in the empty box left a thread, and stopped a running `/slow` reply ("Stopped").

The check found one bug, fixed before review. Opening a thread from another bot fell back to the main chat. The
chat closed a thread whose root it couldn't see yet while the transcript was still arriving. Now only a root that's
there and rolled back closes the thread.

## Risks and open questions

- **Search cost:** search reads every bot's transcript in memory. That's fine at our sizes; an index can come if
  transcripts grow large.

**Code review:** it found ten issues, all fixed. Each has a test or was re-checked in the app.

- **The highlight:** it has its own timer, so re-renders can't keep it on. Re-checked: it clears after 2 s.
- **Old jumps:** a jump is cleared once shown (`onFocused`), so switching bots or threads doesn't replay it.
  Re-checked.
- **Open dialogs and menus:** while any `[role=dialog]`, `[role=alertdialog]` or `[role=menu]` is on screen, the
  shortcuts stand down. This covers a chat's roll-back confirmation and the menus.
- **AltGr on Windows:** on Windows only a real b counts for Ctrl+Alt+B, since AltGr+B types a character on some
  layouts. On macOS the physical key counts. Tested.
- **Alt+↑/↓ while typing:** in a field with text, these stay the field's (Option+↑/↓ moves the caret on macOS).
- **IME:** the palette ignores keys that finish an IME composition.
- **Stale hits:** message hits show only for the query they answer, not one typed since.
- **Hidden bots:**
  - Previous/next from a hidden bot goes to the last or first bot, not off by one.
  - Hidden bots aren't searched, so their hits can't take the results' places. Tested.
- **Onboarding:** shortcuts are off during onboarding.
