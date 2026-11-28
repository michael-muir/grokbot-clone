# #24 Light and dark themes

Issue: #24 · Milestone: Phase 3 · Bots, cards and polish · Requirements: UI-5 · Stories: US-24 · Builds on #9, #13

## Goal

The app follows the system's light or dark mode, with an override in Settings → General (Follow System / Light /
Dark). Both themes are complete and readable on every screen, and switching never flashes the other theme.

## What exists already

Two earlier issues built the mechanics:

- **#9:** the light tokens, under `prefers-color-scheme: light` in `tokens.css`.
- **#13:** the Theme setting in General, which sets Electron's `nativeTheme.themeSource`. Every window's
  `prefers-color-scheme` follows it at once, including "Follow System".

This issue makes sure both themes hold up, now that many screens have been added since.

## Scope

- **In:**
  - Window backgrounds that follow the theme.
  - A contrast test for both themes.
  - Light captures in the review harness.
  - A light check of every screen and component added since #13: hover bar, reactions, menus, cards (widget, form,
    secret), threads, the cut-off notice, the Usage page, the palette and the shortcuts sheet.
  - Fixes for anything those turn up (one: popups kept inside the window at the top).
- **Out:**
  - **Changing the user bubble colors for contrast.** That's the owner's call; see Risks.

## Design

**Window background** (`app/src/main/window-theme.ts`):

- The color a window shows before its page paints, and while it resizes, equals `--color-app` of the theme in use
  (`#121212` or `#fafafa`). The main window gets it when it opens.
- When the setting changes or the system theme changes (`nativeTheme` "updated"), every window gets the new one.
  Before, the main window had Electron's default (white): a dark app flashed white as it opened.

**Contrast test** (`tokens.test.ts`): for both themes, the tokens are resolved (including `var()` references and
alpha over the app background) and the WCAG ratio is checked:

- **4.5:1 for text:** text, soft text, secondary text, links and danger text, on the app, surface, sidebar and
  hovered-surface colors. Also text on accent and on contrast.
- **3:1 for non-text and tertiary text:** icons, tertiary text (time stamps, notices) and the focus ring.
- **The user bubble:** its text against `color-mix(bot 81%, black)` must stay at or above today's minimum (3.4,
  amber), so no change makes it worse.

**Review harness:** `REVIEW_THEME=light npm run review` captures the core screens in light, into
`review/out/light/`. Dark stays the default, since it's the reference's theme.

## Test plan

| Requirement | Shown by |
| --- | --- |
| Theme follows the system | `nativeTheme.themeSource = "system"` (#13, existing); manual check: Follow System matches Windows' mode |
| Override in Settings → General | `settings: theme …` (#13, existing); manual check: switching Light / Dark / Follow System applies at once, with no flash |
| Both themes readable | `theme: text, icons and the focus ring meet WCAG contrast in both themes`; `theme: the user bubble's text never gets less readable`; light captures of the core screens; manual light check of the newer components |
| No flash | `theme: the window background is the theme's app color`; manual check |

**Manual check, 2026-11-28.** In the app, with the theme set to Light, in an isolated profile on port 9411. Each of
these looked right in light:

- **The widget card:** answered, chosen row highlighted, the others dimmed.
- **The form card:** fields, checkbox, and the disabled submit.
- **The hover bar and the More menu.**
- **A reaction chip.**
- **The white bot:** its avatar keeps its edge, and its user bubble shows dark text on light gray.
- **The search palette, the shortcuts sheet and the Usage page.**

**Live switching** (`settings.set`): each change applied at once.

| Setting | Result |
| --- | --- |
| Dark | `#121212` background |
| Light | `#fafafa` background |
| Follow System | dark, matching Windows' "apps use dark mode" (`AppsUseLightTheme = 0`) |

The light review captures of the core screens (`REVIEW_THEME=light npm run review`) read well: welcome, chat,
thread, panel, choice card, bot menu, Settings.

One unrelated fix came from this check. A popup opened from a message scrolled partly above the view hung off the
top of the window. Popups now stay inside it at the top too, as they already did at the right and bottom.

## Risks and open questions

- **User bubble contrast (owner's decision).** White text on the user bubble is below 4.5:1 for four bot colors:

  | Bot color | Contrast |
  | --- | --- |
  | Amber (the default) | 3.4 |
  | Green | 3.5 |
  | Teal | 3.7 |
  | Orange | 4.4 |

  It's the same in both themes. Amber's bubble color was measured from the reference (#c8770c), so raising contrast
  (darker bubbles or dark text on light ones) would change the look. This is left as the reference has it, and the
  test stops it from getting worse. Raising it is the owner's call.
