# Bot icon animations in the reference app

Captured 2026-11-27 for #43 from the running Grok Bot app (as installed in `C:\Program Files\Grok Bot`), over
the remote-debugging port, read-only: DOM, computed styles and the renderer's own scripts
(`index.eager-common-*.js`, `index.eager-app-*.js`, read with `Debugger.getScriptSource`). Nothing was clicked,
typed or sent.

**Why no video.** The app sat hidden in the tray (`document.visibilityState` was `hidden`), so the browser had
paused its animation frames and a 25-second sample of the marks saw no change. Showing the window would have meant
taking over the owner's desktop. The scripts give the exact timings and easings instead, which is what #44 needs.
The side-by-side recording is a task in #44.

**To repeat this capture** (after an app update, say):

1. Start the reference with `--remote-debugging-port=<port>`. The method is in the project's design notes, and
   the app minimizes to the tray, so quit it fully first.
2. Check that `http://127.0.0.1:<port>/json` lists a page titled "Grok Bot".
3. Read, never act:
   - `Runtime.evaluate` for the DOM and `getComputedStyle`;
   - `document.styleSheets` for keyframes and hover rules;
   - `Debugger.enable` + `Debugger.getScriptSource` for the renderer bundles.
4. Search the bundles for `grok-state`, `surprised`, `` `bounce` `` and `r_t+s()*3700`. The minified names change
   between builds; the string constants don't.

Don't send messages or tasks while capturing.

Reference only (ground rules): this records *behavior and timing*. The reference's drawings and its authored clip
keyframes are not copied into the product. #44 builds our own motion on our own faces (#82) to these behaviors.

## 1. What a bot icon is

- One `<span class="sand-grok-bot-mark" data-grok-state="idle|sleeping">` per place it's shown (sidebar tile,
  header chip, panel, messages), drawing `<svg><use href="#sand-agent-mark-source-<id>">`. Each bot has one
  shared source SVG that every copy points at, so they all animate together.
- The source is **redrawn as path data every frame by a procedural engine**: a 3D-ish body (quaternion
  rotation: yaw, pitch, roll; squash and stretch; lift) with two eye capsules cut out of it as holes
  (`fill-rule="evenodd"`, or separate `-body` and `-holes` paths). It's not an animated SVG, Lottie file or canvas,
  and there are no CSS keyframes on the mark.
- 26 body shapes in the engine (`sphere cloud square sparkle clover heartChubby starFlower teardrop tablet wedge
  house star6 pebble bean egg squircle capsule cylinder hex gem crystal shield dome arch leaf pumpkin`); the
  avatar editor offers a subset. Color is the bot's color; a sleeping bot is drawn gray.
- `prefers-reduced-motion: reduce` stops all of it: no blinks, no gaze, no expression changes. The marks also
  pause while any other animation runs on their motion root, and blinks skip while the document is hidden.

## 2. Idle: blinking

| What | Value |
| --- | --- |
| Interval | 2800 ms + random × 3700 ms (2.8–6.5 s), rescheduled after each blink |
| Length | 0.26 s |
| Shape | lids close over the first 31 % (smoothstep), stay shut 27 %, then open over the last 42 % with a 6 % overshoot (to 1.06, settling back) |
| Where the lid closes | 40 % of the way down the eye (just above the middle), so the eye squashes into a line there |

