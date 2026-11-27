# #15 Visual review of core screens against the reference

Issue: #15 · Milestone: Phase 2 · Desktop app core · Requirements: fidelity · Stories: US-22

## Goal

A repeatable check that puts each core screen of this app next to its reference shot, at the same size, so a
visual review is a file you open rather than a memory of how the app looked.

## Scope

- In: a checklist of the core screens, a script that captures the real app at the reference size, and an HTML
  report with a side-by-side pair and an overlay for each screen.
- Out: fixing the differences the report shows (each screen's own issue), screens the app does not have yet
  (account, share, connect-apps, invite, skills, voice, routines, group chat, the bot's computer, the composer
  attachment menu, message hover and reactions), and a pixel-diff gate in CI. The captures depend on a display,
  so the script is run locally, not in the #45 matrix.

## Design

The reference shots in `reference/screens/` are 1040×760. `npm run review` builds the app and opens that
content size with the device scale forced to 1, so a capture is the same size as the shot it is compared with.

The window is the real renderer and the real preload. Main does not start the gateway. It answers IPC with a
fixed set of bots, providers and transcript entries (`app/src/main/review-fixtures.ts`), and the scene list
there is the checklist. Dark theme is forced so a light OS does not change the shots. Animations are turned
off for the capture so a spinner cannot move between frames.

Each scene loads the page, waits until its selector is on screen and the fonts have loaded, runs its steps
(click a button by its label, open the bot menu, or send the Settings menu event), then captures the page.
A scene that does not appear is recorded in the report and the script exits 1.

Output, gitignored, under `review/out/`:

- `captures/<id>.png` for each scene
- `index.html`: the checklist, then each screen as reference beside capture, plus an overlay of the two

Screens with no reference shot (the name step, the choice card, Models & keys) are still captured. The report
says so.

## Interfaces

- `npm run review` at the repo root (builds the app, then captures).
- `app/src/main/review-fixtures.ts` exports `SCENES`. Each scene has `id`, `title`, `reference` (a file name in
  `reference/screens/`, or null), `note`, and the steps that reach it.
- `app/src/main/review.ts` is an Electron entry, built to `app/out/main/review.js`. It is not the app's `main`.

## Test plan

| Acceptance criterion | Shown by |
| --- | --- |
| A script screenshots the app at the reference size | `npm run review`. Each PNG is 1040×760, the size of `reference/screens/*.png` |
| Side-by-side or overlay output per screen | `review/out/index.html` |
| A checklist of in-scope screens | `SCENES` in `review-fixtures.ts`, copied into the report. Test `review scenes: every id is unique and every reference shot exists` |

The in-scope screens:

| Scene | Reference |
| --- | --- |
| Onboarding welcome | `03-onb1.png` |
| Onboarding model | `04-onb2.png` |
| Onboarding name | none (the reference's `08-after-name.png` is the chat after naming) |
| Empty chat | `06-main-welcome.png` |
| Sidebar on that chat | `07-sidebar.png` |
| A conversation | `12-main-full.png` |
| A choice card | none |
| Bot panel | `30-panel-activity.png` |
| Bot menu | `39-sidebar-ctx.png` |
| Settings, General | `23-settings-General.png` |
| Settings, Models & keys | none |

`01-launch.png` is the reference's account sign-in. This app has no account; the welcome screen takes its place
(#14) and is compared with `03-onb1.png`.

## Risks and open questions

- The captures are of the real components with fixture data, not of a live model run. A gateway bug will not
  show up here.
- Button labels are the steps' selectors. A renamed button fails that scene instead of capturing the wrong one.
- The report is for a person to read. It does not decide that a screen passes.
