# #13 Settings: General and Models & keys

Issue: #13 · Milestone: Phase 2 · Requirements: UI-2, PR-4 · Stories: US-1, US-2

## Goal

The Settings window from the reference. It has two pages:
- **General**: app basics.
- **Models & keys**: choose each bot's provider and model, and add, test or remove API keys. Keys go to the OS
  keychain and are never shown again.

## Scope

- In:
  - **Settings shell**: a modal with a left nav, close button, Escape, a focus trap, and focus returned to the
    opener when it closes.
  - **Opening Settings**: a gear button at the bottom of the sidebar (where the reference has the account
    button), the menu item **Settings…** (`CmdOrCtrl+,`), and a **Change** link on the bot panel's Model card,
    which opens Models & keys for that bot.
  - **General page:**
    - Theme (Follow System / Light / Dark)
    - Check spelling while typing
    - Send with Ctrl+Enter (⌘+Enter on macOS)
    - Use hardware acceleration (applies after a restart, and says so)
  - **Models & keys page:**
    - a bot picker (the open bot first)
    - provider select, with labels and "needs a key" / "local" hints
    - model select from `listModels`, with a Refresh button and a free-text fallback when listing fails
    - a base URL for local servers (Ollama, LM Studio)
    - API key for the selected provider: Save, Test and Remove, with a status line: "Saved in your keychain",
      "From the environment variable" or "No key"
- Out (and where it goes instead):
  - Account (there is no account; sign-in is a future feature)
  - Accent and Language (i18n, later)
  - Microphone (voice)
  - Timezone, Import and Security key (future features)
  - The Computer, Permissions, Vault, Usage and Updates pages (their own phases)
  - None of these is shown; the nav lists only pages that exist.

## Measurements

From `reference/dom/23-settings-General.json` and `reference/screens/23-settings-General.png`:

| Element | Value |
| --- | --- |
| Modal | 898×656 at 1040×760 (inset 71 / 52), `--color-surface`, `--radius-xl`, `--shadow-modal`, over `--color-scrim` |
| Nav | 197px wide, hairline divider on its right. Item: 173×32, radius 8px, padding 7px 9px, 13/18. Selected: `--color-fill-strong` |
| Close | 32px icon button, 10px from the top-right |
| Page title | 500 17/24 at content + 46px |
| Section label | 12/16 `--color-text-secondary`, padding-left 14px. Card: 636px wide, hairline `--color-line`, radius 12px |
| Row | 48px tall: label 13/18 left, control right. A description underneath is 13/18 secondary |
| Select | 28px tall, radius 10px, hairline `--color-line-faint`, padding 4px 5px 4px 7px, 13/18 |
| Switch | 32×20, radius full. On: `--color-accent`. Off: `--color-surface-strong`. Knob 16px `--color-contrast` |

## Design

**App settings (main process)** live in `app/src/main/settings.ts`:
- A JSON file `settings.json` in `app.getPath("userData")`. Every field is validated on load, so a bad or
  missing file gives the defaults.
- `AppSettings = { theme: "system" | "light" | "dark"; spellcheck: boolean; sendWithCtrlEnter: boolean;
  hardwareAcceleration: boolean }`
- How each setting is applied:
  - theme → `nativeTheme.themeSource`. The tokens' `prefers-color-scheme` follows it.
  - spellcheck → `session.setSpellCheckerEnabled`, plus the composer's `spellcheck` attribute.
  - hardware acceleration → read before `app` is ready. When off, the app calls `app.disableHardwareAcceleration()`.
  - send with Ctrl+Enter → read by the composer.
- IPC: invoke `settings:get`, and `settings:set(patch)`, which returns the full settings. A `settings:changed`
  event tells every window, and a `settings:open` event comes from the menu.

**Gateway calls** that already exist: `listProviders`, `listModels`, `testProvider`, `setKey`, `deleteKey` and
`updateBot`. No gateway changes.

**Renderer** (`app/src/renderer/src/settings/`):
- `SettingsDialog.tsx`: `role="dialog"`, `aria-modal`, labelled by its title.
  - Focus trap: Tab and Shift+Tab wrap. Escape closes. Clicking the scrim closes.
  - Focus returns to the element that opened it.
- `GeneralPage.tsx` and `ModelsPage.tsx`.
- `controls.tsx`:
  - `Switch`: a `button` with `role="switch"` and `aria-checked`.
  - `Select`: a native `<select>` styled as the trigger, so it's keyboard- and screen-reader-native.
  - `Row` and `Section`.
- **Models & keys** behavior:
  - Changing a bot's provider calls `updateBot({ provider, model: undefined })`. The gateway refuses this during a
    run, and the message shows on the page.
  - Changing the model calls `updateBot({ model })`.
  - The key field is a password input. Its value is only sent to `setKey` and then cleared. It's never read back,
    logged or kept in state after saving.
  - Test calls `testProvider` and shows "Works: N models" or the provider's error message.
- Pure helpers in `settings/settings-state.ts`, all tested:
  - `keyStatus(summary)`
  - `providerHint(summary)`
  - `modelChoices(listed, current)`: keeps the current model even if it isn't listed
  - `shouldSend` gains a `ctrlEnter` mode

## Interfaces

```ts
// app/src/shared/ipc.ts
export interface AppSettings { theme: "system" | "light" | "dark"; spellcheck: boolean;
  sendWithCtrlEnter: boolean; hardwareAcceleration: boolean }
interface DesktopApi {
  settings: {
    get(): Promise<AppSettings>;
    set(patch: Partial<AppSettings>): Promise<AppSettings>;
    onChange(cb: (s: AppSettings) => void): () => void;
    onOpen(cb: () => void): () => void; // menu: Settings…
  };
}
export function checkSettingsPatch(v: unknown): Partial<AppSettings> | undefined;
```

## Test plan

There are no acceptance criteria in the issue. The tasks are shown by:

| Task | Shown by |
| --- | --- |
| Settings shell and navigation | **Manual check:** screenshot against `23-settings-General.png`; keyboard: open with `Ctrl+,`, Tab wraps, Escape closes and focus returns. A `checkSettingsPatch` test |
| General page | Tests: `settings store: defaults for a missing or bad file, saves, rejects bad values` (pure load and merge), `composer: Ctrl+Enter mode`. **Manual check:** switch the theme to Light and Dark in the app |
| Models & keys | Tests: `keyStatus` / `providerHint` / `modelChoices`. **Manual check:** switch Nova between Fake and Ollama, pick a model, save a dummy key for OpenRouter, Test shows the provider's error (no network call made by the test), remove it. The key never appears in the DOM after saving |

## Risks and open questions

- The menu accelerator `CmdOrCtrl+,` is the platform convention for Settings. Grok Bot's own shortcut wasn't
  captured.
- Hardware acceleration can only change at startup, so the row says "Applies after restarting the app".
