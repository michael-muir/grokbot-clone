// The bot sidebar: the working button, the main and pinned bots, a divider, the other bots, each bot's menu, and
// the connection status.
import { type KeyboardEvent, type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import type { BotActivity, PublicBot } from "../../../../../server/src/types.ts";
import { botColor } from "../bot-colors.ts";
import { Avatar } from "./Avatar.tsx";
import { BotMenu } from "./BotMenu.tsx";
import {
  type Badge,
  badgeFor,
  type MenuAction,
  menuFor,
  sidebarLayout,
  tileLabel,
  workingButton,
} from "./sidebar-state.ts";

/** Menu actions that open a confirmation instead of acting at once. */
const OPENS_DIALOG: ReadonlySet<MenuAction> = new Set(["delete", "start-fresh"]);

export function Sidebar({
  bots,
  selected,
  activity,
  unread,
  connection,
  onSelect,
  onOpenSettings,
  onNewBot,
  onMenuAction,
  refocus,
  onRefocus,
}: {
  bots: readonly PublicBot[];
  selected: string | undefined;
  activity: readonly BotActivity[];
  unread: ReadonlySet<string>;
  connection: { state: "pending" | "ok" | "failed"; text: string };
  onSelect(botId: string): void;
  onOpenSettings(): void;
  /** Opens Create New Bot. */
  onNewBot(): void;
  /** Resolves once the change is shown, so focus can go back to the (possibly moved) tile. */
  onMenuAction(bot: PublicBot, action: MenuAction): Promise<void>;
  /**
   * A tile to focus once the latest change is on screen (undefined: none). Held by the app, which also asks for it
   * after the delete dialog. The effect below runs after React commits: a pinned tile has moved by then (moving it
   * took its focus away), and a hidden or deleted one is gone, in which case the main bot's tile takes focus.
   */
  refocus: { botId: string } | undefined;
  onRefocus(request: { botId: string } | undefined): void;
}) {
  const running = new Set(activity.filter((a) => a.running).map((a) => a.botId));
  const working = workingButton(bots, activity, selected);
  const [showHidden, setShowHidden] = useState(false);
  const { top, rest, hiddenCount } = sidebarLayout(bots, showHidden);
  const mainId = bots[0]?.id;
  const [menu, setMenu] = useState<{ botId: string; x: number; y: number }>();
  const menuBot = menu ? bots.find((b) => b.id === menu.botId) : undefined;
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!refocus) return;
    const find = (id: string | undefined) =>
      id ? list.current?.querySelector<HTMLButtonElement>(`[data-bot-id="${CSS.escape(id)}"]`) : null;
    (find(refocus.botId) ?? find(mainId))?.focus();
    onRefocus(undefined);
  }, [refocus, mainId, onRefocus]);
  const focusTile = useCallback((botId: string) => onRefocus({ botId }), [onRefocus]);

  // Nothing left to show: back to normal, so a bot hidden later disappears as the user expects.
  useEffect(() => {
    if (hiddenCount === 0) setShowHidden(false);
  }, [hiddenCount]);

  const openBotId = menu?.botId;
  const closeMenu = useCallback(
    (restoreFocus: boolean) => {
      setMenu(undefined);
      if (restoreFocus && openBotId) focusTile(openBotId);
    },
    [focusTile, openBotId],
  );

  /** Opens beside the tile, overlapping it, as in the reference. */
  const openMenu = (botId: string, tileEl: HTMLElement) => {
    const r = tileEl.getBoundingClientRect();
    setMenu({ botId, x: r.left + r.width * 0.4, y: r.top + r.height * 0.28 });
  };

  const tile = (bot: PublicBot) => {
    const badge = badgeFor({ running: running.has(bot.id), unread: unread.has(bot.id), main: bot.id === mainId });
    return (
      <li key={bot.id}>
        <BotTile
          bot={bot}
          badge={badge}
          current={bot.id === selected}
          menuOpen={menu?.botId === bot.id}
          onSelect={onSelect}
          onMenu={openMenu}
        />
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
      <ul ref={list} className="bot-list" onKeyDown={moveFocus}>
        {top.map(tile)}
        {rest.length > 0 && <li className="bot-divider" aria-hidden="true" />}
        {rest.map(tile)}
      </ul>
      {menu && menuBot && (
        <BotMenu
          label={menuBot.name}
          items={menuFor(menuBot, menuBot.id === mainId)}
          at={menu}
          onClose={closeMenu}
          onAction={(action) => {
            setMenu(undefined);
            // Delete and Start fresh open a dialog, which takes focus and gives it back itself.
            void onMenuAction(menuBot, action).then(() => {
              if (!OPENS_DIALOG.has(action)) focusTile(menuBot.id);
            });
          }}
        />
      )}
      <div className="sidebar-bottom">
        <button type="button" className="sidebar-icon-button" aria-label="New bot" title="New bot" onClick={onNewBot}>
          <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
        {hiddenCount > 0 && (
          <button
            type="button"
            className="sidebar-icon-button"
            aria-pressed={showHidden}
            aria-label={showHidden ? "Leave hidden bots out" : `Show hidden bots (${hiddenCount})`}
            title={showHidden ? "Leave hidden bots out" : `Show hidden bots (${hiddenCount})`}
            onClick={() => setShowHidden((v) => !v)}
          >
            <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d={
                  showHidden
                    ? "M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4zM8 6.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z"
                    : "M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4zM8 6.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3zM2.5 2.5l11 11"
                }
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
        <button
          type="button"
          className="sidebar-icon-button"
          aria-label="Settings"
          title="Settings"
          onClick={onOpenSettings}
        >
          <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
        </button>
        {/* A live region announces its text content, so the words are in it (hidden), not in aria-label. */}
        <span className="connection-dot" role="status" title={connection.text} data-state={connection.state}>
          <span className="visually-hidden">{connection.text}</span>
        </span>
      </div>
    </nav>
  );
}

function BotTile({
  bot,
  badge,
  current,
  menuOpen,
  onSelect,
  onMenu,
}: {
  bot: PublicBot;
  badge: Badge;
  current: boolean;
  menuOpen: boolean;
  onSelect(botId: string): void;
  onMenu(botId: string, tile: HTMLElement): void;
}) {
  return (
    <button
      type="button"
      className="bot-tile"
      data-bot-id={bot.id}
      data-hidden={bot.hidden || undefined}
      aria-current={current ? "page" : undefined}
      aria-label={tileLabel(bot.name, badge)}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      title={bot.name}
      data-bot-color={botColor(bot.avatar.color)}
      onClick={() => onSelect(bot.id)}
      onContextMenu={(e: MouseEvent<HTMLButtonElement>) => {
        e.preventDefault();
        onMenu(bot.id, e.currentTarget);
      }}
      onKeyDown={(e) => {
        // The keyboard's own ways to open a context menu.
        if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
          e.preventDefault();
          onMenu(bot.id, e.currentTarget);
        }
      }}
    >
      <Avatar avatar={bot.avatar} botId={bot.id} />
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
