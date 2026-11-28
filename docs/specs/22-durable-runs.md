# #22 Durable runs across backend restarts

Issue: #22 · Milestone: Phase 3 · Bots, cards and polish · Requirements: AG-3 · Stories: US-9

## Goal

A run cut off because the gateway stopped (a crash, a killed process, quitting the app) never stays stuck as
running. It ends cleanly, says the app stopped mid-reply, and offers **Resume**, which lets the bot pick up from the
last point its session was saved.

## Decision

The owner chose **the transcript plus a Resume button** (2026-11-27), over a SQLite job table or Temporal:

- **No new storage or dependency.** The transcript is already the durable record of every run. Since #17 and #21,
  each run entry keeps its state, its session checkpoint (written as it goes) and its usage.
- **Resuming is the user's call.** Bots run commands and change files, so an automatic re-run after a crash could
  repeat an action that was halfway done. A button keeps the person in control.
- **Temporal** would need a server beside the desktop app. That's worth revisiting with the cloud computers of
  Phase 4.

## Scope

- **In:**
  - Marking runs the app cut off: on startup after a crash, and on a clean shutdown.
  - A notice and a Resume button on such a run.
  - `POST /bots/:id/runs/:runId/resume`.
  - A resumed run continues the same conversation (main or thread) and the same session.
- **Out:**
  - **Resuming automatically.**
  - **Resuming a run stopped by the user (Stop):** they meant to stop it.
  - **Replaying a half-finished tool call exactly.** The bot is told to check what was already done.

## Design

**Persisted run state:** already the transcript (JSONL, append-only, last write per entry wins).

- A run entry is written when the run starts, its checkpoint is updated as the session is saved, and its end state
  is written when it ends.
- Nothing new needs storing, except why it ended.

**`cutOff` on run entries:** `EntryBody` run gains `cutOff?: true`, meaning the app stopped the run, not the user.

- **On startup:** `closeLeftovers` turns a run still `running` into `interrupted` with `cutOff: true`. This is the
  crash case. As before, cards expire, streaming text is finalized, and running steps fail.
- **On a clean shutdown:** `Gateway.shutdown` marks the runs it stops the same way.
- **Stop:** a user's Stop leaves `cutOff` unset.

**`resumeRun(botId, runId)`:**

- The run must be `cutOff`, not yet resumed, and the latest run of its conversation (main or thread). The bot must
  be idle.
- It marks the old run `resumed: true`.
- It starts a new run in the same conversation (same `threadId`) on the conversation's current session. There's no
  new user message. The prompt is: "Your last reply was cut off when the app stopped. Continue where you left off.
  Before redoing any step, check whether it was already done (files written, commands run)."
- The new run entry carries `resumes: <runId>`. The provider resumes the session as saved:
  - the built-in loop saves after each step;
  - Claude Code saves its session as it goes.

  So the bot has everything up to the cut, and the gateway's checkpoint and session bookkeeping work as for any
  run.
- **Errors:**
  - a run that can't be resumed (wrong state, not the latest, unknown) gives `BotRuleError` (400);
  - a busy bot gives `BotBusyError` (409).

**HTTP:** `POST /bots/:id/runs/:runId/resume` returns 202, or 400 or 409.

**App:**

- A cut-off run shows "The app stopped mid-reply" (instead of "Stopped"). While it's the latest run of the view and
  not resumed, the notice also has a **Resume** button.
- A resumed one shows "The app stopped mid-reply · Resumed", without the button.
- The button sends `resumeRun`, and errors show in the chat banner.

## Interfaces

```ts
EntryBody run: { …; cutOff?: true; resumed?: true; resumes?: string }
Gateway.resumeRun(botId, runId, cardKinds?): { done: Promise<void> }   // synchronous; throws BotRuleError / BotBusyError
POST /bots/:id/runs/:runId/resume {cardKinds?} -> 202
GatewayClient.resumeRun(botId, runId, cardKinds?); IPC "resumeRun" [botId, runId, cardKinds?]
isLatestCutOff(entries, cut): boolean    // server/src/runs.ts, shared by the gateway and the app's rows
Row (entry) gains resumable?: true
```

## Test plan

| Task / criterion | Shown by |
| --- | --- |
| Decide | This spec (owner's decision recorded above) |
| Persist run state | Existing transcript persistence; `durable: a run cut off by a crash is closed on startup, marked cutOff, with its checkpoint and usage kept` |
| On startup, resume or fail runs left running | The same test (never left running); `durable: resume continues the same conversation and session, with what the bot remembers`; `durable: a clean shutdown marks the runs it stops as cut off; a user's Stop doesn't` |
| Never stuck as running | `durable: …closed on startup…`; `durable: only the latest cut-off run of a conversation can be resumed, once, while the bot is idle` |

Other tests:

- `http: resume answers 202, 400 or 409`.
- `rows: a cut-off run shows the app stopped mid-reply, with Resume while it's the latest run`.

**Manual check, 2026-11-28.** In the app, on the fake provider, in an isolated profile on port 9411:

1. **Crash:** I sent `/slow` and killed only the gateway process (`node src\main.ts`, the app's child) 300 ms
   later. The transcript's last run line read `"state":"running"` with its checkpoint, which is what a crash leaves.
2. **Restart:** after restarting the app, the half reply ("Nova here. You") was final, and the run showed "The app
   stopped mid-reply" with a Resume button.
3. **Resume:** pressing it started a new reply in the same chat, the resume prompt, as the fake echoes. The notice
   became "The app stopped mid-reply · Resumed", without the button.

## Risks and open questions

- **Repeated steps.** A step that ran just before the crash, but wasn't saved in the session, may run again. The
  resume prompt asks the bot to check first, and approvals still apply to anything that acts outside the
  workspace.
- **Claude's last moments.** If Claude Code didn't save the last moments of its session, those are lost to the bot.
  The transcript still shows them to the user.

**Code review:** it found eight issues, all fixed. The changes are tested in `durable.test.ts` and `rows.test.ts`,
except the Resume button's one click.

- **After a fresh start:** a cut run can't be resumed once the conversation has a fresh start after it. The gateway
  and the rows share the rule (`isLatestCutOff`, in a pure module the renderer can import).
- **Threads:** a thread whose first run was cut off forks from its root (`threadStart`), as a first message does.
- **Nothing saved:** a run cut off before its session saved anything, or now on another provider, gets the original
  message (and in a thread, the root's quote) in its resume prompt.
- **Failed resumes:** a cut run counts as resumed only when the resume run didn't fail. A failed attempt is skipped
  when picking the latest run, so Resume shows again.
- **Stop, then quit:** a user's Stop is remembered on the run (`stoppedByUser`), so quitting right after it can't
  mark it cut off.
- **Quitting:** no new runs start once shutdown has begun. This one was there before #22.
- **Resume button:** it disables itself after a click.
- **Spec:** the interfaces above now match the code.
