// The Usage page's numbers as text and shares, as pure functions so they're tested without rendering.

/** "950", "12.3K", "4.5M": tokens, short enough for a card. */
export function formatTokens(n: number): string {
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${trim(n / 1_000)}K`;
  return `${trim(n / 1_000_000)}M`;
}

const trim = (n: number) => (n >= 100 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, ""));

/** "$0.42", "$12.50"; under a cent, "<$0.01"; exactly nothing, "$0.00". */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** Each day's share of the busiest day, 0 to 100; all 0 when nothing happened. */
export function barShares(days: readonly { inputTokens: number; outputTokens: number }[]): number[] {
  const totals = days.map((d) => d.inputTokens + d.outputTokens);
  const most = Math.max(0, ...totals);
  return totals.map((t) => (most === 0 ? 0 : Math.round((t / most) * 100)));
}

/** "Nov 27" from "2026-11-27", read as a local date. */
export function dayLabel(date: string, locale?: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).toLocaleDateString(locale, { month: "short", day: "numeric" });
}
