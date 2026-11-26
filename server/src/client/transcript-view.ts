// A client's copy of one bot's transcript: entries kept in seq order, updated in place, stale updates ignored.
// Plain TypeScript with no Node APIs, so the desktop app's renderer can use it as is (with useSyncExternalStore).
import type { TranscriptEntry } from "../types.ts";

export class TranscriptView {
  /** Sorted by seq. */
  private readonly list: TranscriptEntry[] = [];
  private readonly byId = new Map<string, TranscriptEntry>();
  private readonly listeners = new Set<() => void>();
  /** The copy handed out by entries(), reused until the next change. */
  private snapshot: readonly TranscriptEntry[] | undefined = [];
  private highest = -1;
  private changes = 0;

  /** The highest updatedSeq seen: resume the stream from here. */
  get cursor(): number {
    return this.highest;
  }

  /** Bumps on every applied change. */
  get version(): number {
    return this.changes;
  }

  /** Applies an entry. Returns false when it's not newer than the copy already held. */
  apply(entry: TranscriptEntry): boolean {
    const held = this.byId.get(entry.id);
    if (held && held.updatedSeq >= entry.updatedSeq) return false;
    this.byId.set(entry.id, entry);
    if (entry.updatedSeq > this.highest) this.highest = entry.updatedSeq;

    if (held) {
      // seq never changes, so the entry keeps its position.
      this.list[this.firstAtOrAfter(held.seq)] = entry;
    } else if ((this.list.at(-1)?.seq ?? Number.NEGATIVE_INFINITY) < entry.seq) {
      this.list.push(entry); // the common case: a new entry at the end
    } else {
      this.list.splice(this.firstAtOrAfter(entry.seq), 0, entry);
    }
    // Copying here would cost O(n) per streamed token; entries() copies once per read instead.
    this.snapshot = undefined;
    this.changes++;
    for (const listener of this.listeners) listener();
    return true;
  }

  get(id: string): TranscriptEntry | undefined {
    return this.byId.get(id);
  }

  /** All entries in conversation order (seq). The same array until the next change. */
  entries(): readonly TranscriptEntry[] {
    this.snapshot ??= this.list.slice();
    return this.snapshot;
  }

  /** Called after every applied change. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Binary search: the first index whose seq is >= `seq`. */
  private firstAtOrAfter(seq: number): number {
    let lo = 0;
    let hi = this.list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.list[mid]?.seq ?? Number.POSITIVE_INFINITY) < seq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
