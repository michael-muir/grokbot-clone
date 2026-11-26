# #12 Sidebar and bot panel

Issue: #12 · Milestone: Phase 2 · Requirements: UI-1 · Stories: —

## Goal

The bot sidebar and the right-hand bot panel from the reference. The sidebar shows every bot and what it's doing
(working, new reply) even when it isn't the open chat. The panel shows the open bot's details and lets the user
rename it.

## Scope

- In:
  - **Sidebar**: main bot, divider, other bots; tile states (selected, hover, working, new reply, main badge); the
    "{name} is working" button at the top; connection status
  - **Bot panel**: opened from the header's name pill; avatar, editable name, a Computer card placeholder, provider
    and model
  - **Gateway activity stream**: which bots are running, pushed on change, through the client, IPC and preload
- Out (and where it goes instead):
  - the `+` new bot button (#14 onboarding / new bot)
  - the apps button (connectors, Phase 4)
  - the account button (#13 settings)
  - the bot right-click menu (Pin, Hide, Delete…): a follow-up issue, since it needs bot management
  - the panel's Library tab, Suggested and Voice sections (future features)
  - the Share button (future)
  - None of these is shown disabled; they appear when they work.

## Measurements

From `reference/dom/07-sidebar.json`, `21-sidebar-toggle.json` and `30-panel-activity.json`:

| Element | Value |
| --- | --- |
| Sidebar | 88px, `--color-sidebar`. Working button 36px at y=10 (`--color-surface`, hairline border, `--color-text-soft`) |
| Tile | 54px, radius 12px, padding 9px. Selected: `--color-fill-strong`. The first tile is at y=56 |
| Corner badge | 12px circle, 9px from the tile's bottom-right. Main bot: `--color-star` with an inset hairline |
| Divider | Between the main bot and the rest: 27px between tiles, a hairline 36px wide |
| Panel | 320px, `--color-app`, left hairline. Close button 36px at the top. Avatar 64px. Name 500 17/24 in an input with a transparent border, radius 8px, padding 2px 10px |
| Panel section | Heading 13/18 `--color-text-secondary`, inset 28px. Card: 16px side margin, `--color-surface`, hairline `--color-line`, radius 12px, padding 4px. Row: radius 8px, padding 6px 8px, title 13/18, subtitle 12/16 tertiary. Thumbnail: 64×40, `--color-fill`, radius 8px |

## Design

### Gateway activity

- `Gateway.activity(): BotActivity[]` and `Gateway.subscribeActivity(listener)`. The gateway notifies when a run
  starts and when it ends.
- `GET /activity`: SSE. A snapshot of all bots on connect, then a snapshot on every change, plus heartbeats.
  The snapshots are tiny, so there are no cursors.
- Client: `subscribeActivity(baseUrl, { onActivity, onState, signal, token })`. It shares the transcript
  subscription's SSE reader, backoff and stale-connection watchdog.
- IPC: the stream open message becomes a topic, either `{ topic: "transcript", botId, since }` or
  `{ topic: "activity" }`. Events add `{ kind: "activity", bots }`.
- Preload: `window.desktop.activity(onEvent)`.

### Sidebar (`app/src/renderer/src/shell/Sidebar.tsx`)

- **Main bot:** the first bot from the gateway (the default bot). It gets the amber badge.
- **Badge priority:**
  - working (a pulsing dot in `--color-accent`)
  - else a new reply (a solid `--color-accent` dot)
  - else main (`--color-star`)
- **New reply:** a run ended while that bot wasn't the open chat. Opening the chat clears it. Kept in memory only.
- **Working button:** appears while any bot runs. Its label is "{name} is working", or "2 bots are working". Clicking
  it opens the first working bot that isn't the open chat.
- **Keyboard:** tiles are buttons in a list. Up and Down move between tiles, and Home and End jump to the ends.
- **Tile label:** each tile has an accessible label with its state ("Nova, working").

### Bot panel (`app/src/renderer/src/shell/BotPanel.tsx`)

- **Opening:** the header name pill becomes a button that toggles the panel (`aria-expanded`). The panel is a
  `complementary` region.
- **Focus:** opening moves focus to the close button. Escape or Close closes it and returns focus to the pill.
- **Name:**
  - an input. Enter or blur saves through `updateBot`, and Escape restores the old name.
  - Empty or whitespace names are refused. Names are trimmed and capped at 40 characters.
  - Errors show in the chat banner.
- **Computer card:** "Bot's computer" and "Local folder", with a thumbnail of the bot's avatar. It's an
  informational row (not a button) until the computer view exists.
- **Model card:** rows for Provider (the provider's label) and Model (or "Default"). Changing them is #13.
- **Layout:** the chat column shrinks when the panel is open. Whether the panel is open is remembered per window
  session.

The scaffold's header meta text (`provider · model · stream`) is removed. The provider and model move to the panel,
and stream problems already show in the banner.

## Interfaces

```ts
// server/src/types.ts
export interface BotActivity { botId: string; running: boolean }

// server/src/client/subscribe.ts
export function subscribeActivity(baseUrl: string, opts: {
  onActivity(bots: BotActivity[]): void; onState?(s: StreamState): void; onError?(e: unknown): void;
  signal: AbortSignal; token?: string; backoff?: …; staleAfterMs?: number; fetch?: typeof fetch;
}): Promise<void>;

// app/src/shared/ipc.ts
type StreamOpen = { id: string } & ({ topic: "transcript"; botId: string; since: number } | { topic: "activity" });
type StreamEvent = … | { kind: "activity"; bots: BotActivity[] };
interface DesktopApi { activity(onEvent: (e: StreamEvent) => void): () => void; … }
```

## Test plan

There are no acceptance criteria in the issue. The tasks are shown by:

| Task | Shown by |
| --- | --- |
| Sidebar layout and states | Test `sidebar: badge per state` (pure `tileState`). Test `sidebar: a run ending on another bot marks it unread; opening clears it` (pure `nextUnread`). **Manual check:** screenshots against `07-sidebar.png` and `21-sidebar-toggle.png`, plus keyboard navigation |
| Bot panel with bot info and a computer card placeholder | **Manual check:** screenshot against `30-panel-activity.png`, open and close by keyboard, rename by Enter and by blur. Test `rename: trims, caps, refuses empty` (pure `cleanName`) |
| Activity stream (needed for the states) | Tests: `GET /activity sends a snapshot, then one per run start and end`, `subscribeActivity reconnects and delivers snapshots`, IPC `checkStreamOpen` accepts both topics and rejects bad ones |

## Risks and open questions

- The reference shows a blue corner dot on the main bot in some captures. Its meaning isn't certain (working,
  unread or connected). We use the accent dot for working and for a new reply.
- The bot avatars in the reference are mascot art. We keep initials until our own avatar art exists (branding is
  an owner decision).
