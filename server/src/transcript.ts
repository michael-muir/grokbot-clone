// Per-bot transcript store: append-or-update entries with seq/updatedSeq,
// live subscribers, and append-only JSONL persistence (last write per id wins on load).

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EntryBody, EntryMarks, TranscriptEntry } from "./types.ts";

type Listener = (entry: TranscriptEntry) => void;

interface BotLog {
  entries: Map<string, TranscriptEntry>;
  nextSeq: number;
  nextUpdate: number;
  listeners: Set<Listener>;
  /** Called when the bot's transcript is deleted: whoever is streaming it should stop. */
  enders: Set<() => void>;
  file: string;
}

export class TranscriptStore {
  private readonly dataDir: string;
  private readonly logs = new Map<string, BotLog>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /**
   * Adds an entry. Pass `id` when something must be keyed by the entry before listeners hear about it, `runId` for
   * entries a run wrote (or started), and `threadId` for entries in a thread.
   */
  append(
    botId: string,
    body: EntryBody,
    { id = randomUUID(), runId, threadId }: { id?: string; runId?: string; threadId?: string } = {},
  ): TranscriptEntry {
    const log = this.log(botId);
    if (log.entries.has(id)) throw new Error(`Transcript entry ${id} already exists`);
    const now = Date.now();
    const entry: TranscriptEntry = {
      seq: log.nextSeq++,
      updatedSeq: log.nextUpdate++,
      id,
      botId,
      body,
      ...(runId ? { runId } : {}),
      ...(threadId ? { threadId } : {}),
      createdAt: now,
      updatedAt: now,
    };
    return this.commit(log, entry);
  }

  /** Hides entries (a roll back): they stay in the log and stream to clients as changed, marked `hidden`. */
  hide(botId: string, ids: readonly string[]): void {
    for (const id of ids) if (!this.get(botId, id)?.hidden) this.mark(botId, id, { hidden: true });
  }

  /**
   * Changes an entry's marks (hidden, reactions, feedback) in place, like `update` does its body. A mark given as
   * undefined is removed. The body stays as it is.
   */
  mark(botId: string, id: string, patch: EntryMarks): TranscriptEntry {
    const log = this.log(botId);
    const current = log.entries.get(id);
    if (!current) throw new Error(`No transcript entry ${id} for bot ${botId}`);
    const next: TranscriptEntry = { ...current, updatedSeq: log.nextUpdate++, updatedAt: Date.now() };
    for (const key of Object.keys(patch) as (keyof EntryMarks)[]) {
      if (patch[key] === undefined) delete next[key];
      else Object.assign(next, { [key]: patch[key] });
    }
    return this.commit(log, next);
  }

  /**
   * Changes an entry. `change` must return a new object when it changes something (never mutate `body`):
   * returning the same object means "no change", and nothing is written or broadcast.
   */
  update(botId: string, id: string, change: (body: EntryBody) => EntryBody): TranscriptEntry {
    const log = this.log(botId);
    const current = log.entries.get(id);
    if (!current) throw new Error(`No transcript entry ${id} for bot ${botId}`);
    const body = change(current.body);
    // No change, no write: avoids re-sending identical entries to every client and growing the log.
    if (body === current.body) return current;
    const entry: TranscriptEntry = {
      ...current,
      body,
      updatedSeq: log.nextUpdate++,
      updatedAt: Date.now(),
    };
    return this.commit(log, entry);
  }

  get(botId: string, id: string): TranscriptEntry | undefined {
    return this.log(botId).entries.get(id);
  }

  /** Entries changed after `since` (an updatedSeq), in conversation order. */
  list(botId: string, since = -1): TranscriptEntry[] {
    return [...this.log(botId).entries.values()].filter((e) => e.updatedSeq > since).sort((a, b) => a.seq - b.seq);
  }

  /**
   * Entries changed after `since`, in the order they changed (updatedSeq). This is the order a stream must use:
   * a client that resumes from the highest updatedSeq it saw then can't skip anything, wherever it was cut off.
   */
  changedSince(botId: string, since = -1): TranscriptEntry[] {
    return [...this.log(botId).entries.values()]
      .filter((e) => e.updatedSeq > since)
      .sort((a, b) => a.updatedSeq - b.updatedSeq);
  }

  /** `onEnd` runs if the transcript is deleted while subscribed (the bot was deleted). */
  subscribe(botId: string, listener: Listener, onEnd?: () => void): () => void {
    const log = this.log(botId);
    log.listeners.add(listener);
    if (onEnd) log.enders.add(onEnd);
    return () => {
      log.listeners.delete(listener);
      if (onEnd) log.enders.delete(onEnd);
    };
  }

  /** Deletes a bot's transcript, on disk and in memory. Its listeners hear nothing more; streams are ended. */
  forget(botId: string): void {
    const log = this.logs.get(botId);
    const file = log?.file ?? join(this.dataDir, "bots", botId, "transcript.jsonl");
    rmSync(file, { force: true });
    try {
      rmdirSync(dirname(file)); // the bot's folder, once nothing else of the bot's is left in it
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") console.warn(`Couldn't remove ${dirname(file)}`, err);
    }
    this.logs.delete(botId);
    if (!log) return;
    log.listeners.clear();
    for (const end of [...log.enders]) {
      try {
        end();
      } catch (err) {
        console.error("ending a transcript stream failed", err);
      }
    }
    log.enders.clear();
  }

  private commit(log: BotLog, entry: TranscriptEntry): TranscriptEntry {
    log.entries.set(entry.id, entry);
    appendFileSync(log.file, `${JSON.stringify(entry)}\n`);
    for (const listener of log.listeners) {
      try {
        listener(entry);
      } catch (err) {
        console.error("transcript listener failed", err);
      }
    }
    return entry;
  }

  private log(botId: string): BotLog {
    let log = this.logs.get(botId);
    if (log) return log;
    const file = join(this.dataDir, "bots", botId, "transcript.jsonl");
    mkdirSync(dirname(file), { recursive: true });
    log = { entries: new Map(), nextSeq: 0, nextUpdate: 0, listeners: new Set(), enders: new Set(), file };
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as TranscriptEntry;
        log.entries.set(entry.id, entry);
        log.nextSeq = Math.max(log.nextSeq, entry.seq + 1);
        log.nextUpdate = Math.max(log.nextUpdate, entry.updatedSeq + 1);
      }
    }
    this.logs.set(botId, log);
    return log;
  }
}
