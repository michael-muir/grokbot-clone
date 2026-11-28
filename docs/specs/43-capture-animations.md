# #43 Capture hover and idle animations for bot icons

Issue: #43 · Milestone: Phase 3 · Bots, cards and polish · Requirements: UI-1 (fidelity) · Blocks #44

## Goal

Know exactly how the reference's bot icons move (idle, hover, typing, run states) before building ours in #44.

## Scope

- In: a written capture in `reference/animations/README.md`: how the icons are built, durations, easings,
  triggers, states and reduced-motion behavior.
- Out: any product code (that's #44). Copying the reference's drawings or clip keyframes (ground rules).

## Design

A written capture, no code: `reference/animations/README.md`, in sections for what an icon is, idle, hover and
pointer (with a table per place: sidebar, panel, header chip, messages, computer card), expressions, run states
and pokes, ending with what it means for #44. It records behavior and timing. The reference's authored clips are
described by pace and character, not copied keyframe by keyframe (ground rules).

## Interfaces

None.

## Method

The reference app was already running with its remote-debugging port. Everything was read-only:

- the DOM and computed styles of the sidebar avatar;
- every `@keyframes` name and the hover rules for the tiles;
- the renderer scripts through `Debugger.getScriptSource`: the mark engine in `index.eager-common-*.js` and the
  pointer and blink controller in `index.eager-app-*.js`.

Nothing was clicked, typed or sent to the app.

**Deviation from the issue: no video or frame sequence.** The window was hidden in the tray, so its animation
frames were paused, and a 25 s sample showed no change. Showing it would take over the owner's desktop. The
source gives exact numbers, which a video can't, so the write-up records those. A side-by-side recording fits
better in #44's review, where it's an acceptance criterion anyway. #44 now lists it as a task, so it isn't lost,
and the owner can ask for it sooner.

## Test plan

| Task (from the issue) | Shown by |
| --- | --- |
| Launch with the remote-debugging port | Method above (the app was already listening; port checked to be the reference's own page) |
| Hover each bot icon and record | §3 of the write-up (hover, pointer and typing triggers with values); video deferred to #44 (above) |
| Read CSS transition / animation / keyframes | §1 (no CSS keyframes on the mark), §2 (sleeping breath keyframes), §3 table per place (sidebar, panel, header chip, messages, computer card) |
| Animated SVG, Lottie or canvas? Shapes and colors | §1: SVG path data redrawn each frame by a procedural engine; 26 shapes; color per bot, gray when asleep |
| Idle, typing or thinking animations | §2 (blink, idle clips), §3 (typing glance), §5 (thinking and run states), §6 (pokes) |
| Save in `reference/animations/` with durations, easing, transforms | `reference/animations/README.md` |

No code changes, so `npm run verify` only confirms nothing else moved.

## Risks and open questions

- The reference recording is deferred to #44 (a task there). If the owner wants it now, the reference window has
  to be shown on their desktop while it records.
- The reference's bundles change with updates; the README says how to repeat the capture.
