# #97 Gate C fixes: model names, SmartyPrompt, light-mode bot, menu bar, name hover

Issue: #97 · Milestone: Phase 3 · Bots, cards and polish · Found in the owner's Gate C check (#40)

## Goal

Five things the owner saw in the app, each small.

## Design

### Model names (`server/src/model-label.ts`, shared with the app)

Cursor's model ids carry their settings in brackets, such as `claude-sonnet-4-5[thinking=true,context=200k]`. The
id stays what's saved and sent. Only what's shown changes, through `modelLabel(id)`:

- **The name, then the settings in parentheses:** `claude-sonnet-4-5 (thinking, context 200k)`.
- **Each setting:**
  - `key=true` shows as the key;
  - `key=false` is left out;
  - anything else shows as `key value`;
  - underscores become spaces (`reasoning_effort=high` → `reasoning effort high`).
- **No settings:** `name[]` shows as the name.
- **Any other id** shows as it is.

Where labels show:

- the model pickers in Settings and onboarding;
- the bot panel's model row;
- the gateway's "Switched to …" notice.

Cursor's `default[]` ("Auto") repeats our own "Default" entry, which lets the provider choose. So
`listedModels(ids)` drops it from lists. A bot that already has it saved still shows it, as "default".

### The main bot is "SmartyPrompt"

- **New installs** start with "SmartyPrompt".
- **Existing installs.** A default bot still named exactly "Smarty" (id `smarty`) is renamed once, as the earlier
  rename from the reference's name was. A name the user chose is left alone.

### Light mode: the white bot is black

On the light theme a white bot's avatar turns black (`--color-contrast`), and its eyes turn white
(`--color-on-contrast`). This is a token rule scoped to `.avatar[data-bot-color="white"]`. Its chat bubble, Send
button and swatch are left as they are.

### No menu bar

The reference shows no menu bar. Ours stays set, because it carries the Settings shortcut and the edit and view
roles (copy, paste, zoom). But it's hidden: `setMenuBarVisibility(false)`, with `autoHideMenuBar` off, so Alt
doesn't bring it back. Alt is part of our own shortcuts (Alt+↑/↓). This applies on Windows and Linux; macOS keeps its
menu in the system bar.

### The "›" after the bot's name

Hovering the name pill in the chat header, or focusing it from the keyboard, shows a "›" after the name, as the
reference does. It opens the bot panel, as the pill always has.

- **The glyph.** It's a chevron icon in the secondary text color.
- **It opens.** At rest it takes no room. On hover or focus the pill widens smoothly to fit it, fading it in, unless
  the user prefers reduced motion. A first try kept the pill's width, with the chevron in its end padding, but that
  squeezed it against the name and the edge.

## Interfaces

```ts
modelLabel(id: string): string
listedModels(ids: readonly string[]): string[]   // without Cursor's default[]
```

## Test plan

| Acceptance criterion | Shown by |
| --- | --- |
| Model names without brackets, settings in parentheses; no duplicate Auto | `model-label.test.ts` |
| The main bot is "SmartyPrompt", existing "Smarty" renamed once | `bots.test.ts` |
| Light mode: white bot black, eyes white | `theme.test.ts`: the rule and its contrast; manual check |
| No menu bar; shortcuts still work | Manual check: no bar, and Ctrl+, opens Settings, Ctrl+K search, Alt+↓ the next bot |
| "›" on hover of the bot's name | Manual check (hover and keyboard focus); reduced motion stills it |

## Manual check (2026-11-28)

In the built app, on an isolated profile and data dir. The seed data has the default bot, still named "Smarty" and
white on the fake provider, plus "starry" on Cursor with `claude-sonnet-4-5[thinking=true,context=200k]`:

1. **The rename.** The sidebar, header and message box all say "SmartyPrompt".
2. **Light theme.** The white bot is black (`rgb(18, 18, 18)`) with white eyes. Dark keeps it white.
3. **Hover.** Hovering the name pill fades in the "›", the pill widening to fit it, in both themes.
4. **The menu bar.** A capture of the real window shows only Windows' own title bar, with no menu bar, and pressing
   Alt doesn't bring it back. Real keystrokes still work: Ctrl+, opened Settings through the hidden menu, and Alt+↓
   moved to the next bot.
5. **Model names.**
   - starry's panel reads "claude-sonnet-4-5 (thinking, context 200k)".
   - The Models page lists 49 readable names, with the saved one selected by its label and no `default[]` "Auto".
   - The page used the warmed list, starting no Cursor process.
6. **Processes.** A normal quit left no app, gateway or Cursor process running.

**Also found.** 7 orphaned Cursor processes were running from 04:05 to 04:10. They may have come from the owner's
copy of the app on the code from before #96 (each model listing left one), or from this check's earlier test app,
which was force-killed. They couldn't be traced, and they were ended. The same steps on the new code, with a normal
quit, left none.
