// "Bot's computer": where a bot's agent works.
//
// Grok Bot gives every bot a Linux box (/home/box) with a desktop, VNC and a
// shared skills folder. This first step uses a local folder per bot. A
// container-backed implementation (Docker or WSL, with noVNC for the live view)
// can replace it without touching the gateway or providers.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export interface BotComputer {
  /** Directory the agent treats as its home/workspace. */
  readonly workspaceDir: string;
}

export interface ComputerManager {
  ensure(botId: string): Promise<BotComputer>;
}

export class LocalFolderComputers implements ComputerManager {
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async ensure(botId: string): Promise<BotComputer> {
    if (!/^[a-z0-9-]+$/.test(botId)) throw new Error(`Invalid bot id ${botId}`);
    const workspaceDir = resolve(join(this.dataDir, "bots", botId, "computer"));
    // Shared across bots, like Grok Bot's /home/box/agent-data/workflows skills library.
    mkdirSync(join(workspaceDir, "agent-data", "workflows"), { recursive: true });
    return { workspaceDir };
  }
}
