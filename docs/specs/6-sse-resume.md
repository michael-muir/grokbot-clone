# #6 Harden SSE resume: no gaps or duplicates

Issue: #6 · Milestone: Phase 1 · Requirements: TR-1, TR-2 · Stories: US-7, US-9

## Goal

A client that loses its connection, at any moment, gets back exactly the entries it missed, then live updates.
After any number of reconnects, its view of the transcript is the same as if it had never disconnected.

## Scope

- In: the server's event stream; a small client library (resuming subscription and transcript view) that the
  desktop app (#10) will use; tests that drop connections mid-stream and during an approval.
- Out: the UI itself (#10); durable runs across a backend restart (#22).

## Design

### The bug this fixes

The backlog is currently sent sorted by `seq` (conversation order), but a client resumes from the highest
`updatedSeq` it has seen. If the connection drops part-way through a backlog, entries with a lower `updatedSeq`
that hadn't been sent yet are skipped forever. Example: entry A (`seq` 1, `updatedSeq` 10) is sent, entry B
(`seq` 2, `updatedSeq` 5) isn't; the client resumes from 10 and never gets B.

### Server

- The backlog and the live stream are both in `updatedSeq` order, so "everything after my cursor" is always a
  correct resume point. The `GET /transcript` route keeps returning conversation order for simple reads.
- Each event carries `id: <updatedSeq>`, and the server honors the `Last-Event-ID` header as `since`, so a plain
  browser `EventSource` resumes by itself. `since` in the URL wins when both are given.
- `retry: 2000` tells `EventSource` how soon to reconnect.
- The backlog and the subscription are set up in the same tick, so nothing committed in between is lost.
- The heartbeat (a comment every 15 s) stays, and its interval becomes configurable for tests.

### Client library (`server/src/client/`)

- `TranscriptView`: applies entries by id, ignores an update whose `updatedSeq` isn't newer than the one it
  holds, keeps the highest `updatedSeq` as the cursor, and lists entries in `seq` order.
- `subscribeTranscript(baseUrl, botId, { onEntry, onState, signal, token })`: reads the event stream with
  `fetch`. It reconnects with exponential backoff (0.5 s doubling to 10 s, reset after a successful connect) and
  resumes from the cursor. If no data or heartbeat arrives within 45 s it treats the connection as dead and
  reconnects. It reports `connecting`, `live` and `reconnecting` states for the UI, and stops when the signal
  aborts.

## Interfaces

```ts
class TranscriptView { apply(e: TranscriptEntry): boolean; get cursor(): number; entries(): TranscriptEntry[] }
function subscribeTranscript(baseUrl: string, botId: string, opts: {
  onEntry(e: TranscriptEntry): void; onState?(s: "connecting" | "live" | "reconnecting"): void;
  signal: AbortSignal; token?: string; since?: number;
  backoff?: { initialMs: number; maxMs: number }; staleAfterMs?: number }): Promise<void>
```

## Test plan

| Acceptance criterion | Shown by |
| --- | --- |
| Reconnect mid-stream shows every entry once, in order | A run streams a long reply while the server drops every connection several times; the client's view ends identical to the server's transcript, with no duplicate entry ids, in `seq` order |

Also: a drop while an approval is pending, then the approval answered over HTTP, ends with the card approved
and the run finished in the client's view; a drop part-way through a backlog whose `seq` and `updatedSeq` orders
differ (the bug above) loses nothing; `Last-Event-ID` resumes; stale updates are ignored by the view; a silent
connection is detected and replaced; backoff grows and resets.

## Risks and open questions

- None known. The client library is plain TypeScript with no Node-only APIs, so the Electron renderer can use it.
