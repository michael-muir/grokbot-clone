// Conversation history for the built-in agent loop, one JSON file per session under <dataDir>/sessions/.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "./model.ts";

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class SessionStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "sessions");
    mkdirSync(this.dir, { recursive: true });
  }

  newId(): string {
    return randomUUID();
  }

  /** The session's messages, or an empty history for a session that doesn't exist yet. */
  load(id: string): ChatMessage[] {
    const file = this.file(id);
    if (!existsSync(file)) return [];
    return JSON.parse(readFileSync(file, "utf8")) as ChatMessage[];
  }

  save(id: string, messages: ChatMessage[]): void {
    const file = this.file(id);
    // Write then rename, so a crash mid-write never leaves a truncated history.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(messages));
    renameSync(tmp, file);
  }

  private file(id: string): string {
    if (!SESSION_ID.test(id)) throw new Error(`Invalid session id ${id}`);
    return join(this.dir, `${id}.json`);
  }
}
