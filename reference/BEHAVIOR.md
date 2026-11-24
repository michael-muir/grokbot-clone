# Grok Bot — behavioral teardown

Source: `C:\Program Files\Grok Bot` v1.2.3 (`sandTrack: stable`, built 2026-11-18), analyzed statically
with REA plus text search over the extracted `app.asar`. Nothing was executed except the UI session
used for the Paper designs (see `screens/`). **Observed** = present in shipped code/protos.
**Inferred** = reasonable reading of observed code; not confirmed at runtime.

## 1. What it is

- Internal name **"sand"**; `author: SpaceXAI`; built from Cursor's (Anysphere) monorepo —
  depends on `@anysphere/agent*`, `@anysphere/grok-bot`, `@anysphere/grok-bot-harness`. *(observed, package.json)*
- Backend is Cursor's `aiserver.v1` ConnectRPC API (`api2.cursor.sh`, `api.origin.cursor.com`),
  sign-in through cursor.com. Model id `grok-4.5` appears in the client. *(observed)*
- Product idea: each **Bot** is a long-lived agent with **its own cloud Linux computer** ("box"),
  which can also, with permission, act on **your** desktop. *(observed)*

## 2. Process architecture

```
Grok Bot.exe (Electron, fuses: no RunAsNode, no --inspect, ASAR-only, integrity on)
 └─ main.cjs  — tiny bootstrap: sets userData, V8 code cache, enterprise backend pin
     ├─ main-core.cjs  — phase 1 (startup, auth, single instance)
     └─ main-app.cjs   — phase 2 (everything else; ~177 typed RPC methods for the renderer)
          ├─ utilityProcess: node-agent-coordinator   (agent/transcript sync; renderer talks to it
          │                                           over a MessagePort: "sand:coordinator-port")
          ├─ local-exec-daemon (+ messages-worker)    (executes cloud requests on YOUR machine)
          ├─ local-meeting-recorder.cjs               (lazy; local meeting capture + STT)
          ├─ onepassword-connection-service.cjs       (lazy; 1Password connector)
          └─ native/sand-webauthn-signer.exe          (passkeys for spend approvals)
 renderer: React 19 + StyleX + TanStack Query + TipTap composer + Lingui i18n (Vite chunks)
 preloads: vnc (live view of the bot's box), webview, desktop-mount panel/capture overlay,
           spotlight element-pick overlay, avatar source
 native addons: window capture, card OCR, address lookup, devicecheck, notification settings,
                cursor-proclist, jpeg, tree-sitter(bash)
```
*(observed: file layout, `utilityProcess.fork`, `sand:coordinator-port(-request)`, lazy `import()` sites)*

Enterprise: `DeploymentBackendUrl` / `DeploymentWebsiteUrl` can be pinned via macOS defaults,
Windows policy (read by the `sand-notification-settings` addon), or `~/.cursor/policy.json` on Linux. *(observed, main.cjs)*

## 3. Sign-in

1. Client makes a random 32-byte **verifier**, a hashed **challenge**, and a **uuid**.
2. Opens `https://cursor.com/loginDeepControl?challenge=…&uuid=…&mode=login&redirectTarget=…`.
3. Polls `{backend}/auth/poll?uuid=…&verifier=…` until tokens are delivered (403 handled specially).
4. Optional `POST /auth/exchange_user_api_key` for API-key logins.
*(observed, main-app.cjs)* → This is the "Continue in your browser / Reopen link / Copy link" screen.

## 4. The bot's cloud computer ("box")

- `EnsureSandBox{wake, supports_asleep_box}` → returns `cluster, tenant_id, pod_id`,
  `exec_daemon_url + auth token`, `vnc_url`, `gateway_url + token`, `terminals_folder`,
  `run_state`, `image_update_available`, egress-tunnel tokens, credential refresh interval. *(observed proto)*
  → The box is a **Kubernetes pod** running a Linux desktop at `/home/box` with its own exec daemon,
  VNC server, and gateway. *(inferred from fields + `/home/box/agent-data`, `/home/box/reference/app-actions.md`)*
