// Turns transcript entries into display rows: which side each sits on, how bubbles group, the spacing above each
// row, and time separators. Pure, so the layout rules are tested without rendering.
import type { TranscriptEntry } from "../../../../../server/src/types.ts";

export type Side = "bot" | "user" | "center";
/** Where a bubble sits in a run of consecutive bubbles; sets which corners are joined. */
export type GroupPos = "single" | "first" | "middle" | "last";
/** Space above a row: none (first row), tight (same group), group (new group, same side), switch (other side). */
export type Gap = "none" | "tight" | "group" | "switch";

export type Row =
  | { type: "separator"; key: string; label: string; gap: Gap }
  | {
      type: "entry";
      key: string;
      entry: TranscriptEntry;
      side: Side;
      group: GroupPos;
      gap: Gap;
      time: string;
      /** A message the user sent that the gateway hasn't confirmed yet. */
      pending?: boolean;
    }
  | { type: "thinking"; key: string; side: "bot"; group: GroupPos; gap: Gap };

/** A pause this long between entries starts a new time separator. */
export const SEPARATOR_GAP_MS = 60 * 60 * 1000;

const time = (at: Date, locale?: string) => at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "Today 3:19 PM", "Yesterday 9:02 AM", "Mon, Nov 23 3:28 PM" (with the year when it isn't this year). */
export function separatorLabel(at: Date, now: Date, locale?: string): string {
  const days = Math.round((dayStart(now) - dayStart(at)) / 86_400_000);
  if (days === 0) return `Today ${time(at, locale)}`;
  if (days === 1) return `Yesterday ${time(at, locale)}`;
  const date = at.toLocaleDateString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${date} ${time(at, locale)}`;
}

/** Which side an entry sits on, or null when it isn't shown at all. */
function sideOf(entry: TranscriptEntry): Side | null {
  const b = entry.body;
  switch (b.kind) {
    case "user_message":
      return "user";
    case "assistant_text":
      // An empty streaming reply has nothing to show yet; the Thinking row covers it.
      return b.text === "" ? null : "bot";
    case "status":
    case "approval":
    case "choice":
      return "bot";
    case "notice":
    case "error":
      return "center";
    case "run":
      // Running and finished runs are implied by their content. A failed run has its own error entry.
      return b.state === "interrupted" ? "center" : null;
  }
}

/** Bubbles and status rows on the same side join into one group; cards and notices stand alone. */
function joins(entry: TranscriptEntry | "thinking"): boolean {
  if (entry === "thinking") return true;
  const kind = entry.body.kind;
  return kind === "assistant_text" || kind === "user_message" || kind === "status";
}

/** True while the latest run is going and nothing in it is visibly happening yet (streaming, running, asking). */
function isThinking(entries: readonly TranscriptEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const b = entries[i]?.body;
    if (!b) continue;
    if (b.kind === "run") return b.state === "running";
    if (b.kind === "assistant_text" && b.streaming && b.text !== "") return false;
    if (b.kind === "status" && b.state === "running") return false;
    if (b.kind === "approval" && b.state === "pending") return false;
  }
  return false;
}

/** A message sent but not yet back from the gateway, matched by its nonce when it arrives. */
export interface PendingMessage {
  nonce: string;
  text: string;
  at: number;
}

const PENDING_PREFIX = "pending-";

export function buildRows(
  entries: readonly TranscriptEntry[],
  now: Date,
  locale?: string,
  pending: readonly PendingMessage[] = [],
): Row[] {
  type Item = { entry: TranscriptEntry | "thinking"; side: Side };
  const items: Item[] = [];
  // A run's entry is written when the run starts, so its "Stopped" notice is held back until after everything
  // the run produced: just before the next message or run, or at the end.
  let stopped: { entry: TranscriptEntry; side: Side } | undefined;
  for (const entry of entries) {
    const side = sideOf(entry);
    const kind = entry.body.kind;
    // The run's own entries carry its runId; the first entry that doesn't (a notice, the next message) ends it.
    // Older transcripts have no runIds, so a new message or run ends it there.
    const endsRun = kind === "user_message" || kind === "run" || entry.runId !== stopped?.entry.runId;
    if (stopped && endsRun) {
      items.push(stopped);
      stopped = undefined;
    }
    if (!side) continue;
    if (kind === "run") stopped = { entry, side };
    else items.push({ entry, side });
  }
  if (stopped) items.push(stopped);
  // Pending messages go at the end until the gateway's copy (same nonce) is in the transcript.
  const confirmed = new Set(
    entries.flatMap((e) => (e.body.kind === "user_message" && e.body.clientNonce ? [e.body.clientNonce] : [])),
  );
  for (const p of pending) {
    if (confirmed.has(p.nonce)) continue;
    items.push({
      side: "user",
      entry: {
        id: `${PENDING_PREFIX}${p.nonce}`,
        seq: -1,
        updatedSeq: -1,
        botId: "",
        body: { kind: "user_message", text: p.text, clientNonce: p.nonce },
        createdAt: p.at,
        updatedAt: p.at,
      },
    });
  }
  if (isThinking(entries)) items.push({ entry: "thinking", side: "bot" });

  const rows: Row[] = [];
  let prev: Item | undefined;
  // The latest time shown so far. Rows aren't strictly in time order (a Stopped notice moves after its run's
  // output), so pauses are measured from the latest, not from the row just before.
  let prevAt = Number.NEGATIVE_INFINITY;
  for (const [i, item] of items.entries()) {
    const at = item.entry === "thinking" ? prevAt : item.entry.createdAt;
    let separated = false;
    if (item.entry !== "thinking" && (rows.length === 0 || at - prevAt >= SEPARATOR_GAP_MS)) {
      const key = `sep-${item.entry.id}`;
      rows.push({
        type: "separator",
        key,
        label: separatorLabel(new Date(at), now, locale),
        gap: prev ? "switch" : "none",
      });
      separated = true;
    }
    const next = items[i + 1];
    const nextSeparated =
      next && next.entry !== "thinking" && next.entry.createdAt - Math.max(prevAt, at) >= SEPARATOR_GAP_MS;
    const joinsPrev =
      !separated && prev !== undefined && prev.side === item.side && joins(prev.entry) && joins(item.entry);
    const joinsNext =
      next !== undefined && !nextSeparated && next.side === item.side && joins(item.entry) && joins(next.entry);
    const group: GroupPos = joinsPrev ? (joinsNext ? "middle" : "last") : joinsNext ? "first" : "single";
    const gap: Gap = separated
      ? "none"
      : !prev
        ? "none"
        : joinsPrev
          ? "tight"
          : prev.side === item.side
            ? "group"
            : "switch";

    if (item.entry === "thinking") rows.push({ type: "thinking", key: "thinking", side: "bot", group, gap });
    else {
      rows.push({
        type: "entry",
        key: item.entry.id,
        entry: item.entry,
        side: item.side,
        group,
        gap,
        time: time(new Date(item.entry.createdAt), locale),
        ...(item.entry.id.startsWith(PENDING_PREFIX) && item.entry.seq === -1 ? { pending: true } : {}),
      });
    }
    prev = item;
    prevAt = Math.max(prevAt, at);
  }
  return rows;
}
