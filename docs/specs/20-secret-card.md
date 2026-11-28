# #20 Secret request card

Issue: #20 · Milestone: Phase 3 · Bots, cards and polish · Requirements: CD-3 · Stories: US-16 · Builds on #19

## Goal

A bot can ask for a password or key, and the user types it into a card. The bot can then use it in commands. The
value never reaches the transcript, the logs or the model: the model works with a name (`$GITHUB_TOKEN`), never the
value.

## Scope

- **In:**
  - A `secret` card kind and its UI.
  - A `request_secret` tool, for the built-in loop and for Claude.
  - Keeping each value in the OS keychain, per bot and name.
  - Handing values to the bot's commands as environment variables.
  - Removing values from any output that goes back to the model or into the transcript.
  - Deleting a bot's secrets with the bot.
- **Out:**
  - **Viewing, renaming and deleting saved secrets in the app:** the vault (#35).
  - **Delivery as a file.** The issue allows an env var or a file, and env vars are enough. A file in the workspace
    would be readable by every file tool, and by Claude's own Read, which we can't filter.
  - **Using secrets in Claude's own Bash tool.** See Design: Claude gets them only through our `run_command`.

## Reference

- The reference's card kinds include `secret-request` and `app-secrets-request`, with `PutGrokBotSecret` and
  `SubmitSecret{entry_id, value}` (reference/BEHAVIOR.md §5 and §7).
- Its box keeps secrets apart from the conversation.
- The words and UI here are our own.

## Design

### Where the value goes, and where it never goes

```
card (password field) → IPC → HTTP POST /bots/:id/cards/:entryId {answer: {kind:"secret", value}}
  → gateway: value → keychain (service "smarty-prompts-bot-secrets", account "<botId>/<NAME>")
             card entry ← {kind:"secret", saved: true}      (no value)
             waiting run ← {kind:"secret", saved: true}     (no value)
  → model reads: "The user saved GITHUB_TOKEN. … use $GITHUB_TOKEN …"
commands the bot runs (loop shell tool, Claude's run_command) → env GITHUB_TOKEN=<value>
  → their output, with every occurrence of the value replaced by "[secret GITHUB_TOKEN]" → model, transcript
```

### Server

**Types and rules** (`types.ts`, `cards.ts`):

- `CARD_KINDS` gains `"secret"`. A `SecretCard` is `{ kind: "secret", name, label, reason? }`.
- The answer saved and given back is `{ kind: "secret", saved: boolean }`. `saved: false` means the user declined.
- The value only appears in what the client sends, `SecretAnswerIn = { kind: "secret", value }` or
  `{ kind: "secret", declined: true }`, and never in a type that's stored.
- Names follow `^[A-Z][A-Z0-9_]{1,63}$`. Names that would break or take over the environment are refused: `PATH`,
  `HOME`, `USERPROFILE`, `SYSTEMROOT`, `TEMP`, `GATEWAY_TOKEN`, any `CLAUDE*`, and so on.
- A value is 1 to 10,000 characters.

**`BotSecrets`** (`secrets.ts`):

- `set`, `get` and `delete` of one bot's secret, on a `SecretStore`:
  - the keychain in the app;
  - memory in tests.
- `all(botId)` returns the bot's names and values. The names are listed on the bot (`Bot.secretNames`, never a value;
  hidden from `PublicBot` like the sessions).
- **Keychain unavailable:** saving refuses with a plain error, and the card shows it. A value never falls back to a
  file.

**Gateway:**

- `answerCard` on a secret card:
  - stores the value;
  - records the name;
  - resolves the run with `{saved: true}`;
  - writes the entry with that answer only.

  The value isn't kept in a variable longer than this call, and it's in no error message. A decline resolves with
  `{saved: false}`.
- `RunRequest.secrets?: () => Record<string, string>` reads the bot's current secrets when a command runs, so a
  secret saved earlier in the same run works at once. It's never logged or stored.
- `deleteBot` deletes the bot's secrets.

**Redaction** (`redact(text, secrets)`, pure, in `secrets.ts`): replaces every value of 4 or more characters with
`[secret NAME]`, longest first. It's applied to:

- **Built-in loop:** every tool result, centrally in `runTool`, before it goes into the history the model gets or
  into the transcript.
- **Claude:** `run_command`'s output.

**Built-in loop:**

