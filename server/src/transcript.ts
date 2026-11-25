// Per-bot transcript store: append-or-update entries with seq/updatedSeq,
// live subscribers, and append-only JSONL persistence (last write per id wins on load).

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EntryBody, TranscriptEntry } from "./types.ts";

type Listener = (entry: TranscriptEntry) => void;

interface BotLog {
  entries: Map<string, TranscriptEntry>;
  nextSeq: number;
  nextUpdate: number;
  listeners: Set<Listener>;
  file: string;
}

export class TranscriptStore {
  private readonly dataDir: string;
  private readonly logs = new Map<string, BotLog>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  append(botId: string, body: EntryBody): TranscriptEntry {
    const log = this.log(botId);
    const now = Date.now();
    const entry: TranscriptEntry = {
      seq: log.nextSeq++,
      updatedSeq: log.nextUpdate++,
      id: randomUUID(),
      botId,
      body,
      createdAt: now,
      updatedAt: now,
    };
    return this.commit(log, entry);
  }

  /** Replace an entry's body, using a function of the current body. */
  update(botId: string, id: string, change: (body: EntryBody) => EntryBody): TranscriptEntry {
    const log = this.log(botId);
    const current = log.entries.get(id);
    if (!current) throw new Error(`No transcript entry ${id} for bot ${botId}`);
    const entry: TranscriptEntry = {
      ...current,
      body: change(current.body),
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

  subscribe(botId: string, listener: Listener): () => void {
    const log = this.log(botId);
    log.listeners.add(listener);
    return () => log.listeners.delete(listener);
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
    log = { entries: new Map(), nextSeq: 0, nextUpdate: 0, listeners: new Set(), file };
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
