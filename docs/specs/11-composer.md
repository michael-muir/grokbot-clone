# #11 Composer with send and stop

Issue: #11 · Milestone: Phase 2 · Requirements: UI-1, AG-2 · Stories: US-8

## Goal

The message composer from the reference: type, send with Enter, and stop a running reply with one click. Stop ends
the run as interrupted within 2 seconds.

## Scope

- In:
  - the composer frame and growing text field
  - the primary round button: Send when idle, Stop while a run is going
  - keyboard behavior
  - drafts kept per bot while the app is open
  - a Stop timing test against the gateway
- Out (and where it goes instead):
  - the `+` attachment menu (`reference/screens/09-composer-menu.png`) goes to the attachments issue, Phase 3
  - the mic and voice buttons go to the voice feature (`docs/future-features.md`)
  - Both are hidden, not shown disabled: a control that does nothing is worse than a missing one.

## Measurements

From `reference/dom/08-after-name.json` and `36-msg-hover.json`:

| Element | Value |
| --- | --- |
| Frame | Full chat width (920 at 1040), height 44px, `--color-surface`, 1px `--color-line-strong`, radius 22px, `--shadow-raised` |
| Primary button | 28px circle at the right, 7px in from the frame edge. White bot: `#f5f5f5` with a `#121212` icon. Amber bot: `#c8770c` (the user-bubble color) with a white icon |
| Icon buttons (later) | 28px, `--color-fill`, inset hairline, `--color-text-tertiary` |
| Text | 15/22 like the chat. Placeholder "Message {bot}" in `--color-text-tertiary` |

New tokens, per bot color scope:
- `--color-bot-action`: the user-bubble color. The white bot uses `--color-text`.
- `--color-on-bot-action`: `--color-on-user-bubble`. The white bot uses `--color-app`.

## Design

`app/src/renderer/src/chat/Composer.tsx`, props `{ botId, botName, busy, onSend(text): Promise<void>, onStop(): Promise<void> }`.

- **Text field:** a `<textarea>` with `field-sizing: content`. It grows to 8 lines, then scrolls.
- **Keys:** Enter sends, and Shift+Enter starts a new line. An Enter that finishes an IME composition doesn't
  send.
- **Primary button:**
  - **Idle:** Send, an arrow icon. It's disabled (faint fill) while the text is empty or a send is in flight.
  - **Busy:** Stop, a square icon in the bot's color. Clicking it calls `interrupt`, and the button shows as
    disabled until the run ends.
  - The label is in `aria-label` ("Send message" / "Stop the reply"), with a visible focus ring.
- **While busy:** you can keep typing, but Enter doesn't send. The gateway refuses a second message while a run is
  going, so the draft waits for the run to end.
- **Drafts:** kept per bot in memory, so switching bots and back keeps unsent text. They're not kept across a
  restart.
- **Focus:** the text field takes focus when a chat opens and stays focused after sending.
- **Errors:** a failed send keeps the draft and shows the error in the chat's banner (as today).

`App.tsx` keeps computing `busy` from the last `run` entry and passes `onSend` / `onStop`.

## Interfaces

```ts
// app/src/renderer/src/chat/Composer.tsx
export function Composer(props: {
  botId: string;
  botName: string;
  busy: boolean;
  onSend(text: string): Promise<void>; // rejects on failure; the draft is kept
  onStop(): Promise<void>;
}): JSX.Element;
```

No gateway or IPC changes: `sendMessage` and `interrupt` exist.

## Test plan

| Acceptance criterion (from the issue) | Shown by |
| --- | --- |
| Stop ends the run as interrupted within 2 s | Test `HTTP: Stop ends a streaming run as interrupted within 2 s`: the gateway with the fake provider's slow reply, POST `/interrupt` over HTTP, then the time until the run entry reads `interrupted`. Claude tests: `Stop returns at once even while the SDK keeps streaming…` and `a run on a session waits until the stopped run's process has shut down`. **Manual check:** click Stop during a slow reply in the app, and time Stop on a real Claude run |
| Send, disabled while busy | Pure helper `primaryButton({ draft, busy, sending, stopping })`, test `composer: Send needs text and no send in flight; while busy the button is Stop`. **Manual check** in the app |

Other tests: Enter, Shift+Enter and composition handling go through a pure `shouldSend(key, shift, composing)`
helper. The token test still passes.

## Risks and open questions

- The reference shows the voice button as the primary button when the field is empty. We show Send (disabled)
  until voice exists.
