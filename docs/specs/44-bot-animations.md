# #44 Bot icon animations

Issue: #44 · Milestone: Phase 3 · Bots, cards and polish · Requirements: UI-1 (fidelity) · Builds on #82, #43

## Goal

The bots feel alive, as in the reference:

- they rest facing up and to the right;
- when you point at one, it turns to face you and watches the pointer;
- they sway while idle and bustle while they work;
- they react when a run ends.

All of it is our own motion on our own faces, built to the behavior and timings captured in #43 and to what the
owner saw in the reference during the build.

## Scope

- In: the rest pose, hover (turning to face you, watching the pointer), idle and working sway, finish and fail
  reactions, reduced motion, a side-by-side recording with the reference.
- Out:
  - Blinking and window-wide eye tracking. The owner saw that the reference's bot icons don't blink, and that their
    eyes follow the pointer only while it's over them. The blink loop and window-wide gaze in the #43 capture belong
    to the reference's controller for the large mark beside the composer (it takes the composer as an input). We
    have no such mark yet.
  - Sleepy and waking faces: we have no "asleep" state yet. It comes with the bot computers (Phase 4/5).
  - The reference's 3D body engine and its authored clips. A 2D tilt, translate and squash is enough at our sizes.

## Design

**Rest pose: facing up and to the right** (`avatar-faces.ts`). The owner asked for this twice during the build: in
the reference, every bot at rest faces up and to the right, and several of ours leaned forward and looked down.

- **Lean:** every body leans back (a counterclockwise tilt, −8° to −18°), so its right side lifts.
- **Eye position:** the eyes sit high and to the right on the body (`eyes` is the resting spot). Each spot came from
  a search for the furthest up-and-right point that fits, pulled back 20 % from the edge.
- **Eye slant:** each eye leans back a further 15° (`EYE.slant`), as eyes on a head turned up and to the right do.
- **Shapes:** the triangle became a broad wedge pointing right, and the drop got rounder, so they have room for eyes
  that face up and to the right.
- **Still avatars:** the eyes are drawn at rest, so the picker's shapes face the same way.

**Hover: turning to face you** (CSS, `styles.css`). On hover of the avatar or the control it sits in (sidebar tile,
header pill, panel button):

- the drawing turns upright;
- the eyes come to the middle of the body (`--face-front-*`) and grow 1.25×;
- they then follow the pointer across the control, up to 1 face unit (`--gaze-*`).

All of it takes 0.28 s `cubic-bezier(.4, .06, .18, 1)`, the captured curve. Leaving puts the bot back at rest.

**Gaze** (`face-motion.ts`, pure): offset = direction × 1 × e(2 − e), e = min(1, distance / reach). The reach is half
the hovered control, so the eyes hit their limit at its edge. There's a 2 px dead zone.

**Sway** (CSS):

- idle: ±2°, scale 1.02, 4 s;
- working: ±3°, a 4 % bob, 1.4 s;
- each bot has its own phase, and every copy of one bot sways in step.

**Reactions** (`face-motion.ts`):

- `celebrate` (1.52 s): a full turn (`rotateY` 360°, sine ease), then a hop with 8 %/10 % squash at take-off and
  landing.
- `droop` (0.9 s): a sag and recovery.
- `reactions(before, now)`: a bot whose run just ended `finished` celebrates, one that `failed` droops. An
  interrupted run, or a lost connection, gets no reaction.

**Director** (`shell/face-director.ts`, DOM, one per window):

- `liven(el, botId, face)` registers a live avatar from a layout effect, before paint, so it never shows upright
  first. It sets the tilt, pivot and front offset as CSS variables.
- It listens for pointer moves only on that avatar's own control: nothing runs for bots the pointer isn't over.
- `noteActivity(before, now)` is called from `App` with each activity snapshot. It sets `data-motion="working"` and
  fires the reactions on every copy of the bot. Nothing here re-renders React.
- Under reduced motion there's no gaze and no reactions, and the CSS drops the sway and the transitions. The
  reduced-motion selectors are as specific as the live ones, so they win.

