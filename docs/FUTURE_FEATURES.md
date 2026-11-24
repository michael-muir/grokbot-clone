# Future features

Features Grok Bot has that an agent backend (Claude Agent SDK, Codex, Cursor CLI) does **not** provide out of
the box. Deferred on purpose. We'll come back to them once the core chat and agent loop works.

Evidence for how Grok Bot implements each one is in [`reference/BEHAVIOR.md`](../reference/BEHAVIOR.md)
(section 7, *Feature map*) and the decoded protobuf schemas in `reference/raw/proto-schemas.txt`.

| # | Feature | What Grok Bot does | Notes for the clone |
|---|---|---|---|
| 1 | **Routines and scheduling** | Each bot has routines with a schedule, trigger description, next run time, and "run as" user. Automations can also be triggered by webhook. | Needs our own scheduler that starts an agent run on a cron or webhook and posts the result into the bot's transcript. (Claude Managed Agents has scheduled deployments if we go that way for Claude bots.) |
| 2 | **Connected apps (MCP connectors)** | Connect Apps catalog (Google Workspace, Outlook, GitHub, Slack, Datadog, Vercel…): OAuth sign-in, per-tool permissions, skills bundled with plugins. | All three providers speak MCP, so one MCP configuration per bot can serve every provider. Needs the OAuth flows, a catalog UI, and per-tool approval settings. |
| 3 | **Vault and secrets** | Logins, payment cards and contact info. Credential-request cards. 1Password integration. Purchases approved with passkeys. | Needs encrypted storage, secret-injection into the bot's computer without exposing values to the model, and approval cards. |
| 4 | **Voice chat** | Per-bot voice and speed (Liora, Ara, Atlas…), language, a short-lived client secret for a realtime WebSocket, plus mic dictation (`transcribeAudio`). | Needs a realtime speech-to-speech provider and a speech-to-text provider. Separate from the agent backend. |
| 5 | **Multiple bots and group chats** | Several bots per user with avatar shapes and colors, a main bot, rooms or group chats where several bots take turns, shared skills library. | The UI already supports multiple bots. The backend needs a bot registry, per-bot provider and model choice, and turn-taking for group chats. |

Related items seen in Grok Bot, also deferred: meetings (calendar watch, meeting recorder),
a per-bot email inbox, phone and iMessage messaging, a shopping cart and virtual cards,
bot templates and marketplace sharing, teams and Slack or Teams apps, and Teach a task (screen recording).
