// The bot sidebar: the working button, the main bot, a divider, the other bots, and the connection status.
import type { KeyboardEvent } from "react";
import type { BotActivity, PublicBot } from "../../../../../server/src/types.ts";
import { botColor, initial } from "../bot-colors.ts";
import { type Badge, badgeFor, tileLabel, workingButton } from "./sidebar-state.ts";

export function Sidebar({
  bots,
  selected,
  activity,
  unread,
  connection,
  onSelect,
}: {
  bots: readonly PublicBot[];
  selected: string | undefined;
  activity: readonly BotActivity[];
  unread: ReadonlySet<string>;
  connection: { state: "pending" | "ok" | "failed"; text: string };
  onSelect(botId: string): void;
}) {
  const running = new Set(activity.filter((a) => a.running).map((a) => a.botId));
  const working = workingButton(bots, activity, selected);
  const [main, ...others] = bots;

  const tile = (bot: PublicBot, isMain: boolean) => {
    const badge = badgeFor({ running: running.has(bot.id), unread: unread.has(bot.id), main: isMain });
    return (
      <li key={bot.id}>
        <BotTile bot={bot} badge={badge} current={bot.id === selected} onSelect={onSelect} />
      </li>
    );
  };

  return (
    <nav className="sidebar" aria-label="Bots">
      <div className="sidebar-top">
        {working && (
          <button
            type="button"
            className="working-button"
            aria-label={working.label}
            title={working.label}
            onClick={() => onSelect(working.target)}
          >
            <span className="working-spinner" aria-hidden="true" />
          </button>
        )}
      </div>
      {/* One list for arrow-key movement; the divider is decoration between the main bot and the rest. */}
      <ul className="bot-list" onKeyDown={moveFocus}>
        {main && tile(main, true)}
        {others.length > 0 && <li className="bot-divider" aria-hidden="true" />}
        {others.map((bot) => tile(bot, false))}
      </ul>
      {/* A live region announces its text content, so the words are in it (hidden), not in aria-label. */}
      <span className="connection-dot" role="status" title={connection.text} data-state={connection.state}>
        <span className="visually-hidden">{connection.text}</span>
      </span>
    </nav>
  );
}

function BotTile({
  bot,
  badge,
  current,
  onSelect,
}: {
  bot: PublicBot;
  badge: Badge;
  current: boolean;
  onSelect(botId: string): void;
}) {
  return (
    <button
      type="button"
      className="bot-tile"
      aria-current={current ? "page" : undefined}
      aria-label={tileLabel(bot.name, badge)}
      title={bot.name}
      data-bot-color={botColor(bot.avatar.color)}
      onClick={() => onSelect(bot.id)}
    >
      <span className="avatar" aria-hidden="true">
        {initial(bot.name)}
      </span>
      {badge && <span className="tile-badge" data-badge={badge} aria-hidden="true" />}
    </button>
  );
}

/** Up/Down move between bot tiles, Home/End jump to the ends. */
function moveFocus(e: KeyboardEvent<HTMLUListElement>) {
  const keys = ["ArrowUp", "ArrowDown", "Home", "End"];
  if (!keys.includes(e.key)) return;
  const tiles = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(".bot-tile")];
  const at = tiles.indexOf(document.activeElement as HTMLButtonElement);
  if (at < 0) return;
  e.preventDefault();
  const next =
    e.key === "Home"
      ? 0
      : e.key === "End"
        ? tiles.length - 1
        : Math.min(tiles.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)));
  tiles[next]?.focus();
}
