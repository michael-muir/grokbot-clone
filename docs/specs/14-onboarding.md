# #14 Onboarding: name the bot and pick a model

Issue: #14 · Milestone: Phase 2 · Desktop app core · Requirements: UI-3, BC-1 · Stories: US-12

## Goal

On first launch, a new user goes from opening the app to a working chat in under two minutes: a welcome screen,
a provider and model step (with the key if one is needed), and naming the bot, then straight into the chat with
the composer focused.

## Scope

- In:
  - A full-window first-run flow in the renderer, three steps: **Welcome** → **Pick a model** → **Name your bot**.
  - The model step: provider picker (usable providers only), API key field when the provider needs one and has
    none, server address for local servers, a **Connect** button that saves the key and tests the provider, then
    a model picker filled from the provider's list. Continue is enabled only after a successful test.
  - The name step: the reference's "What would you like to call me? You can always change this later.", a
    text field prefilled with the bot's current name.
  - Finishing saves provider, model and name on the main bot in one `updateBot` call, sets `onboarded`, and lands
    in the chat.
  - **Set up later** on every step: marks onboarding done and opens the app as it is (Settings › Models & keys
    remains the place to change things).
  - `onboarded` app setting. A settings file saved before this setting existed counts as onboarded (that person
    has used the app); a new install starts with `false`.
- Out (and where it goes instead):
  - The reference's sign-in screen (`01-launch.png`): there's no account. Our welcome screen takes its place and
    layout.
  - Naming inside the chat as a choice card with the bot's greeting (`06-main-welcome.png`, `08-after-name.png`):
    needs the gateway to post entries outside a run. Left for a later issue; the name step uses the same words.
  - The animated mascot (`03-onb1`, `04-onb2`): a static face now; motion comes with #43/#44, the own mascot with
    #32.
  - Connecting apps (Outlook) during onboarding: #34.

## Design

`App` reads settings first. Until they arrive it renders nothing extra; when `settings.onboarded` is false and
the gateway is connected with at least one bot, it renders `<Onboarding>` instead of the shell. The gateway
connection, bot list and `desktop.ready()` call are unchanged, so the smoke check still passes on a fresh
profile.

New files under `app/src/renderer/src/onboarding/`:

- `Onboarding.tsx`: the three steps. Owns local state (step, provider, key draft, server, model, name, test
  state). Talks to the gateway through the existing `call()` (`listProviders`, `setKey`, `testProvider`,
  `updateBot`). The key draft is cleared as soon as it's sent, as in Settings.
- `onboarding-state.ts`: pure decisions, tested in Node:
  - `usableProviders(list)`: providers that aren't placeholders, in list order.
  - `firstProvider(list, current)`: the bot's current provider if usable, else the first configured one, else the
    first usable one.
  - `needsKey(p)`: a key field is shown (the provider takes a key and has none).
  - `firstModel(models, current)`: the bot's model if listed, else the first listed model, else "" (Default).
  - `checkBotName(text)`: trimmed, 1 to 40 characters, or a short reason.
- `onboarding.css`: layout from the reference launch screen (centred column, large headline, tagline), tokens
  only, focus states, and `prefers-reduced-motion` turns off the step fade.

Focus: each step moves focus to its heading-adjacent primary control (provider picker, name field); Enter in the
name field finishes. Every control is a native button, input or select.

Copy is ours, not the reference's: "SmartyPrompts" / "Bots that work on their own computer, with the model you
choose."

## Interfaces

- `AppSettings.onboarded: boolean` (default `false`); accepted by `checkSettingsPatch`.
- `parseSettings(raw)`: when `raw` is a stored settings object without `onboarded`, returns `onboarded: true`.

## Test plan

| Acceptance criterion (from the issue) | Shown by |
| --- | --- |
| A new user reaches a working first message in under 2 minutes | Manual check, timed on a fresh profile (`--user-data-dir` to a temp folder) with Ollama and with a keyed provider; written in the PR. The flow is 3 screens and at most 4 inputs (provider, key, model, name). |

Other tests (`app/test/onboarding.test.ts`, `app/test/settings.test.ts`):

- provider ordering and the current-provider preference; placeholders are never offered
- key field shown only for a keyed provider without a key
- model choice: current, first listed, Default when none
- bot name: trimmed, empty refused, too long refused
- settings: a new install isn't onboarded; an old file without the field is; the patch accepts `onboarded`
- `npm run smoke` on a fresh profile still exits 0

## Risks and open questions

- An existing user whose settings file was never written (they never changed a setting) sees onboarding once.
  **Set up later** gets them out in one click, and nothing they had is changed unless they finish.
