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
      /** How many messages the thread started from this one holds (main view only). */
      replies?: number;
      /** The hover actions this row offers. */
      actions?: RowActions;
    }
  | { type: "thinking"; key: string; side: "bot"; group: GroupPos; gap: Gap };

/** What a message's hover bar offers: reply in a thread (main view), roll back to it (your own messages). */
export interface RowActions {
  thread: boolean;
  rollBack: boolean;
}

/** What one view shows: the main chat (`thread` undefined), or one thread, by its root's id. */
export interface ViewOptions {
  thread?: string;
  /** Messages per thread, by root id (see replyCounts). */
  replies?: ReadonlyMap<string, number>;
}

/**
 * The entries a view shows, in order. The main chat: everything not hidden (rolled back) and not in a thread. A
 * thread: its root, then its own visible entries. Empty when the root is gone (rolled back).
 */
export function conversation(entries: readonly TranscriptEntry[], thread?: string): TranscriptEntry[] {
  if (thread === undefined) return entries.filter((e) => !e.hidden && e.threadId === undefined);
  const root = entries.find((e) => e.id === thread);
  if (!root || root.hidden) return [];
  return [root, ...entries.filter((e) => !e.hidden && e.threadId === thread)];
}

/** How many messages (yours and the bot's) each thread holds, by root id. Threads with none aren't listed. */
export function replyCounts(entries: readonly TranscriptEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.hidden || e.threadId === undefined) continue;
    if (e.body.kind !== "user_message" && e.body.kind !== "assistant_text") continue;
    counts.set(e.threadId, (counts.get(e.threadId) ?? 0) + 1);
  }
  return counts;
}

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
    if (b.kind === "choice" && b.state === "pending") return false;
  }
  return false;
}

/** A message sent but not yet back from the gateway, matched by its nonce when it arrives. */
export interface PendingMessage {
  nonce: string;
  text: string;
  at: number;
  /** The thread it was sent in. */
  threadId?: string;
  /** The user entry's id, once the gateway has accepted the send. Matches even if the nonce isn't echoed. */
  entryId?: string;
}

/** Whether a pending message's own entry is already in the transcript (by nonce, or by the id the send returned). */
export function isConfirmed(p: PendingMessage, entries: readonly TranscriptEntry[]): boolean {
  return entries.some(
    (e) =>
      e.body.kind === "user_message" &&
      (e.body.clientNonce === p.nonce || (p.entryId !== undefined && e.id === p.entryId)),
  );
}

const PENDING_PREFIX = "pending-";

/**
 * A message's hover actions. In the main chat: reply in a thread (yours and the bot's), roll back (yours). In a
 * thread: roll back its own messages; its root belongs to the main chat and has none here.
 */
function actionsFor(entry: TranscriptEntry, thread: string | undefined): RowActions | undefined {
  const kind = entry.body.kind;
  if (kind !== "user_message" && kind !== "assistant_text") return undefined;
  if (thread !== undefined && entry.id === thread) return undefined;
  return { thread: thread === undefined, rollBack: kind === "user_message" };
}

export function buildRows(
  entries: readonly TranscriptEntry[],
  now: Date,
  locale?: string,
  pending: readonly PendingMessage[] = [],
  view: ViewOptions = {},
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
  for (const p of pending) {
    if (isConfirmed(p, entries)) continue;
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
      const pendingRow = item.entry.id.startsWith(PENDING_PREFIX) && item.entry.seq === -1;
      const replies = view.thread === undefined ? view.replies?.get(item.entry.id) : undefined;
      const actions = pendingRow ? undefined : actionsFor(item.entry, view.thread);
      rows.push({
        type: "entry",
        key: item.entry.id,
        entry: item.entry,
        side: item.side,
        group,
        gap,
        time: time(new Date(item.entry.createdAt), locale),
        ...(pendingRow ? { pending: true } : {}),
        ...(replies ? { replies } : {}),
        ...(actions ? { actions } : {}),
      });
    }
    prev = item;
    prevAt = Math.max(prevAt, at);
  }
  return rows;
}
