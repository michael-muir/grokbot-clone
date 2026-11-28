# #44 Bot icon animations

Issue: #44 · Milestone: Phase 3 · Bots, cards and polish · Requirements: UI-1 (fidelity) · Builds on #82, #43

## Goal

The bots feel alive, as in the reference:

- they blink;
- they rest looking up and to the right, and watch the pointer;
- they perk up when you point at them;
- they sway while idle and bustle while they work;
- they react when a run ends.

All of it is our own motion on our own faces, built to the behavior and timings captured in #43.

## Scope

- In: blink, resting look, gaze, hover (surprised and upright), idle and working sway, finish and fail reactions,
  reduced motion, a side-by-side recording with the reference.
- Out:
  - Sleepy and waking faces: we have no "asleep" state yet. It comes with the bot computers (Phase 4/5).
  - The typing glance and the composer "perk".
  - The reference's 3D body engine and its authored clips. A 2D tilt, translate and squash is enough at our
    sizes.

## Design

**Numbers** (`shell/face-motion.ts`, pure):

- **Blink:**
  - every 2.8 s + random × 3.7 s, lasting 0.26 s;
  - keyframes on the eye pair: close by 31 % (scaleY 0.1), shut until 58 %, overshoot to 1.06, settle;
  - the eyes close just above their middle (`transform-origin: 50% 40%`).
- **Gaze:** from rest, offset = direction × 1 × e(2 − e), e = min(1, distance / 240 px). There's a 4 px dead
  zone, the eyes hold for 2.5 s after the pointer stops, and the offset is turned back by the face's tilt.
- **Rest pose: facing up and to the right.** The owner asked for this twice during the build: in the reference,
  every bot at rest faces up and to the right, and several of ours leaned forward and looked down. Now, in
  `avatar-faces.ts`:
  - **Lean:** every body leans back (a counterclockwise tilt, −8° to −18°), so its right side lifts.
  - **Eye position:** the eyes sit high and to the right on the body (`eyes` is the resting spot). Each spot came
    from a search for the furthest up-and-right point that still fits at rest and while the eyes look around and
    grow, pulled back 20 % from the edge.
  - **Eye slant:** each eye leans back a further 15° (`EYE.slant`), as eyes on a head turned up and to the right
    do.
  - **Shapes:** the triangle became a broad wedge pointing right, and the drop got rounder, so they have room for
    eyes that face up and to the right.
  - **Still avatars:** the eyes are drawn at rest, so the picker's shapes face the same way.
- **Reactions:**
  - `celebrate` (1.52 s): a full turn (`rotateY` 360°, sine ease), then a hop with 8 %/10 % squash at take-off and
    landing.
  - `droop` (0.9 s): a sag and recovery.
  - `reactions(before, now)`: a bot whose run just ended `finished` celebrates, one that `failed` droops. An
    interrupted run, or a lost connection, gets no reaction.

**Director** (`shell/face-director.ts`, DOM, one per window):

- `liven(el, botId, face)` registers a live avatar. It sets the tilt, pivot and front offset as CSS variables.
- All copies of one bot (sidebar tile, header chip, panel, status row) blink and react together. Different bots
  keep their own rhythm and sway phase.
- One passive `pointermove` listener, batched per animation frame, sets `--gaze-x`/`--gaze-y`. Nothing here
  re-renders React.
- `noteActivity(before, now)` is called from `App` with each activity snapshot. It sets `data-motion="working"` and
  fires the reactions.
- No blinks while the document is hidden. Under reduced motion there are no blinks, gaze or reactions.

**CSS** (`styles.css`):

- The eyes translate by the gaze, with a 0.2 s transition.
- On hover of the avatar or its control, the bot turns to look at you, as in the reference: the drawing turns
  upright, the eyes come to the middle of the body (`--face-front-*`) and each eye scales to 1.25. All of it takes
  0.28 s `cubic-bezier(.4, .06, .18, 1)`.
- Sway: idle is ±2°, scale 1.02, 4 s. Working is ±3°, a 4 % bob, 1.4 s. Each bot has its own phase.
- `prefers-reduced-motion: reduce` removes the sway and the transitions.

