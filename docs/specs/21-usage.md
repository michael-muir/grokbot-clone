# #21 Token and cost usage, and the Usage settings page

Issue: #21 · Milestone: Phase 3 · Bots, cards and polish · Requirements: PR-5 · Stories: US-5

## Goal

Every run records the tokens it used and, where the provider reports one, what it cost. A Usage page in Settings
shows the totals per day and per bot.

## Scope

- **In:**
  - A `usage` provider event.
  - Tokens on run entries (next to the existing `costUsd`).
  - Usage from the built-in loop (OpenAI-compatible, Gemini, Ollama… report tokens) and from Claude (tokens and
    cost).
  - `GET /usage?days=N`.
  - A Usage page in Settings: totals, a bar per day, and a list by bot.
- **Out:**
  - **Prices for providers that don't report a cost.** Turning tokens into money needs a price table per model,
    which goes stale. Tokens are shown for every provider; cost only where the provider says what it was (Claude
    today).
  - **The reference's plan, limits and credits:** those are its own billing. We have none.
  - **Per-run cost in the chat.**

## Reference

`23-settings-Usage.png`: "Usage & Billing", with a usage total for the week, a chart by day, and a "By source / By
Bot" switch. Ours keeps that shape (a total, days, bots) with our own numbers and words. "Usage" goes in the
Settings nav with a bar-chart icon.

## Design

**Provider event:** `{ type: "usage"; inputTokens?: number; outputTokens?: number; costUsd?: number }`.

- A run may emit several, one per model turn, and the gateway adds them up.
- Cost from `RunOutcome.costUsd` still counts when no event carries one, so existing providers keep working.
- **Built-in loop:** each model turn's `done` usage becomes an event.
- **Claude:** its numbers are not per run, so they're taken apart. The SDK documents that `total_cost_usd` (and
  `modelUsage`) are the running total of the session: a resumed or forked session continues from the total its
  transcript saved.
  - **Tokens:** the sum of each API call's own `usage` on the assistant messages of the main loop, once per message
    id (a message can arrive in parts). Cache reads and writes count as input.
  - **Cost:** the run's share, `total_cost_usd` minus the session's total before this run. That earlier total is
    kept on run entries as `sessionCost`, and the gateway hands it in as `RunRequest.costBase`: the last run on
    that session, or, for a fork, the run at the fork point.
  - **No known base:** a resumed session without one (runs from before this change) gets no cost rather than a
    wrong one. A new session's base is 0.
  - **The existing bug:** `costUsd` used to be that running total, which overstated every resumed Claude run. This
    fixes it.
- **Fake:** reports a small fixed usage, so tests and manual checks have numbers.

**Run entry:** `usage?: { inputTokens: number; outputTokens: number }` next to `costUsd` (now the run's own cost),
plus `sessionCost?: { sessionId, usd }` (the provider's running total for the session, with the session it belongs to,
so the next run on it can work out its share whether or not this run reached a checkpoint).

- It's written when the run ends, whatever the outcome. An interrupted run still used what it used.
- It's left out when the run reported nothing.

**Aggregation** (`server/src/usage.ts`, pure): `summarizeUsage(runs, { days, now })`.

- Takes the run entries of every bot (deleted bots' transcripts are gone, and so is their usage), and returns:

  ```ts
  { days: { date: "2026-11-27", inputTokens, outputTokens, costUsd, runs }[],   // every day in range, oldest first
    bots: { botId, inputTokens, outputTokens, costUsd, runs }[],                  // biggest first
    total: { inputTokens, outputTokens, costUsd, runs }, from, to }
  ```

- Days are local dates on the gateway's machine, the same machine as the app.
- Hidden (rolled-back) runs still count, since their tokens were spent.
- `costUsd` sums only the costs that were reported.

**HTTP:** `GET /usage?days=7|30|90` (default 7) returns the summary plus bot names.

**App:** `Settings → Usage`.

- **Period:** a 7 / 30 / 90-day switch (a segmented control, keyboard-operable as a radio group).
- **Total:** a card with the period's total tokens (in and out) and the reported cost, if any.
- **By day:** a bar per day, its height the share of the busiest day. Each bar has a label with its tokens, for
  hover and screen readers.
- **By bot:** each bot's avatar, name, tokens and cost.
- **Note:** "Cost is shown where the provider reports it (Claude). Other providers report tokens only."
- **States:** empty ("No usage yet in this period.") and failed (a retry banner).
- **Tokens:** one new token, `--size-usage-chart` (120px, the chart's height), since no existing size fits a
  chart. Everything else uses existing tokens.

## Interfaces

```ts
ProviderEvent | { type: "usage"; inputTokens?: number; outputTokens?: number; costUsd?: number; sessionCostUsd?: number }
RunRequest.costBase?: number      // the session's reported cost total before this run
EntryBody run: { …; usage?: { inputTokens: number; outputTokens: number } }
summarizeUsage(runs: TranscriptEntry[], opts: { days: number; now: Date }): UsageSummary
GET /usage?days=N -> UsageSummary & { botNames: Record<string, string> }
GatewayClient.usage(days); IPC "usage"
SettingsPage | "usage"
```

## Test plan

| Task | Shown by |
| --- | --- |
| Optional usage fields on provider events | `usage: the loop reports each model turn's tokens`; `claude: the result's usage and cost become usage events` (cache counted as input) |
| Tokens and cost on run entries | `usage: a run adds up its usage events, keeps the provider's cost, and records them even when stopped`; `usage: a run that reports nothing has no usage` |
| Usage page with totals per bot and per day | `usage: summarize puts runs on their local day, fills empty days, ranks bots, and sums only reported cost`; `http: /usage answers the summary for 7, 30 or 90 days and refuses others`; `settings: usage formatting` (numbers, bar heights); manual check |

**Manual check, 2026-11-27.** On the fake provider, in an isolated profile on port 9411:

- **Data:** three messages to Nova and one to Pip.
- **Total:** Settings → Usage showed 505 tokens (425 in, 80 out), 4 replies, and $0.00, since the fake reports a
  zero cost.
- **By day:** the busiest bar was today, with flat bars for the other six days (Nov 21 to Nov 27).
- **By bot:** Nova (376 tokens) above Pip (129), each with its avatar.
- **Keyboard:** from the checked "7 days" radio, the right arrow chose 30 days, the chart redrew with 30 bars, and
  the focus ring showed on the segment.
- **Implementation note:** the period switch uses native radio buttons. Lint asked for them, and they bring the
  arrow keys with them.

## Risks and open questions

- **Old runs:** runs from before this change have no token counts and show as runs with zero tokens.
- **Deleted bots:** a deleted bot's usage disappears with its transcript. A separate usage ledger would keep it;
  that can come with billing, if the product ever has any.