- UI connection states: `creating, waking, connecting, settled, following, away, asleep` *(observed)* —
  the panel's "Bot's computer · Asleep" card. Boxes hibernate and wake on demand.
- Storage: presigned multipart reads/writes + a manifest commit (`PresignSandBoxStoreWrites`,
  `CommitSandBoxStoreManifest`) — box state is snapshotted to object storage. *(observed)*
- Optional **egress tunnel**: the box can route traffic through the user's machine
  (`isEgressTunnelAvailable`, `egress_tunnel_*` tokens). *(observed names; mechanism inferred)*
- Upgrades are scheduled/rescheduled per box (`ScheduleSandBoxUpgrade`). *(observed)*

## 5. Conversation loop

- **Send**: renderer `sendPrompt` → main → `SendGrokBotUserMessage{agent_id, message_id, text,
  rich_text, reply_to_id, attachment_paths, session_id, machine_id, rendered_card_kinds, …}`
  → `{dispatched, mode, workflow_id, delivery, refusal}`. *(observed)*
  `workflow_id` + `temporal_harness_mode` ⇒ each agent run is a **server-side Temporal workflow**. *(inferred)*
- **Receive**: `WatchGrokBotTranscripts{cursors[]}` server stream of
  `GrokBotTranscriptEntry{seq, entry_kind, body bytes | blob_hash, updated_seq, task_numbers}`;
  large bodies fetched separately. Entries are append + update-by-seq (so the "Typing…" /
  "Saving the name" / "Installing the plugins" status rows update in place). *(observed schema; UI behavior seen live)*
- Control: `InterruptGrokBotAgentRun`, `RollBackGrokBotConversation`, `StartFreshGrokBotConversation`,
  `CreateGrokBotThreadFromMessage`, `ReactToGrokBotMessage`, `VoteGrokBotFeedback`. *(observed)*
- **Interactive cards** the bot can post (the renderer declares which it supports via `rendered_card_kinds`):
  `widget, user-form, connector(s), credential-request, secret-request, app-secrets-request,
  email-draft, slack-draft, publish-approval, auto-review-approval, virtual-card-approval,
  cookie-origin-approval, meeting-join-consent, notifications-enable, onepassword-connect,
  appearance-picker, cursor-agent, x-money-challenge`. *(observed set)*
  Answers go back via `RespondGrokBotWidget{agent_id, entry_id, value}` / `SubmitGrokBotUserForm`. The
  "What would you like to call me? → C Grok Bot" card in onboarding is a `widget`.

## 6. Bot acting on YOUR computer (remote-control bridge)

The cloud agent cannot reach your machine directly; the desktop **long-polls/streams** for work:

```
desktop ──WatchGrokBotUserComputerRequests{machine_id, credential, hello, presence}──▶ server
        ◀── events: connected | notify | heartbeat
desktop ──PollGrokBotUserComputerRequests{ack_ids, limit}──▶ requests[]
desktop ──SubmitGrokBotUserComputerResponses{frames[]}──▶
```
Request frame kinds *(observed)*: `exec` (shell, streamed), `upload`, `download`,
`put_file_to_url`, `get_file_from_url` (sha256-verified), `local_tool` (call a desktop tool with
JSON input + optional image uploads), `discover_ai_tool`, `messages_op` (iMessage — mac only),
`retire_approval`, `cancel`.
Every frame carries `approval_id` and/or `authorized_by_standing` / `authorized_by_approval`.

- `hello` advertises `local_root`, `terminals_folder`, `standing` grant mode, `supervised`,
  capabilities (`shell`, `url_file_transfer`, `local_standing_grants`, `ai_tool_setup`, mobile tools…). *(observed)*
- The **local-exec-daemon** enforces it: standing grants persist in
  `local-tool-standing-grants.v1.json`; decisions are `allow | ask | refused`; a "global" standing grant
  auto-allows, otherwise a per-request approval card is shown (`resolveLocalToolPermission`). *(observed)*
- The daemon exits if the desktop stops supervising it (heartbeat/lease), and withdraws presence. *(observed)*

