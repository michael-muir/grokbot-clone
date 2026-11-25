// A client's copy of one bot's transcript: entries applied by id, stale updates ignored, listed in conversation
// order. Plain TypeScript with no Node APIs, so the desktop app's renderer can use it as is.
import type { TranscriptEntry } from "../types.ts";

export class TranscriptView {
  private readonly byId = new Map<string, TranscriptEntry>();
  private highest = -1;

  /** The highest updatedSeq seen: resume the stream from here. */
  get cursor(): number {
    return this.highest;
  }

  /** Applies an entry. Returns false when it's not newer than the copy already held. */
  apply(entry: TranscriptEntry): boolean {
    const held = this.byId.get(entry.id);
    if (held && held.updatedSeq >= entry.updatedSeq) return false;
    this.byId.set(entry.id, entry);
    if (entry.updatedSeq > this.highest) this.highest = entry.updatedSeq;
    return true;
  }

  get(id: string): TranscriptEntry | undefined {
    return this.byId.get(id);
  }

  /** All entries in conversation order (seq). */
  entries(): TranscriptEntry[] {
    return [...this.byId.values()].sort((a, b) => a.seq - b.seq);
  }
}
