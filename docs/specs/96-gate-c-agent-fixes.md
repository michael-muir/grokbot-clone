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

**Fix.** `code_mode_host` leaves `DISABLED_FEATURES`. Nothing escapes the workspace through it: commands still run
under `approvalPolicy: "untrusted"` and the `workspace-write` sandbox, so each one asks first. The #25 spec is
updated.

## 2. Cursor bots fail with "Invalid params" after the first message

**Cause.** The owner's Cursor bot answered its first message, then every later one failed. The failing call is
`session/load`. Cursor had saved that session's `meta.json`, but not its conversation (`store.db`).

- **How runs end.** A run ends with `close()`, which kills the process at once.
- **The Windows shim.** On Windows the process is the `cmd` shim (npm's `cursor-agent.cmd`), so the kill ends
  `cmd`, not Cursor behind it. Cursor is cut off before it writes the conversation.
- **The same in our check.** The sessions from our own live check also had `store.db-wal` files left over, the mark
  of an unclean end.

A probe shows `cursor-agent acp` exits by itself, in about 70 ms, when its input closes.

**Fix** (`stdio-rpc.ts`, shared with Codex):

- **Closing.** `close()` now closes the process's input and lets it exit.
- **Killing.** Only if it hasn't exited after a grace period (3 s) is it killed, and then as a whole process tree.
  On Windows that's `taskkill /pid <pid> /T /F`, so a shim's child goes too; elsewhere it's `SIGKILL`.

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
| A Cursor bot answers later messages in its session | live check: three messages in one session, `store.db` saved |
| CLIs end by closing input; killed (tree) only if late | `stdio-rpc.test.ts`: a child that exits on EOF isn't killed; one that ignores EOF is killed after the grace |
| Lists open at once after the first load; Refresh is fresh | `model-lists.test.ts`: cached within the TTL, shared in flight, failures not kept, `cached: false` refetches, `forget` clears; `http` test of `cached` |
