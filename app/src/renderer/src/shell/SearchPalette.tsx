// The search palette (reference/screens/26-search.png): bots by name with their latest message, messages across all
// bots from the gateway, and the app's actions. Arrow keys move, Enter opens, Escape closes.
import { type KeyboardEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import type { SearchHit, SearchResult } from "../../../../../server/src/search.ts";
import type { PublicBot } from "../../../../../server/src/types.ts";
import { call } from "../gateway.ts";
import { Avatar } from "./Avatar.tsx";
import { filterPalette, type PaletteAction, paletteActions } from "./shortcuts.ts";

export type PaletteChoice =
  | { kind: "bot"; botId: string }
  | { kind: "message"; hit: SearchHit }
  | { kind: "action"; id: PaletteAction["id"] };

/** How long typing must pause before messages are searched. */
const SEARCH_DELAY_MS = 150;

interface Option {
  key: string;
  section: "Bots" | "Messages" | "Actions";
  choice: PaletteChoice;
  title: string;
  detail?: string;
  icon: ReactNode;
}

export function SearchPalette({
  bots,
  currentBotName,
  onChoose,
  onClose,
}: {
  /** In sidebar order. */
  bots: readonly PublicBot[];
  currentBotName?: string;
  onChoose(choice: PaletteChoice): void;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult>();
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const latest = useRef(0);

  useEffect(() => {
    const opener = document.activeElement;
    input.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  // Previews at once, messages after a pause in typing; only the latest answer lands.
  useEffect(() => {
    const n = ++latest.current;
    const timer = setTimeout(
      () => {
        call("search", query.trim()).then(
          (r) => {
            if (n === latest.current) setResult(r);
          },
          (err: unknown) => console.warn("Search failed:", err),
        );
      },
      query.trim() ? SEARCH_DELAY_MS : 0,
    );
    return () => clearTimeout(timer);
  }, [query]);

  const options = useMemo<Option[]>(() => {
    const preview = (botId: string) => result?.previews.find((p) => p.botId === botId)?.text;
    const botOptions = filterPalette(bots, query, (b) => b.name).map(
      (b): Option => ({
        key: `bot:${b.id}`,
        section: "Bots",
        choice: { kind: "bot", botId: b.id },
        title: b.name,
        detail: preview(b.id),
        icon: <Avatar avatar={b.avatar} size="small" />,
      }),
    );
    const messageOptions =
      query.trim().length >= 2
        ? (result?.messages ?? []).flatMap((hit): Option[] => {
            const bot = bots.find((b) => b.id === hit.botId);
            if (!bot) return [];
            return [
              {
                key: `msg:${hit.entryId}`,
                section: "Messages",
                choice: { kind: "message", hit },
                title: hit.threadId ? `${bot.name} · in a thread` : bot.name,
                detail: hit.snippet,
                icon: <Avatar avatar={bot.avatar} size="small" />,
              },
            ];
          })
        : [];
    const actionOptions = filterPalette(
      paletteActions(currentBotName),
      query,
      (a) => `${a.label} ${a.detail ?? ""}`,
    ).map(
      (a): Option => ({
        key: `action:${a.id}`,
        section: "Actions",
        choice: { kind: "action", id: a.id },
        title: a.label,
        detail: a.detail,
        icon: <ActionIcon id={a.id} />,
      }),
    );
    return [...botOptions, ...messageOptions, ...actionOptions];
  }, [bots, query, result, currentBotName]);

  // A new list starts at its first option.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the query is the trigger.
  useEffect(() => setActive(0), [query]);
  const current = Math.min(active, options.length - 1);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (options.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((current + step + options.length) % options.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const option = options[current];
      if (option) onChoose(option.choice);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const optionId = (i: number) => `${id}-option-${i}`;
  return (
    <div
      className="dialog-scrim palette-scrim"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search">
        <div className="palette-field">
          <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M7 12A5 5 0 107 2a5 5 0 000 10zM10.5 10.5L14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
          <input
            ref={input}
            className="palette-input"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={options[current] ? optionId(current) : undefined}
            aria-autocomplete="list"
            placeholder="Search bots, chats, settings…"
            value={query}
            maxLength={200}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div ref={list} id={`${id}-list`} className="palette-list" role="listbox" aria-label="Results">
          {options.length === 0 && <p className="palette-empty">Nothing found.</p>}
          {options.map((o, i) => (
            <div key={o.key} role="presentation">
              {(i === 0 || options[i - 1]?.section !== o.section) && (
                <p className="palette-section" role="presentation">
                  {o.section}
                </p>
              )}
              <div
                id={optionId(i)}
                data-index={i}
                role="option"
                aria-selected={i === current}
                className="palette-option"
                tabIndex={-1}
                onPointerMove={() => setActive(i)}
                onClick={() => onChoose(o.choice)}
                onKeyDown={() => {}}
              >
                <span className="palette-icon">{o.icon}</span>
                <span className="palette-text">
                  <span className="palette-title">{o.title}</span>
                  {o.detail && <span className="palette-detail">{o.detail}</span>}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ActionIcon({ id }: { id: PaletteAction["id"] }) {
  const paths: Record<PaletteAction["id"], string> = {
    "new-bot": "M8 3.5v9M3.5 8h9",
    shortcuts: "M2.5 4.5h11v7h-11zM5 7h1M7.5 7h1M10 7h1M5.5 9.5h5",
    settings: "M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5",
    models: "M10 2.5a3.5 3.5 0 00-3.3 4.6L2.5 11.3v2.2h2.2v-1.4h1.4v-1.4h1.4l1.3-1.3A3.5 3.5 0 1010 2.5z",
    usage: "M3 13.5V9M6.3 13.5V5M9.7 13.5V7.5M13 13.5V2.5",
    "start-fresh": "M13 8a5 5 0 11-1.5-3.6M13 2.5v2.5h-2.5",
  };
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d={paths[id]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
