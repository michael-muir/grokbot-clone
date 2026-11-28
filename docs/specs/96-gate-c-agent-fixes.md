# #96 Gate C fixes: Codex commands, Cursor sessions, model list speed

Issue: #96 · Milestone: Phase 3 · Bots, cards and polish · Found in the owner's Gate C check (#40)

## Goal

Three problems from the owner's check of Codex and Cursor bots in the app, each with its cause found by a probe.

## 1. Codex bots can't run commands

**Cause.** The isolation flags (#25) turned off `code_mode_host`. That turned out to be Codex's shell host: without
it the model has no command tool and says so.

A live probe (2026-11-28) asked Codex to run `echo hi`:

- **With it off:** "I couldn't execute it because the shell host is disabled."
- **With it on:** an approval card, then the command ran and returned `hi`.

**Fix.** `code_mode_host` leaves `DISABLED_FEATURES`. On Windows Codex wraps every command as
`"...\powershell.exe" -Command '<cmd>'`, so cards and steps show just `<cmd>` (`shownCommand`), and the card's input
keeps the whole line.

This change: Nothing escapes the workspace through it: commands still run
under `approvalPolicy: "untrusted"` and the `workspace-write` sandbox, so each one asks first. The #25 spec is
updated.

**Known gap until Phase 4.** Codex's `untrusted` policy runs commands it considers known-safe reads (`ls`, `cat`
and the like) without asking. Its sandbox limits writes, not reads, and Codex has no "always ask" policy. Its
policies are `untrusted`, `on-request`, `never` and a granular form.

- **Windows.** Every command is wrapped in PowerShell, so none counts as known-safe. A probe of `type
  C:\Windows\win.ini`, outside the workspace, asked first, and a denial blocked it.
- **macOS and Linux.** A known-safe read outside the workspace may run without a card. Phase 4 (Gate D: no bot
  tool touches the host) runs bots away from the host, which closes this.

## 2. Cursor bots fail with "Invalid params" after the first message

**Cause, as first found.** The owner's Cursor bot answered its first message, then every later one failed. The failing call is
`session/load`. Cursor had saved that session's `meta.json`, but not its conversation (`store.db`).

- **How runs end.** A run ends with `close()`, which kills the process at once.
- **The Windows shim.** On Windows the process is the `cmd` shim (npm's `cursor-agent.cmd`), so the kill ends
  `cmd`, not Cursor behind it. Cursor is cut off before it writes the conversation.
- **The same in our check.** The sessions from our own live check also had `store.db-wal` files left over, the mark
  of an unclean end.

A probe shows `cursor-agent acp` exits by itself, in about 70 ms, when its input closes.

**First fix** (`stdio-rpc.ts`, shared with Codex):

- **Closing.** `close()` now closes the process's input and lets it exit.
- **Killing.** Only if it hasn't exited after a grace period (3 s) is it killed, and then as a whole process tree.
  On Windows that's `taskkill /pid <pid> /T /F`, so a shim's child goes too; elsewhere it's `SIGKILL`.

**What that fix did and didn't do.** The first live check with the owner's model set still failed the second
message. Each Cursor process now ended cleanly, and no orphans were left. But no `store.db` was written at all.

**The real cause.** Choosing the model inside a session (`session/set_model`) stops Cursor saving that session.
Cursor's handler re-syncs every open session to the new model. A probe showed the difference:

- **With `set_model`:** the session runs on that model, but its conversation is never saved.
- **With the model already chosen when the process starts:** it saves. This is Cursor's own `acp-config.json`
  setting, `selectedModelVariantId`. The session reports that model as current, answers, and writes `store.db`.

**Second fix** (`cursor.ts`):

- **The model.** `session/set_model` is no longer called. The model is written to the home's `acp-config.json`
  before Cursor starts (`chooseModel`); with none, the setting is removed and Cursor uses its default. Other settings
  in the file are kept.
- **A home per bot.** That setting is per home, so each bot gets its own Cursor home, `<cursor-home>/bots/<botId>`.
  A bot runs one reply at a time, so its setting can't change under a running reply. Model lists use
  `<cursor-home>/models`. The turn log stays shared.
- **A session that won't load.** Sessions saved before this fix, or lost, can't be loaded. Then the run doesn't
  fail: it opens a new session that carries the conversation from the turn log, as a fork from its end would, and
  the log goes on from there. The owner's existing Cursor bot recovers this way.

**Also found.** The old kill ended only the `cmd` shim. Behind it, npm's shim runs PowerShell, which runs Cursor's
Node, so 8 orphaned Cursor processes from today's gateways were still running on the owner's machine. They were
ended by hand. The tree kill and the graceful close prevent new ones: none was left after the live check.

**The model-list temp folder.** Cursor now exits on its own, so it still holds its temp folder for a moment. The
folder is removed after it exits, without holding up the answer.

## 3. Model lists for Codex and Cursor are slow

**Cause.**

- **Every open starts the CLI.** The model picker loads its list each time it opens, through `POST
  /providers/:id/test`, which always asks the provider. For Codex and Cursor that starts the CLI: several seconds.
- **Refresh does the same.** So it can't be faster.

**Fix** (`server/src/model-lists.ts`):

- **A cache.** `ModelLists` keeps each provider's list (per base URL) for 10 minutes. Asks made while a list is
  loading share that load, and a failure isn't kept.
- **`POST /providers/:id/test {cached: true}`** answers from the cache when it can. Without it, the list is fetched
  fresh and stored, so "Test" and Refresh always ask the provider.
- **Opening the picker** passes `cached: true`; Refresh doesn't.
- **Keys.** Saving or removing a provider's key forgets its lists.
- **Warm-up.** On start the gateway loads the Codex and Cursor lists in the background, when they're set up. Each
  failure is logged, and nothing is shown.

## Review changes

- **Key changes.** A list loading when a key changes isn't stored, and the next ask starts a new load (a generation
  per provider).
