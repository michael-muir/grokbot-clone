# #9 Design tokens from the captured styles

Issue: #9 · Milestone: Phase 2 · Requirements: UI-5, fidelity · Stories: —

## Goal

One theme file that holds every color, type size, spacing step, radius, shadow and timing the UI uses, measured
from the reference app, so every screen after this one is built from tokens and matches the captures.

## Scope

- In: `app/src/renderer/src/theme/tokens.css` (the single theme file), the bundled Inter font, the scaffold's
  stylesheet rewritten on tokens, and a test that keeps literals out of component styles.
- Out: the real screens (#10 onward), hover and motion polish measured from the app (#43), the Theme setting
  UI (#13 settings; it will set Electron's `nativeTheme.themeSource`).

## Decision: dark first, light derived (a change from the issue text)

The issue says "light theme first, with dark tokens stubbed". The captures say otherwise: the reference app's
Theme setting is "Follow System", and all 40+ captures were taken in dark mode, so every measured value is a
dark value and there is no light capture to measure. So dark is the measured theme and light is derived (same
structure, inverted surfaces, flagged as unverified). A light-mode capture session can replace the derived
values later.

## Measurements

From `reference/dom/*.json` (3,609 nodes): computed colors, fonts, letter-spacing, radii, padding and shadows,
counted by frequency. Each token below is a value the app actually uses, with its count in the source comment
where it helps.

Font: the app uses a proprietary face (XVF). Inter was measured against it: 278 single-line text samples from
the captures re-rendered in Inter at the same size, weight and letter-spacing in Electron's Chromium. The median
width ratio is 0.995 overall and 0.990 at 13px (the most common size), so Inter uses the measured sizes
unchanged, with no size adjustment.

## Design

- **Names follow Tailwind v4's theme namespaces** (`--color-*`, `--text-*`, `--tracking-*`, `--radius-*`,
  `--shadow-*`, `--ease-*`), so adopting Tailwind later is a one-line `@theme` mapping, while plain CSS uses
  the variables directly today.
- **Themes**: `:root` holds the dark values; `@media (prefers-color-scheme: light)` overrides the color tokens.
  Electron's `nativeTheme.themeSource` drives that media query, so the future Theme setting (System, Light,
  Dark) needs no CSS of its own.
- **Bot colors**: the avatar editor's 11 swatches become `--color-bot-*`. A bot's accent is set per element
  with `--bot`, and the user bubble derives from it (`color-mix`, which reproduces the captured `#C8770C` from
  amber).
- **Component sizes** that are measured but not on the spacing scale (bubble and pill padding, header height,
  sidebar width, composer height, chat column width) are tokens too, named after what they size.
- **Reduced motion**: duration tokens drop to 0 under `prefers-reduced-motion`.
- **Font**: `@fontsource-variable/inter` 5.3.0 (OFL-1.1), bundled by Vite so it works offline and within the
  page's CSP. Reason for the dependency: Inter is the agreed stand-in and must ship with the app.

## Interfaces

`tokens.css` custom properties (full list in the file). Groups: surfaces and fills, text, lines, accents and
status, bot palette, type (family, sizes with paired line heights, weights, tracking), spacing, radii, shadows,
motion, component sizes.

## Test plan

| Acceptance criterion (from the issue) | Shown by |
| --- | --- |
| Tokens extracted into a single theme file | `app/test/tokens.test.ts`: the file parses, has every group, and every color token has a light value |
| Inter as the stand-in font, sizes tuned to the screenshots | Width measurement above (0.995 median); manual side-by-side of the scaffold with `reference/screens` |
| Light theme first, dark stubbed | Inverted on purpose (see Decision): dark measured, light derived; test checks light covers every color token |
| Colors, spacing and type come from tokens (CLAUDE.md UI rule) | `app/test/tokens.test.ts`: no color, font-size, line-height or radius literals in any renderer stylesheet or inline style outside `tokens.css` |

## Risks and open questions

- The light theme is unverified until a light-mode capture exists.
- Motion durations aren't in the captures; the values are placeholders until #43 measures hover animations.
