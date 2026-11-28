// The sidebar's decisions as pure functions: which bots show where, each bot's menu, each tile's badge, which bots
// have a new reply, the working button's label and target, and how a typed bot name is cleaned.
import { type BotActivity, MAX_BOT_NAME, type PublicBot } from "../../../../../server/src/types.ts";

/**
 * Above the divider: the main bot (always first, always shown), then pinned bots. Below: the rest. Hidden bots
 * show only when asked, in their usual place.
 */
export function sidebarLayout(
  bots: readonly PublicBot[],
  showHidden: boolean,
): { top: PublicBot[]; rest: PublicBot[]; hiddenCount: number } {
  const [main, ...others] = bots;
  const visible = others.filter((b) => showHidden || !b.hidden);
  return {
    top: [...(main ? [main] : []), ...visible.filter((b) => b.pinned)],
    rest: visible.filter((b) => !b.pinned),
    hiddenCount: others.filter((b) => b.hidden).length,
  };
}

export type MenuAction = "make-main" | "pin" | "unpin" | "start-fresh" | "copy-id" | "hide" | "show" | "delete";

/**
 * A bot's menu, in the reference's order, after "Make main bot". The main bot is always on top and can't be hidden
 * or deleted.
 */
export function menuFor(bot: PublicBot, isMain: boolean): { action: MenuAction; label: string }[] {
  if (isMain) {
    return [
      { action: "start-fresh", label: "Start fresh" },
      { action: "copy-id", label: "Copy bot ID" },
    ];
  }
  return [
    { action: "make-main", label: "Make main bot" },
    bot.pinned ? { action: "unpin", label: "Unpin" } : { action: "pin", label: "Pin" },
    { action: "start-fresh", label: "Start fresh" },
    { action: "copy-id", label: "Copy bot ID" },
    bot.hidden ? { action: "show", label: "Show in sidebar" } : { action: "hide", label: "Hide from sidebar" },
    { action: "delete", label: "Delete" },
  ];
}

/** Where the open chat goes when its bot is deleted: the main bot (which can't be deleted itself). */
export const afterDelete = (mainId: string | undefined, deleted: string, selected: string | undefined) =>
  selected === deleted ? mainId : selected;

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

export const MAX_NAME = MAX_BOT_NAME;

/** The gateway's rule, so a bot made here and one made through the API start alike. */
export { freeColor } from "../../../../../server/src/types.ts";

/** A typed bot name, trimmed and capped; undefined when nothing usable is left. */
export function cleanName(typed: string): string | undefined {
  const name = Array.from(typed.trim().replace(/\s+/g, " ")).slice(0, MAX_NAME).join("").trim();
  return name === "" ? undefined : name;
}