Idle also has slow body motion: loops of 4–6 s that blink and drift. The common one is a small sway, a few
degrees, with a slight scale "breath"; now and then a bigger look around; small sizes use only the small sway.
(The reference's clips are authored keyframes: we take their pace, not their motion.)

A sleeping bot shown small (24 px, in the bot's computer card) breathes:
`@keyframes { 0%, 100% { opacity: .85; scale: 1 } 50% { opacity: 1; scale: 1.04 } }`, 2.4 s, `ease-in-out`,
infinite.

## 3. Hover and pointer

| Trigger | Response |
| --- | --- |
| Pointer over the bot's icon | expression → `surprised` (eyes grow from 0.26 × 0.57 to 0.42 × 0.86 of the eye unit); back to `neutral` on leave |
| Pointer enters the composer | a "perk": `surprised` for 600 ms, at most once per 1.5 s |
| Pointer moves anywhere in the window | eyes look toward it: offset = direction × 0.75 × e(2 − e), e = min(1, distance / 240 px); dead zone 4 px; holds 2.5 s after the last move, then returns |
| Typing in the composer | eyes glance at the text field (30 % across it, at least 0.5 sideways, slightly down) for 1.2 s after the last keystroke |
| Bigger marks (panel) | a stronger variant: offset up to 1.5 with a body tilt up to 6° toward the pointer, over 320 px, dead zone 6 px |

Expression changes ("morphs") take **0.28 s** with `cubic-bezier(.4, .06, .18, 1)`; changes that pass through a
blink take 0.35 s.

Per place, the CSS around the icon (computed styles and hover rules):

| Place | Size | CSS motion |
| --- | --- | --- |
| Sidebar tile | 36 px | the button: `transition: transform .2s cubic-bezier(.22, 1, .36, 1)` (also width, padding); the mark itself has none |
| Bot panel | 64 px | hover or focus on the avatar button: `filter: brightness(.3)` over `.14s`, with a pencil on top (edit) |
| Header chip | 24 px | a static image of the mark, not a live one; the chip slides in and out with width, margin and opacity over `.3s` on a spring-like `linear()` curve (fast start, settles by about 50 %) |
| Messages | none | assistant rows carry no avatar; the live mark shows only in the typing and working row (`data-grok-state` on the row) |
| Bot's computer card | 24 px | the breathing loop in section 2, while the bot sleeps |

## 4. Expressions (eyes)

`neutral, happy, surprised, sad, sleepy, squinted, calm, inspecting, confused`. Aliases: `idle → neutral`,
`thinking → sad` (eyes lowered), `sleep → sleepy`, `smile → happy`, `squint → squinted`, `inspect → inspecting`.

- `neutral`: two upright capsules.
- `surprised`: taller, wider capsules.
- `happy`: upturned arcs.
- `sleepy`: flat lids (a short line).
- `sad`: capsules leaning 28°, lowered.
- `squinted`: capsules turned flat (90°).
- `inspecting`: one eye larger than the other.

## 5. States and run activity

Each state picks clips (body motion), an optional face and an optional overlay ("morph" effect):

| State | Motion | Face / overlay |
| --- | --- | --- |
| idle | idle loops (above) | neutral |
| listening | a slow look around | calm |
| thinking | small sway | `dots` overlay |
| streaming | a lively sway and bob, 2.4–2.6 s loops | |
| reading, working, coding, running, computing, controlling | busy loops of 4–8 s: turns, glances, a surprised beat | |
| searching | small sway | `radar` overlay |
| waiting | small sway | `orbit` overlay |
| blocked | a puzzled wobble (about 2 s), then `drowsy` after 120 s | confused |
| finished | a squash-and-stretch hop | happy, then idle |
| failed | a slump (about 3 s), then idle | |
| sleeping | small sway | sleepy, gray |
| waking | 1.6 s | surprised, then idle |

## 6. Pokes (one-off reactions)

| Poke | Length | Motion |
| --- | --- | --- |
| spin | 0.9 s + 0.4 s per extra turn | yaw 180° × turns × (1 − cos πt): a smooth full turn |
| bounce | 0.62 s | hop of 0.3 (sin), squash 8 %/stretch 10 % at take-off and landing, the reverse in the air |
| nod | 0.5 s | pitch 16° down and back (sin²) |

Used for: a finished task or a "happy" moment (`spin` with 2 turns, then `bounce`), and when the user mentions
or picks the bot.

## 7. What this means for #44 (our build)

- Build on our faces from #82: each eye is its own SVG element, so CSS or Web Animations can scale and move it.
- Must have: blink at the same rhythm and shape; `surprised` on hover (bigger eyes, 0.28 s, same easing);
  eyes follow the pointer within the same limits; sleepy face for a sleeping bot; a small idle sway; a spin and
  bounce for "finished"; everything off under reduced motion and while hidden.
- Ours, not theirs: our timings may match theirs (they're behavior), but motion is our own and drawn on our own
  shapes. No 3D engine: a 2D tilt, translate and squash on the whole avatar is enough at our sizes.