- **Stop and timeouts close at once:** `close(true)`. An aborted model listing and a Cursor that didn't answer
  its cancel are killed without the grace.
- **Shutdown.** It ends every agent process still running (`endAllNow`). Windows doesn't end children with their
  parent.
- **Late handlers.** `onExit` added after the exit is called at once.
- **Unwrapping.** `shownCommand` unwraps only Codex's exact form. That's one single- or double-quoted argument with
  nothing after it; anything else shows whole.

## Interfaces

```ts
// model-lists.ts
class ModelLists {
  constructor(providers: ProviderRegistry, ttlMs?: number, now?: () => number)
  get(id: ProviderId, opts?: { baseUrl?: string; cached?: boolean }): Promise<string[]>
  forget(id: ProviderId): void
  warm(ids: ProviderId[]): void   // background loads; failures are logged
}
// stdio-rpc.ts: spawnLines(..., opts?: { exitGraceMs?: number }) — close() ends input, then kills the tree
```

**IPC.** `testProvider(provider, baseUrl?, cached?)`.

## Test plan

| Acceptance criterion | Shown by |
| --- | --- |
| A Codex bot asked to run a command shows a card and runs it | `codexArgs` test (shell host stays on); live check |
| A Cursor bot answers later messages in its session | live check (below); `cursor.test.ts`: the model goes to the bot's home at launch, never `set_model`; `chooseModel` writes and clears it; a session that won't load continues from the log |
| CLIs end by closing input; killed (tree) only if late | `stdio-rpc.test.ts`: a child that exits on EOF isn't killed; one that ignores EOF is killed after the grace |
| Lists open at once after the first load; Refresh is fresh | `model-lists.test.ts`: cached within the TTL, shared in flight, failures not kept, `cached: false` refetches, `forget` clears; `http` test of `cached` |

## Manual check (2026-11-28)

Through a gateway on a throwaway data dir, on the owner's signed-in Codex and Cursor:

1. **Cursor, with the owner's model** (`claude-sonnet-4-5[thinking=true,context=200k]`):
   - "hello", then "again" in the same session: the second message failed before the fix and works now;
   - a roll back forked into a new session that remembered "hello";
   - a fourth message resumed the forked session.

   Both sessions saved `store.db`, and no `-wal` was left from an unclean end. No Cursor process was left running
   afterwards.
2. **Codex, "Run `echo smarty-check`…".** An approval card appeared. Approved, the command ran and the reply was
   "smarty-check".
3. **Model lists.** The warmed Cursor list came back in 68 ms through `POST /providers/cursor/test {cached: true}`.

