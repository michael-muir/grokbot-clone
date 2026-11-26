// Bot registry persisted to <dataDir>/bots.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Bot } from "./types.ts";

const DEFAULT_BOTS: Bot[] = [
  { id: "smarty", name: "Smarty", provider: "claude", avatar: { shape: "circle", color: "white" } },
];

export class BotRegistry {
  private readonly file: string;
  private readonly bots = new Map<string, Bot>();

  constructor(dataDir: string, seed: Bot[] = DEFAULT_BOTS) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "bots.json");
    const initial = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as Bot[]) : seed;
    for (const bot of initial) this.bots.set(bot.id, bot);
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

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.list(), null, 2));
  }
}