- **`request_secret` tool:** read-only. It's offered when the app declared the `secret` card kind.
- **Shell tool:** runs commands with the bot's secrets as extra environment variables, through
  `ShellOptions.env`, layered over `childEnv()`.

**Claude:**

- **Claude Code can't be filtered.** Its own tools run inside Claude Code, which sends their results to the model
  before we see them. So its Bash never gets secrets: the Claude process env stays `childEnv()`.
- **Our in-process MCP server** (the #19 one) adds two tools:
  - `request_secret`, allowed without asking. It's offered when the app declared `secret`.
  - `run_command`, which runs one command with the bot's secrets and returns redacted output. It goes through
    `canUseTool`, so it needs approval like Bash, and the card shows the command. It's offered when the bot has
    secrets or the app can show secret cards.
- **The tool result tells Claude** to use `run_command` for commands that need the secret.

### App

**`SecretCard`** (in `Card.tsx`):

- Shows the label, the reason, and the name it will be saved as.
- Has a password input (`type="password"`, `autoComplete="off"`, not spell-checked), and Save and "Don't share"
  buttons.
- The value lives in the input only:
  - it's cleared as soon as it's sent;
  - it's never put in a draft or log;
  - it's never in React state that outlives the card.
- **Answered:** "Saved as GITHUB_TOKEN" or "Not shared", locked.

**IPC:** `answerCard` accepts the secret answer shapes. The main process passes it on and never logs it. Its error
path carries the gateway's message only, which never holds the value.

## Interfaces

```ts
CARD_KINDS = ["widget", "form", "secret"]
interface SecretCard { kind: "secret"; name: string; label: string; reason?: string }
CardAnswer | { kind: "secret"; saved: boolean }
// sent by a client only:
type CardAnswerIn = CardAnswer | { kind: "secret"; value: string } | { kind: "secret"; declined: true }
RunRequest.secrets?: () => Readonly<Record<string, string>>
Bot.secretNames?: string[]                       // not in PublicBot
ShellOptions.env?: Record<string, string>
redact(text, secrets): string; class BotSecrets; interface SecretStore; KeychainSecretStore; MemorySecretStore
```

## Test plan

| Acceptance criterion / task | Shown by |
| --- | --- |
| Secret card UI | `rows`/IPC shape tests; manual check (below) |
| Deliver the value to the bot's workspace as an env var | `secrets: a saved secret reaches the bot's commands as an environment variable, in the same run`; `claude: run_command runs with the secrets and needs approval` |
| Transcript and model context hold only a placeholder | `secrets: the transcript and the model see a placeholder, never the value` (searches every transcript line, the bots file, every model request and the log for the value); `secrets: command output holding the value is redacted before the model and the transcript` |
| The value never appears in the transcript, logs or provider requests | The same search test, with `console` captured. Also `secrets: a refused or declined secret leaves nothing behind` |

Other tests:

- `secret rules: names and values` (bad and reserved names refused).
- `redact: longest first, short values left alone`.
- `secrets: deleting a bot deletes its secrets`.
- `secrets: an unavailable keychain refuses the save, and the card can be tried again`.

**Manual check, 2026-11-27.** In the app, on the fake provider, with an isolated data folder and the real Windows
keychain:

- **Asking:** `/secret` showed a "Demo token" card: the reason, "Saved as DEMO_TOKEN, only for this bot. The bot
  never sees the value.", a masked password field, and "Don't share" and Save. Save stayed disabled until something
  was typed.
- **Saving:** after typing a test value and saving, the card said "Saved as DEMO_TOKEN" and the field was empty.
- **Using it:** `/secret-echo` asked to approve `Write-Output $env:DEMO_TOKEN`. After Allow, the reply was "The
  command printed: [secret DEMO_TOKEN]": the command had the value, and the reply only its name.
- **Searching for leaks:** a search of the whole data folder (transcript, bots file, sessions) and the app's log
  for the value found nothing.
- **Cleanup:** the test value was found in Credential Manager under `smarty-prompts-bot-secrets` and deleted after
  the check.

## Risks and open questions

- **A deliberate leak through Claude's own tools.** Claude could still get the value through its own tools, by
  having `run_command` write it to a file and then reading that file with its Read tool. That command needs the
  user's approval and the card shows it. The fix belongs with the bot's container (Phase 4), where its files can
  be kept apart.
- **Values held in memory.** The gateway holds them while a command runs and they pass through IPC. They're never
  written anywhere but the keychain.
