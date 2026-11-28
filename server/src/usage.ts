// Token and cost usage over time (#21): sums the run entries of every bot into totals per day and per bot. Pure, so
// the Usage page's numbers are tested without a gateway.
import type { TranscriptEntry } from "./types.ts";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  /** Only costs a provider reported; runs without one add nothing. */
  costUsd: number;
  /** Runs counted, with or without usage. */
  runs: number;
}

export interface UsageSummary {
  /** First and last day of the range, as local dates (YYYY-MM-DD). */
  from: string;
  to: string;
  /** Every day in the range, oldest first, including days with nothing. */
  days: (UsageTotals & { date: string })[];
  /** Bots with runs in the range, most tokens first. */
  bots: (UsageTotals & { botId: string })[];
  total: UsageTotals;
  /** Whether any run in the range reported a cost (so "$0.00" means free, not unknown). */
  costReported: boolean;
}

export const USAGE_PERIODS = [7, 30, 90] as const;

const zero = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, costUsd: 0, runs: 0 });

/** A local date as YYYY-MM-DD. */
export function localDate(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

/**
 * Totals for the last `days` days up to `now` (today included), from the run entries of every bot. Rolled-back runs
 * count: their tokens were spent all the same.
 */
export function summarizeUsage(entries: readonly TranscriptEntry[], opts: { days: number; now: Date }): UsageSummary {
  const dates: string[] = [];
  for (let i = opts.days - 1; i >= 0; i--) {
    dates.push(localDate(new Date(opts.now.getFullYear(), opts.now.getMonth(), opts.now.getDate() - i)));
  }
  const byDay = new Map(dates.map((d) => [d, zero()]));
  const byBot = new Map<string, UsageTotals>();
  const total = zero();
  let costReported = false;

  for (const e of entries) {
    const b = e.body;
    if (b.kind !== "run" || b.state === "running") continue;
    const day = byDay.get(localDate(new Date(e.createdAt)));
    if (!day) continue;
    const bot = byBot.get(e.botId) ?? zero();
    byBot.set(e.botId, bot);
    for (const t of [day, bot, total]) {
      t.runs++;
      t.inputTokens += b.usage?.inputTokens ?? 0;
      t.outputTokens += b.usage?.outputTokens ?? 0;
      t.costUsd += b.costUsd ?? 0;
    }
    if (b.costUsd !== undefined) costReported = true;
  }

  const tokens = (t: UsageTotals) => t.inputTokens + t.outputTokens;
  return {
    from: dates[0] ?? localDate(opts.now),
    to: dates.at(-1) ?? localDate(opts.now),
    days: dates.map((date) => ({ date, ...(byDay.get(date) ?? zero()) })),
    bots: [...byBot.entries()]
      .map(([botId, t]) => ({ botId, ...t }))
      .sort((a, b) => tokens(b) - tokens(a) || b.runs - a.runs || a.botId.localeCompare(b.botId)),
    total,
    costReported,
  };
}
