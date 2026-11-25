// Gateway entry point: wires the bot registry, transcript store, providers and HTTP server, then listens.
import { resolve } from "node:path";
import { BotRegistry } from "./bots.ts";
import { LocalFolderComputers } from "./computer.ts";
import { Gateway } from "./gateway.ts";
import { createHttpServer } from "./http.ts";
import { defaultProviders } from "./providers/index.ts";
import { TranscriptStore } from "./transcript.ts";

const dataDir = resolve(process.env.DATA_DIR || "../data");
const port = Number(process.env.PORT || 8787);

const bots = new BotRegistry(dataDir);
const store = new TranscriptStore(dataDir);
const gateway = new Gateway(bots, store, defaultProviders(), new LocalFolderComputers(dataDir));
const server = createHttpServer({ gateway, bots, store, token: process.env.GATEWAY_TOKEN || undefined });

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    'ANTHROPIC_API_KEY is not set: Claude bots will fail. Set it in server/.env, or switch a bot to the "fake" provider.',
  );
}

// Localhost only: the agent can run commands on this machine.
server.listen(port, "127.0.0.1", () => {
  console.log(`GrokBot Clone gateway on http://127.0.0.1:${port} (data: ${dataDir})`);
});
