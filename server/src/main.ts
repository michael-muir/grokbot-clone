// Gateway entry point: wires the bot registry, transcript store, providers and HTTP server, then listens.
import { resolve } from "node:path";
import { BotRegistry } from "./bots.ts";
import { LocalFolderComputers } from "./computer.ts";
import { Gateway } from "./gateway.ts";
import { createHttpServer } from "./http.ts";
import { Credentials, KeychainKeyStore } from "./keys.ts";
import { defaultProviders } from "./providers/index.ts";
import { TranscriptStore } from "./transcript.ts";

const dataDir = resolve(process.env.DATA_DIR || "../data");
const port = Number(process.env.PORT || 8787);

const bots = new BotRegistry(dataDir);
const store = new TranscriptStore(dataDir);
const credentials = new Credentials(new KeychainKeyStore());
const providers = defaultProviders(dataDir, credentials);
const gateway = new Gateway(bots, store, providers, new LocalFolderComputers(dataDir));
const server = createHttpServer({
  gateway,
  bots,
  store,
  providers,
  credentials,
  token: process.env.GATEWAY_TOKEN || undefined,
});

if (!credentials.key("claude")) {
  console.warn(
    "No Claude API key: Claude bots will fail. Add one in Settings (PUT /providers/claude/key), set ANTHROPIC_API_KEY in server/.env, or switch the bot to another provider.",
  );
}

// Localhost only: the agent can run commands on this machine.
server.listen(port, "127.0.0.1", () => {
  console.log(`GrokBot Clone gateway on http://127.0.0.1:${port} (data: ${dataDir})`);
});
