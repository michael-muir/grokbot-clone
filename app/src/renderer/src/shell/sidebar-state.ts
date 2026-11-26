// The sidebar's decisions as pure functions: each tile's badge, which bots have a new reply, the working button's
// label and target, and how a typed bot name is cleaned.
import type { BotActivity, PublicBot } from "../../../../../server/src/types.ts";

/** The corner badge on a tile. At most one shows: working beats a new reply, which beats the main-bot star. */
export type Badge = "working" | "unread" | "main" | null;

export function badgeFor(s: { running: boolean; unread: boolean; main: boolean }): Badge {
  if (s.running) return "working";
  if (s.unread) return "unread";
  return s.main ? "main" : null;
}

/** The tile's accessible name: the bot, then what it's doing. */
export function tileLabel(name: string, badge: Badge): string {
  if (badge === "working") return `${name}, working`;
  if (badge === "unread") return `${name}, new reply`;
  return name;
}

/**
 * Bots with a reply the user hasn't opened yet: a run that ended on a bot that isn't the open chat.
 * Opening a chat clears it.
 */
export function nextUnread(
  unread: ReadonlySet<string>,
  before: readonly BotActivity[],
  after: readonly BotActivity[],
  selected: string | undefined,
): Set<string> {
  const wasRunning = new Set(before.filter((b) => b.running).map((b) => b.botId));
  const next = new Set(unread);
  for (const bot of after) {
    if (wasRunning.has(bot.botId) && !bot.running && bot.botId !== selected) next.add(bot.botId);
  }
  if (selected) next.delete(selected);
  // Forget bots that no longer exist.
  const known = new Set(after.map((b) => b.botId));
  for (const id of next) if (!known.has(id)) next.delete(id);
  return next;
}

/** The working button: what it says, and which bot it opens (a working bot other than the open one, if any). */
export function workingButton(
  bots: readonly PublicBot[],
  activity: readonly BotActivity[],
  selected: string | undefined,
): { label: string; target: string } | undefined {
  const runningIds = new Set(activity.filter((a) => a.running).map((a) => a.botId));
  const working = bots.filter((b) => runningIds.has(b.id));
  const first = working[0];
  if (!first) return undefined;
  const target = working.find((b) => b.id !== selected) ?? first;
  const label = working.length === 1 ? `${first.name} is working` : `${working.length} bots are working`;
  return { label, target: target.id };
}

export const MAX_NAME = 40;

/** A typed bot name, trimmed and capped; undefined when nothing usable is left. */
export function cleanName(typed: string): string | undefined {
  const name = Array.from(typed.trim().replace(/\s+/g, " ")).slice(0, MAX_NAME).join("").trim();
  return name === "" ? undefined : name;
}
