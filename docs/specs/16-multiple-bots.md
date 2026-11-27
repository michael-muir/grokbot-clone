# #16 Multiple bots: create, rename, delete, avatar, main bot

Issue: #16 · Milestone: Phase 3 · Bots, cards and polish · Requirements: BC-1 · Stories: US-13

## Goal

Users can run several bots, each with its own name, avatar, model and workspace: create one from the sidebar,
give it a shape and a color, make any bot the main bot, and see every bot in the sidebar.

## Scope

- In: `POST /bots`; avatar and main-bot changes through `PATCH /bots/:id`; the "Create New Bot" dialog
  (`reference/screens/15-new-bot.png`, `41-newbot-filled.png`); the shape and color picker, also in the bot panel
  (`35-edit-avatar.png`, its "Bot" tab); a "Make main bot" menu item; avatars drawn with their shape everywhere.
- Already done elsewhere: rename (#10, bot panel), delete (#66), the sidebar list (#10, #66), one workspace per
  bot (`LocalFolderComputers`).
- Out: the panel's "Generate" and "Upload" avatar tabs (generated and uploaded images; later, with the vault
  work), the reference's "To: Start a chat with…" group-chat screen (group chats, future features), voice and
  language rows.

## Design

**Shapes.** Our own set of twelve simple shapes, not the reference's mascot art (ground rules): `circle`,
`square`, `diamond`, `hexagon`, `pentagon`, `octagon`, `triangle`, `star`, `flower`, `cloud`, `shield`, `drop`.
The avatar stays the bot's initial on its color; the shape is the outline. The names are part of the contract:
`AVATAR_SHAPES` and `AVATAR_COLORS` in `server/src/types.ts` (the color list moves there from the app's
`bot-colors.ts`, which re-exports it). Unknown names draw as `circle` / the default color, so old files still
render.

**Gateway.**

- `BotRegistry.add(bot)` and `BotRegistry.makeMain(id)` (moves it first; `bots.json` keeps the order).
- `Gateway.createBot({name, avatar?})`: the id comes from the name (`nova`, `nova-2`, … ; `[a-z0-9-]+`, `bot` if
  nothing usable is left). A new bot starts on the main bot's provider, model and server, so it works at once
  with what onboarding set up; its model is changed in Settings like any bot's. Default avatar: `circle` and the
  first color no bot uses yet.
- `updateBot` takes `avatar` and `main: true`. Making a bot main also shows it (the main bot can't be hidden).
- `POST /bots {name, avatar?}` → 201 with the bot; 400 for a missing or too-long name (40 characters) or an
  unknown shape or color. `PATCH /bots/:id` accepts `avatar {shape, color}` (both checked) and `main: true`.

**App.**

- `Avatar` (`shell/Avatar.tsx`): the shape in the bot's color as inline SVG with the initial on top. Used by the
  sidebar tiles, the header pill, the panel, the status rows, and the pickers.
- `AvatarPicker`: a radio group of shapes and one of colors (arrow keys move and choose, as native radios do),
  drawn in the current color and shape.
- `CreateBotDialog`: "Create New Bot", the large preview, "Name your bot", the picker, Cancel / Create (Create
  is disabled until there's a name). Focus starts in the name field, Tab stays inside, Escape and the × close.
  Enter in the name field creates. A refusal shows in the dialog. After creating, the new bot's chat opens.
- A "New bot" (+) button in the sidebar footer, above Settings, as in the reference.
- Bot panel: the large avatar is a button ("Change avatar") that opens the picker under it; each pick saves at
  once. Escape closes the picker first, then the panel.
- Bot menu: "Make main bot" for any bot but the main one, first in its own group.

New tokens: `--size-avatar-xl` (the dialog's preview), `--size-swatch`, `--shadow-avatar-edge`.

## Interfaces

- `POST /bots` `{name: string, avatar?: {shape, color}}` → 201 `PublicBot`
- `PATCH /bots/:id` gains `avatar?: {shape, color}` and `main?: true`
- `GatewayClient.createBot({name, avatar?})`; `BotPatch` gains `avatar` and `main`
- IPC `createBot: {args: [input: NewBot]; result: PublicBot}`
- `AVATAR_SHAPES`, `AVATAR_COLORS`, `AvatarShape`, `AvatarColor`, `NewBot` in `server/src/types.ts`

## Test plan

| Task (from the issue) | Shown by |
| --- | --- |
| Bot registry API (create, delete) | `bots: creating a bot gives it a unique id from its name and the main bot's model`, `bots: ids come from names, path-safe and unique`, `HTTP: POST /bots creates a bot…`; IPC refusals in `ipc.test.ts`; delete in `bot-management.test.ts` (#66) |
| Avatar shape and color picker | `HTTP: POST /bots creates a bot, and PATCH changes avatars…`; every shape has a drawing and a name (`Record<AvatarShape, …>`, checked by the typecheck); `botShape` fallback in `tokens.test.ts`; manual check (below) |
| Main bot setting | `bots: making a bot main moves it first, shows it, and survives a restart`; manual check (menu) |
| Sidebar lists bots | `sidebar: …` layout tests (#66); manual check: a created bot appears and opens |

Other tests: ids for names with no letters, repeated names, IPC refusals for bad `createBot` and avatar patches,
`sidebar: a new bot gets the first color no bot uses…`.

Manual check (2026-11-27, isolated profile, fake provider, dark and light): + opens Create New Bot with focus in
the name field; typing "Nova", arrow keys to Star and Purple, Enter creates it; the chat opens on Nova and it
replies; Tab stays inside the dialog; Escape closes it back onto +. In the panel, Change avatar → Drop, Teal saves
at once (tile, header, status rows); Escape closes the picker, then the panel. Make main bot moves Nova to the
top with the star badge and focus, and `bots.json` keeps the order. The white swatch got an edge after the
light-theme check.

## Risks and open questions

- A new bot copies the main bot's model. That's the least surprising default; picking a model in the dialog can
  come later if people ask for it.