New tokens: `--duration-face-morph`, `--duration-face-idle`, `--duration-face-working`, `--ease-face`,
`--face-surprised-scale`.

**Gateway:** `BotActivity` gains `lastRun?: "finished" | "interrupted" | "failed"`, how the bot's last run since
start ended.

- It's cleared when a run starts. A run that throws before recording its outcome counts as `failed`, so an old
  "finished" can't make a failed run celebrate.
- The client keeps an item whose `lastRun` it doesn't know and drops just that field.
- A deleted bot's entry goes.

**Live avatars:** sidebar tiles, the header chip, the panel avatar and its computer card, the status rows, and the
Create New Bot preview. The picker's shapes stay still.

## Interfaces

- `BotActivity.lastRun?` (server types, `GET /activity`, the activity client).
- `<Avatar botId? />`: with it, the face is alive.
- `Face.eyes` is now the resting spot (high and right); `EYE.slant`; `eyeRects(face, look?)`.
- `liven`, `noteActivity`, `poke` in `face-director.ts`. `gaze(center, pointer, tilt, reachPx)`, `GAZE`,
  `SURPRISED_SCALE`, `reactions`, `POKES`, `phaseMs` in `face-motion.ts`.

## Test plan

| Task / criterion | Shown by |
| --- | --- |
| Reusable avatar with the hover animation, every shape and color | `<Avatar botId>` everywhere; `faces: a hovered bot turns to face you; its eyes, wide open, stay on it as they watch the pointer` (all shapes, middle plus 8 directions, 1.25×) |
| Applied wherever bot icons appear | Manual check: sidebar, header, panel, status rows, Create New Bot |
| Idle, typing or thinking states | `motion: a run that finishes celebrates…`; `activity says how each bot's last run ended…`; `a run that breaks before it ends counts as failed…`; manual check of the working sway and the celebration |
| Respect `prefers-reduced-motion` | `motion: reduced motion stops the sway and the eye transitions` (the live and working selectors); manual check with emulated reduced motion (below); the director checks the query before gaze and reactions |
| Timing and easing match the captured values | Tokens equal the capture (0.28 s, the curve); `motion: over a bot, the eyes follow the pointer, eased…` |
| Side-by-side recording looks the same | `reference/animations/side-by-side-44.mp4` and `.png` (below) |
| Facing up and to the right at rest (owner) | `faces: at rest every bot faces up and to the right on screen, as in the reference` (every tilt leans back; the eyes sit up and right of the middle on screen) |

Other tests:

- `motion: reactions interpolate…`
- `motion: every bot has its own sway phase…`
- `motion: the CSS and the code agree on the shared numbers` (sway period and surprised scale)
- `subscribeActivity keeps a known lastRun, and an item with an unknown one without it`

**Manual check, 2026-11-27.** Isolated profile on port 9411, launched with
`--disable-features=CalculateNativeWinOcclusion` so a covered test window still counts as visible.

- **Rest:** every shape faces up and to the right, in the sidebar, the header and the picker.
- **Gaze:** a pointer elsewhere in the window leaves the eyes at rest. Over the square's tile, the square turned
  upright and its eyes moved to the middle and followed the pointer. On leaving, they went back to rest.
- **A run:** sending a message switched that bot's copies to `working`, then both celebrated when it finished.
- **Reduced motion** (emulated over CDP): the working sway and the tilt transition were both `none`.

**Recording.** With the owner's OK, the reference window (which the owner had open) and ours were recorded with the
same synthetic pointer path: pointer moves only, no clicks or keys. Both are cropped to the sidebar so no
conversation shows. Comparing them, plus the owner's notes, led to these fixes:

- the backward lean;
- the slanted eyes;
- eyes coming to the middle on hover;
- no blinking;
- gaze only while hovered.

The final recording matches on all of these. Ours is flatter: the reference draws its shapes in 3D, which
foreshortens the far eye.

## Risks and open questions

- The sleepy face and a large composer mark (with blinking and window-wide gaze) wait for the features that need
  them.
