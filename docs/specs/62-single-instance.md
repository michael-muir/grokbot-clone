# #62 Single app instance

Issue: #62 · Milestone: Phase 2 · Desktop app core · Requirements: none · Stories: none

## Goal

Launching the app while it is already running brings up the running window instead of opening a second window
and starting a second gateway, the same as the reference app.

## Scope

- In: Electron's single-instance lock, taken before anything else starts (settings, the gateway). A second launch
  exits with code 0 right away; the running app restores its window if minimized, shows it if hidden, and focuses
  it. If no window is open (macOS after closing it), it opens one.
- Out: passing the second launch's arguments to the first (deep links, files): nothing uses them yet.

## Design

`app/src/main/single-instance.ts`, pure and tested in Node:

- `takesLock(argv)`: false for `--smoke`. A smoke run must test a real startup, so it never defers to a running
  app (that would exit 0 without checking anything).
- `bringToFront(win)`: restore → show → focus, on a window-shaped interface so it's tested with a fake.

`index.ts`, first thing: if `takesLock(argv)` and `app.requestSingleInstanceLock()` fails, `process.exit(0)`.
That's synchronous, so nothing below it (the settings file, the gateway spawn) runs. `process.exit` is used, not
`app.quit()`, because `app.quit()` returns and the module would carry on and spawn a gateway. On
`second-instance`, the primary calls `bringToFront` on its window, or creates one.

## Interfaces

- `takesLock(argv: readonly string[]): boolean`
- `bringToFront(win: { isMinimized(): boolean; restore(): void; isVisible(): boolean; show(): void; focus(): void }): void`

## Test plan

| Acceptance criterion (from the issue) | Shown by |
| --- | --- |
| Starting the app while it is running shows the running window; no second window or gateway | Manual check: start the built app, minimize it, start it again. The second process exits 0, the first window comes back focused, and only one gateway process is running. Unit tests: `single instance: …` in `app/test/single-instance.test.ts` |

The issue suggested a smoke test of a second launch. That would need two Electron runs that share a profile with
the developer's own app, so it's a written manual check instead, and smoke keeps testing a full startup.

## Risks and open questions

- A smoke run while the app is open runs a second gateway briefly; it did that before as well.
