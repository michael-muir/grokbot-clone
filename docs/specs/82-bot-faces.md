# #82 Bot faces: eyes on every avatar, and chunkier shapes

Issue: #82 · Milestone: Phase 3 · Bots, cards and polish · Requirements: UI-1 (fidelity)

## Goal

Bots look like characters, not icons. The owner's Gate B pass found that our avatars, which are flat shapes with
the bot's initial on them, lose the feel of the reference, where every bot is a soft shape with a pair of eyes.

## Scope

- In: a face (two eyes) on all twelve shapes from #16 in place of the initial; softer, chunkier shape drawings that
  lean slightly; every place an avatar appears (sidebar, header pill, bot panel and its computer card, status
  rows, the picker, Create New Bot).
- Out: animation (blinking, glancing, hover). That is #43 (capture) and #44 (build), which animate these eyes.
  Generated and uploaded avatars stay out, as in #16.

## Design

**Our own drawings** (ground rules: the reference's mascot art is reference only). Each face is data in
`shell/avatar-faces.ts`: its body parts (polygons, circles, rounded rectangles on a 32-unit square), a lean
(degrees, around a pivot) and the point between its eyes. Keeping it as data lets the tests check that every face
fits.

- **Body.** Filled and stroked in the bot's color with a 5-unit round-joined stroke, which softens every corner,
  so the shapes read as chunky rather than geometric. Regular shapes are computed (`corners()`); the star is
  plump (inner radius 8.5 of 12.5) so the eyes fit. Each shape leans a little (−12° to 24°; the triangle leans
  furthest, like it's on its way).
- **Eyes.** Two upright pills (3.4 × 7 units, 3 apart), placed a little right of each shape's middle, as if the
  bot glances that way. They're drawn after the body inside the same tilted group, so they lean with it. Each eye
  is its own `<rect class="avatar-eye">` with `transform-box: fill-box; transform-origin: center`, so #44 can
  blink it by scaling.
- **Color.** `--color-on-bot` (#121212) on every bot color in both themes, as in the reference. The lowest
  contrast is on gray and brown, both above 4:1, which clears WCAG's 3:1 for graphics. The avatar's background is
  the bot color itself, so the theme doesn't change this.
- **Accessibility.** The avatar is decorative (`aria-hidden`). Everywhere it appears, the name is beside it (header
  pill, panel, status rows) or on the control around it (sidebar tiles: `aria-label`; picker: radio labels). The
  initial carried no extra meaning, so nothing is lost.

`Avatar` loses its `name` and `showInitial` props, and `AvatarPicker` its `name` prop. `initial()`, `--text-3xl` and
`--tracking-tight`, which only the initial used, are removed.

## Interfaces

- `shell/avatar-faces.ts`: `FACES: Record<AvatarShape, Face>`, `eyeRects(face)`, `VIEW`, `STROKE`, `EYE`.
- `<Avatar avatar size? />`, `<AvatarPicker shape color onChange />`.

## Test plan

| Task / criterion | Shown by |
| --- | --- |
| Eyes on every one of the twelve shapes | `faces: every shape has a face` (and `Record<AvatarShape, Face>` in the typecheck) |
| Placed per shape so they sit naturally | `faces: both eyes sit wholly on the body, side by side` (point-in-shape check on each eye's corners and edges; a too-tall eye fails it) |
| Shapes fit at every size | `faces: each body, tilted and stroked, stays inside the square` |
| Eyes contrast with every color in both themes | `faces: the eyes stand out against every bot color (3:1, WCAG non-text contrast)` |
| Faces everywhere the avatar appears; readable from 24 px up | Manual check (below); `npm run review` |
| Reads as the same kind of character without copying | Manual check side by side with `reference/screens/41-newbot-filled.png` and `35-edit-avatar.png` |

Manual check (2026-11-27, isolated profile on port 9411, fake provider, one bot per shape): the sidebar tiles, the
header pill (24 px), the panel's large avatar and computer card, the Create New Bot preview and all twelve
picker shapes show faces, in dark and light themes. The white bot keeps its edge in light. The first eyes
(3 × 6.2) looked small next to the reference, so they grew to 3.4 × 7 and spread out.

## Risks and open questions

- The final mascot art may still change under #32 (own product art). The data format makes that a drawing change,
  not a code change.