New tokens: `--duration-face-morph`, `--duration-face-gaze`, `--duration-face-idle`, `--duration-face-working`,
`--ease-face`, `--face-surprised-scale`.

**Gateway:** `BotActivity` gains `lastRun?: "finished" | "interrupted" | "failed"`, how the bot's last run since
start ended. The client stream accepts only those values. A deleted bot's entry goes.

**Live avatars:** sidebar tiles, the header chip, the panel avatar and its computer card, the status rows, and the
Create New Bot preview. The picker's shapes stay still.

## Interfaces

- `BotActivity.lastRun?` (server types, `GET /activity`, the activity client).
- `<Avatar botId? />`: with it, the face is alive.
- `Face.eyes` is now the resting spot (high and right); `EYE.slant`; `eyeRects(face, look?)`.
- `liven`, `noteActivity`, `poke` in `face-director.ts`. `gaze`, `blinkDelay`, `reactions`, `POKES`, `BLINK_FRAMES`,
  `phaseMs` in `face-motion.ts`.

## Test plan

| Task / criterion | Shown by |
| --- | --- |
| Reusable avatar with the hover animation, every shape and color | `<Avatar botId>` everywhere; `faces: the eyes stay on the body while they look around, also wide open` (all shapes, 8 directions, normal and 1.25×) |
| Applied wherever bot icons appear | Manual check: sidebar, header, panel, status rows, Create New Bot |
| Idle, typing or thinking states | `motion: a run that finishes celebrates…`; `activity says how each bot's last run ended…`; manual check of the working sway and the celebration |
| Respect `prefers-reduced-motion` | `motion: reduced motion stops the sway and the eye transitions`; the director checks the query before blinks, gaze and reactions |
| Timing and easing match the captured values | `motion: blinks come every 2.8 to 6.5 s…`, `motion: a blink closes, holds, opens past fully…`, `motion: the eyes look toward the pointer, eased…`; tokens equal the capture (0.28 s, the curve) |
| Side-by-side recording looks the same | `reference/animations/side-by-side-44.mp4` and `.png` (below) |
| Facing up and to the right at rest (owner) | `faces: at rest every bot faces up and to the right on screen, as in the reference` (every tilt leans back; the eyes sit up and right of the middle on screen) |
| Looking at you on hover | `faces: a hovered bot's eyes fit in the middle of its body, wide open` |

Other tests:

- `motion: reactions interpolate…`
- `motion: every bot has its own sway phase…`
- `motion: the CSS and the code agree on the shared numbers`
- `subscribeActivity keeps a known lastRun and drops an unknown one`

**Manual check, 2026-11-27.** Isolated profile on port 9411, launched with `--disable-features=CalculateNativeWinOcclusion` so a covered test window still counts as visible.

- **Blinks:** over 14 s, every bot blinked every 2.9–6.2 s on its own rhythm. The sidebar tile and the header chip
  of the same bot blinked together.
- **Gaze:** a far pointer moved the eyes to the 1.5 limit, and they returned to rest 2.5 s after it stopped.
- **Hover:** hovering a tile turned the shape upright, brought its eyes to the middle and grew them (scale 1.25).
- **A run:** sending a message switched that bot's copies to `working`, then both celebrated when it finished.

**Recording.** With the owner's OK, the reference window (which the owner had open) and ours were recorded with the
same synthetic pointer path: pointer moves only, no clicks or keys. Both are cropped to the sidebar so no
conversation shows. Comparing them led to three fixes: the backward lean, the slanted eyes, and eyes coming to the middle on hover.
The final recording matches on all of these:
- resting up and to the right;
- blinking;
- eyes following the pointer;
- on hover, turning upright to look at you with bigger eyes.

Ours is flatter: the reference draws its shapes in 3D, which foreshortens the far eye.

## Risks and open questions

- The sleepy face, the typing glance and the composer perk wait for the states that need them (bot computers).
- Many live avatars each read their position on pointer moves. That's batched per frame and fine for dozens of
  bots. If it ever isn't, the sidebar can switch to one shared calculation.
