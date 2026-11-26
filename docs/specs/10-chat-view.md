# #10 Chat view: transcript store and entry rendering

Issue: #10 · Milestone: Phase 2 · Requirements: UI-1, TR-3, CD-1 · Stories: US-7, US-14

## Goal

Render a bot's transcript as the reference does: grouped message bubbles with Markdown, live streaming text,
status rows that update in place, notices and errors, and approval cards. Long chats (1,000+ entries) still
scroll smoothly.

## Scope

- In:
  - a seq-ordered transcript store with in-place updates
  - pure row layout (grouping, spacing, time separators)
  - a component per entry kind
  - the approval card with Allow, and Deny with an optional reason
  - Markdown in bot messages
  - a virtualized, bottom-anchored list
- Out (and where it goes instead):
  - the composer's look and Stop button (#11)
  - sidebar and bot panel (#12)
  - message hover actions (reactions, reply, more) and the multiple-choice `widget` card. These need new
    gateway entry kinds; they're found in the #7 capture and will be filed as new issues
  - avatar animations (#43)
  - a visual-review script (#15)

## Measurements

From `reference/dom/08-after-name.json` and `36-msg-hover.json`:

| Element | Value |
| --- | --- |
| Bot bubble | max 560px, padding 7px 12px, radius 18px, fill `--color-fill` + bevel shadow, text 15/22, 0.15px tracking |
| Grouped bubbles | Joined corners on the side where they meet are 6px. First: `18 18 18 6`. Middle: `6 18 18 6`. Last: `6 18 18 18` |
| Row spacing | 2px below every row. 2px above within a group, 10px above a new group on the same side, 14px when the side changes |
| User bubble | Right-aligned, same metrics, `--color-user-bubble` (bot color darkened) |
| Paragraphs, lists | 10px between paragraphs, list indent 20px, 4px between items. `strong` 600 |
| Inline code | Mono 0.93em, `--color-text-secondary` on `--color-fill-faint`, radius 4px, padding 0 4px |
| Time separator | Centered, 12/16, `--color-text-secondary`, padding 6px 0. "Today 3:19 PM" |
| Row time | 500 12px/12px, `--color-text-tertiary`, padding-left 10px, at the row's far edge. Shown on hover or focus |
| Status row | Avatar slot, then 14/22 tertiary text with a shimmer while running |
| Card | Radius 24px, `--color-surface`, ring shadow. Prompt 600 15/22 tertiary. Choice rows: 24px key cap (radius 8px, `--color-accent`) + 14/20 text |

## Design

**Store** (`server/src/client/transcript-view.ts`, shared by the app):
- `TranscriptView` keeps entries in an array sorted by `seq`, plus an index by id.
- An update replaces the entry at its position. An append to the end is O(1), and an out-of-order insert uses a
  binary search.
- `entries()` returns the same array until something changes, so React can compare by reference.
- A `version` counter and a `subscribe(listener)` method let the renderer use `useSyncExternalStore`.

**Rows** (`app/src/renderer/src/chat/rows.ts`, pure): `buildRows(entries, now)` → `Row[]`. Each row has:
- `key` and `side` (`bot` / `user` / `center`)
- `group` position (`single` / `first` / `middle` / `last`), which sets the corner radii
- `gap` (`tight` / `group` / `switch`), which sets the spacing above it
- an optional `time` label
- and either the entry, or a time separator

Rules:
- Consecutive bot bubbles and status rows form one group. Cards, notices, errors and user messages break groups.
- A time separator goes before the first entry, and before any entry 60 minutes or more after the previous one.
  Labels are "Today 3:19 PM", "Yesterday …", or "Mon, Nov 23 3:28 PM".
- `run` entries are hidden, except interrupted runs, which show a "Stopped" notice. A failed run already has its own
  error entry, so it doesn't add a second line.
- An empty streaming reply isn't shown; the Thinking row stands in for it.
- A trailing "Thinking" row appears while the last run is running and nothing in it is streaming or running yet.

**Components** (`app/src/renderer/src/chat/`):
- `Transcript.tsx`: the virtualized list.
- `Bubble.tsx`: bot bubbles render Markdown, user bubbles render plain text that keeps its line breaks. A
  streaming bubble shows a caret.
- `Markdown.tsx`: `react-markdown` + `remark-gfm`. Raw HTML is skipped (the default). Links get
  `target="_blank"`; main already opens http(s) links in the browser and denies everything else.
- `StatusRow.tsx`: avatar slot and label. Running: shimmer, which reduced motion turns into static text. Done:
  plain tertiary text. Failed: danger text.
- `ApprovalCard.tsx`: card layout from the reference.
  - Prompt: "Allow {tool}?". The summary sits in a code line.
  - Choices: `A` Allow, `B` Deny.
  - Deny opens an inline reason field (optional) with Send and Cancel. Escape cancels.
  - Once answered, the card shows "Allowed", "Denied: reason" or "Expired" instead of the choices.
  - Every control is a real button with a visible focus ring.
- `NoticeRow` and `ErrorRow`: centered tertiary text, and danger text.

**Virtualization**: `@tanstack/react-virtual`.
- Rows are measured after render (`measureElement`), and 8 rows are rendered beyond the visible area.
- The list sticks to the bottom while the user is within 40px of it. When rows are added or grow, it scrolls to
  the end. Scrolling up stops the following.
- The scroll container is focusable (tab stop, arrow keys, Page Up/Down) and has `role="log"`, so new rows are
  announced.

## Interfaces

```ts
// server/src/client/transcript-view.ts
class TranscriptView {
  readonly cursor: number;               // highest updatedSeq (unchanged meaning)
  readonly version: number;              // bumps on every applied change
  apply(entry: TranscriptEntry): boolean;
  get(id: string): TranscriptEntry | undefined;
  entries(): readonly TranscriptEntry[]; // stable reference until the next change
  subscribe(listener: () => void): () => void;
}

// app/src/renderer/src/chat/rows.ts
type Side = "bot" | "user" | "center";
type GroupPos = "single" | "first" | "middle" | "last";
type Gap = "none" | "tight" | "group" | "switch";
type Row =
  | { type: "separator"; key: string; label: string; gap: Gap }
  | { type: "entry"; key: string; entry: TranscriptEntry; side: Side; group: GroupPos; gap: Gap; time: string }
  | { type: "thinking"; key: string; gap: Gap };
function buildRows(entries: readonly TranscriptEntry[], now: Date): Row[];
function separatorLabel(at: Date, now: Date): string;
```

New tokens:
- `--font-mono` and `--font-size-code: 0.93em`
- `--color-on-accent` (both themes)
- `--gradient-shimmer` and `--duration-shimmer`
- `--padding-code`, `--size-row-time` and `--size-status-slot`

Inline `style` carries only computed list positions, as custom properties (`--list-height`, `--list-offset`).

**Gateway change:** a denial with an empty reason is stored without a reason, so the card reads "Denied". The
model is told "The user denied this action." (`DENIED_WITHOUT_REASON`).

New dependencies (pinned):
- `react-markdown@10.1.0` and `remark-gfm@4.0.1`. Bot replies are Markdown. Writing our own parser would be
  more code and riskier, and this pair renders React elements without raw HTML.
- `@tanstack/react-virtual@3.14.26`. Virtualizing rows of varying height with scroll anchoring is easy to get
  wrong by hand.

## Test plan

| Acceptance criterion (from the issue) | Shown by |
| --- | --- |
| 1,000+ entries scroll smoothly | Manual check, recorded in the PR: a 2,000-entry transcript in the app. Measured frame times while scrolling the whole list by script, and the DOM holds under 60 rows at any time. Test `transcript view: 10,000 appends and updates stay fast` |
| Streaming text and status rows update in place | Tests `transcript view: an update replaces the entry at its position` and `rows: a streaming entry keeps its key and position`. Manual check with the fake provider's streamed reply and a tool run |

Other tests:
- `TranscriptView`: out-of-order and stale updates; `entries()` keeps its reference until a change.
- `buildRows`:
  - the four group positions
  - gaps for same-side, new-group and side-switch rows
  - separators at the first entry and after a 60-minute gap; labels for today, yesterday and older
  - hidden run rows; interrupted and failed notices
  - the Thinking row appears and goes away
- Token test: still no literals.

## Risks and open questions

- The status-row avatar in the reference is an animated face (43px SVG). We use the bot's initial avatar until
  #43 captures the animation.
- Grok Bot hides finished tool calls. We keep a compact "done" row, because our agents act on the user's own
  computer and the user should see what ran. This is a deliberate, small deviation.
- The approval card copies the reference's choice-card layout. No real permission card was captured, so the
  exact look of the Allow and Deny choices is ours.
