// The chat transcript as a virtualized list: only the rows near the viewport are in the DOM, so long chats stay
// smooth. It follows new output while the user is at the bottom, and stops following when they scroll up.
import { useVirtualizer } from "@tanstack/react-virtual";
import { type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TranscriptEntry } from "../../../../../server/src/types.ts";
import { ChatRow, type RowContext } from "./ChatRow.tsx";
import { buildRows, type PendingMessage } from "./rows.ts";

const NO_PENDING: readonly PendingMessage[] = [];

import "./chat.css";

/** Within this many pixels of the end counts as "at the bottom". */
const FOLLOW_SLACK_PX = 40;
/** How long a message found by search stays highlighted. */
const HIGHLIGHT_MS = 2000;
/** A first guess at a row's height, before it's measured. */
const ESTIMATED_ROW_PX = 60;

/** Today's date as a string, updated just after each midnight. */
function useToday(): string {
  const [today, setToday] = useState(() => new Date().toDateString());
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new day re-arms the timer for the next midnight.
  useEffect(() => {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    const timer = setTimeout(() => setToday(new Date().toDateString()), midnight - now.getTime() + 1_000);
    return () => clearTimeout(timer);
  }, [today]);
  return today;
}

/** Inline styles carry only computed positions, as custom properties the stylesheet reads. */
const vars = (values: Record<`--${string}`, string>) => values as CSSProperties;

export function Transcript({
  entries,
  pending = NO_PENDING,
  context,
  thread,
  replies,
  waiting,
  focus,
  onFocused,
  label,
}: {
  /** The entries of this view (see rows.ts conversation()). */
  entries: readonly TranscriptEntry[];
  /** Sent messages the gateway hasn't confirmed yet, shown at the end. */
  pending?: readonly PendingMessage[];
  context: RowContext;
  /** The open thread's root id; the main chat when undefined. */
  thread?: string;
  /** Messages per thread, by root id, for the main chat's "N replies" buttons. */
  replies?: ReadonlyMap<string, number>;
  /** Threads with a card waiting for the user, marked on their replies buttons. */
  waiting?: ReadonlySet<string>;
  /** A message to scroll to and highlight (from the search palette); `n` makes the same one count again. */
  focus?: { entryId: string; n: number };
  /** The focus was shown: the caller drops it, so it doesn't come back with the next mount. */
  onFocused?(): void;
  /** Accessible name of the log, e.g. "Conversation with Nova". */
  label: string;
}) {
  const today = useToday();
  // Rebuilt when entries change (a new array per change), and at midnight so "Today" becomes "Yesterday".
  // biome-ignore lint/correctness/useExhaustiveDependencies: today is a trigger; buildRows reads the clock itself.
  const rows = useMemo(
    () => buildRows(entries, new Date(), undefined, pending, { thread, replies, waiting }),
    [entries, pending, thread, replies, waiting, today],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastSent = useRef<string>(undefined);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    getItemKey: (i) => rows[i]?.key ?? i,
    overscan: 8,
  });
  const items = virtualizer.getVirtualItems();
  const total = virtualizer.getTotalSize();

  // After rows are added or grow (including streaming text and late measurements), stay pinned to the end.
  // biome-ignore lint/correctness/useExhaustiveDependencies: total is a trigger (rows measured), not a value used.
  useLayoutEffect(() => {
    // The user's own new message brings them back to the end, even if they had scrolled up.
    // Keyed by nonce where there is one, so the pending copy and the confirmed entry count as one message.
    const lastEntry = entries.at(-1);
    const last =
      pending.at(-1)?.nonce ??
      (lastEntry?.body.kind === "user_message" ? (lastEntry.body.clientNonce ?? lastEntry.id) : undefined);
    if (last !== undefined && last !== lastSent.current) {
      lastSent.current = last;
      following.current = true;
    }
    const el = scroller.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [entries, pending, total]);

  // Scroll to a searched-for message once its row exists (the transcript may still be loading), and highlight it.
  const [highlight, setHighlight] = useState<string>();
  const shown = useRef(0);
  useEffect(() => {
    if (!focus || shown.current === focus.n) return;
    const index = rows.findIndex((r) => r.key === focus.entryId);
    if (index < 0) return;
    shown.current = focus.n;
    following.current = false;
    virtualizer.scrollToIndex(index, { align: "center" });
    setHighlight(focus.entryId);
    onFocused?.();
  }, [focus, rows, virtualizer, onFocused]);
  // Its own timer, so re-renders (streaming text, a new focus object) can't keep the highlight on.
  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(() => setHighlight(undefined), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlight]);

  return (
    <div
      ref={scroller}
      className="transcript"
      role="log"
      aria-label={label}
      // Focusable so the keyboard can scroll it (arrows, Page Up/Down, Home/End).
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard.
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX;
      }}
    >
      <div className="transcript-sizer" style={vars({ "--list-height": `${total}px` })}>
        <div className="transcript-window" style={vars({ "--list-offset": `${items[0]?.start ?? 0}px` })}>
          {items.map((item) => {
            const row = rows[item.index];
            return row ? (
              <div
                key={item.key}
                data-index={item.index}
                data-highlight={row.key === highlight || undefined}
                ref={virtualizer.measureElement}
              >
                <ChatRow row={row} context={context} />
              </div>
            ) : null;
          })}
        </div>
      </div>
    </div>
  );
}
