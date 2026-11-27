// Bot registry persisted to <dataDir>/bots.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Bot } from "./types.ts";

const DEFAULT_BOTS: Bot[] = [
  { id: "smarty", name: "Smarty", provider: "claude", avatar: { shape: "circle", color: "white" } },
];

/**
 * The default bot from before the rename kept the reference app's name, which must not ship. Renamed once, only
 * while it still has that exact name (a name the user chose is left alone). Its id stays: transcripts use it.
 */
function renameOldDefault(bot: Bot): Bot {
  return bot.id === "grok-bot" && bot.name === "Grok Bot" ? { ...bot, name: "Smarty" } : bot;
}

export class BotRegistry {
  private readonly file: string;
  private readonly bots = new Map<string, Bot>();

  constructor(dataDir: string, seed: Bot[] = DEFAULT_BOTS) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "bots.json");
    const initial = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Bot[]) : seed;
    for (const bot of initial) this.bots.set(bot.id, renameOldDefault(bot));
    this.save();
  }

  list(): Bot[] {
    return [...this.bots.values()];
  }

  get(id: string): Bot | undefined {
    return this.bots.get(id);
  }

  update(id: string, patch: Partial<Omit<Bot, "id">>): Bot {
    const bot = this.bots.get(id);
    if (!bot) throw new Error(`Unknown bot ${id}`);
    const next: Bot = { ...bot, ...patch };
    // A provider's session can't be resumed by another provider.
    // Its model names and server don't belong to another provider either, unless this same patch sets them.
    if (patch.provider && patch.provider !== bot.provider) {
      delete next.sessionId;
      delete next.sessionProvider;
      if (!("model" in patch)) delete next.model;
      // A server picked for the old provider must never receive the new provider's key.
      if (!("baseUrl" in patch)) delete next.baseUrl;
    }
    this.bots.set(id, next);
    this.save();
    return next;
  }

  /** The main bot: the first one. It's always shown and can't be deleted. */
  mainId(): string | undefined {
    return this.bots.keys().next().value;
  }

  remove(id: string): void {
    if (!this.bots.delete(id)) throw new Error(`Unknown bot ${id}`);
    this.save();
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.list(), null, 2));
  }
}