## 7. Feature map (RPC evidence)

| Feature (UI) | Mechanism |
|---|---|
| Multiple Bots, avatars (shape × color) | `CreateGrokBotAgent{name, avatar_shape, avatar_color, harness, purpose}`; 26 shapes in tray assets (`bot-flower`, `bot-teardrop`, `bot-hex`…) |
| Main Bot | `SetGrokBotMainAgent`, `EnsureGrokBotDefaultMainAgent` |
| Routines / automations | `ListGrokBotAgentRoutines{schedule, trigger_description, next_run_at_ms, run_as…}`, `RunGrokBotAgentAutomationNow`, webhooks (`runAutomationWebhook`) |
| Tasks / todos / subagents | `ListGrokBotAgentTasks/Todos`, `ListGrokBotSubagents`, `MarkGrokBotAgentTaskDone` |
| Library (Activity / Library tabs) | `ListGrokBotLibraryDocs`, `SetGrokBotLibraryPin`, agent store files |
| Memory | `ListGrokBotUserBotMemories`, `PromoteGrokBotMemoriesToTeam` |
| Connect Apps | MCP connectors (Google Gmail/Drive/Calendar/Docs/Sheets/Slides/BigQuery via `*mcp.googleapis.com` OAuth scopes, X, Slack, Teams, Linear, Figma, Canva, Miro, QuickBooks, Shop…), custom MCP, per-tool permissions, skills marketplace |
| Teach a task | `startTeachRecording{agentId, entryPoint}` → screen capture (`sand-window-capture` + capture-overlay preload) → `stopTeachRecording{save}` → `takeTeachLearningPrompts` / `confirmTeachLearningPrompt` |
| Voice chat | `MintSandVoiceCallSecret` → `{client_secret, model, websocket_url}`; renderer opens a realtime WebSocket with `?model=`; voice per bot (`SetGrokBotAgentVoice`, e.g. "Liora 1.0x") |
| Voice input (mic) | `transcribeAudio` (`grok-transcribe`) |
| Meetings | calendar watch, join-consent cards, local recorder + STT, meeting records/transcripts |
| Email | each bot can own an inbox (`CreateGrokBotEmailInbox`, read/search threads); drafts need approval |
| Messaging | phone/iMessage linking, group chats, SMS codes |
| Purchases | cart, checkout, vault cards, virtual cards, spend limits, **passkey-signed** spend approvals |
| Secrets | `PutGrokBotSecret`, 1Password integration, box secrets |
| Sharing | Share → "Create a copy / Share a template link" = bot **templates** + public marketplace |
| Teams | team bots, rooms (multi-bot group chats), Slack/Teams apps, review queues |
| Live view | VNC into the box (`preload-vnc`, `vnc_url`, fork VNC), "Take over" / hand back (`handBackForeverBox`, `EndGrokBotBoxHandoff`) |

## 8. Implications for the clone

- The heavy lifting (agent loop, model calls, box orchestration, connectors) is **server-side**. A
  clone needs its own backend; the desktop is mostly a rich client + a local executor.
- Minimal viable architecture mirroring this design:
  1. Desktop (Electron/Tauri) with a typed IPC layer and a transcript store keyed by `seq`.
  2. Backend: `sendMessage` → durable workflow (agent loop with tool calls) → append-only
     transcript stream (SSE/WebSocket) with in-place updates and card entries.
  3. Per-bot sandbox (container/VM) with exec + VNC, sleep/wake.
  4. Optional local executor that pulls requests and gates them with per-request approvals +
     persisted standing grants.
- Do **not** call Cursor/xAI private endpoints from the clone; use your own backend and a public
  model API. Use your own name, mascot, and copy for anything shipped.

## Open questions (not resolved statically)
- Exact `entry_kind` values and body encoding of transcript entries (bodies are opaque bytes in the proto).
- Agent tool list inside the box (lives server-side / in the box image).
- Voice realtime protocol message shapes.
These need runtime observation (CDP network capture of a session) to confirm.
