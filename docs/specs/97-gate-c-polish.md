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

- **The glyph.** It's a chevron icon in the text color. It fades and slides in, unless the user prefers reduced
  motion.
- **The pill keeps its width.** The chevron takes its place at rest, invisible, so nothing moves on hover.

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
