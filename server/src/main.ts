// Gateway entry point: wires the bot registry, transcript store, providers and HTTP server, then listens.
import { resolve } from "node:path";
import { BotRegistry } from "./bots.ts";
import { LocalFolderComputers } from "./computer.ts";
import { Gateway } from "./gateway.ts";
import { createHttpServer } from "./http.ts";
import { Credentials, KeychainKeyStore } from "./keys.ts";
import { defaultProviders } from "./providers/index.ts";
import { BotSecrets, KeychainSecretStore } from "./secrets.ts";
import { TranscriptStore } from "./transcript.ts";

const dataDir = resolve(process.env.DATA_DIR || "../data");
const port = Number(process.env.PORT || 8787);

const bots = new BotRegistry(dataDir);
const store = new TranscriptStore(dataDir);
const credentials = new Credentials(new KeychainKeyStore());
const providers = defaultProviders(dataDir, credentials);
const gateway = new Gateway(
  bots,
  store,
  providers,
  new LocalFolderComputers(dataDir),
  new BotSecrets(new KeychainSecretStore()),
);
const server = createHttpServer({
  gateway,
  bots,
  store,
  providers,
  credentials,
  token: process.env.GATEWAY_TOKEN || undefined,
  allowedOrigins: (process.env.GATEWAY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
});

if (!credentials.key("claude")) {
  console.warn(
    "No Claude API key: Claude bots will fail. Add one in Settings (PUT /providers/claude/key), set ANTHROPIC_API_KEY in server/.env, or switch the bot to another provider.",
  );
}

// Localhost only: the agent can run commands on this machine.
server.listen(port, "127.0.0.1", () => {
  console.log(`SmartyPrompts gateway on http://127.0.0.1:${port} (data: ${dataDir})`);
});

// Stop cleanly: interrupted runs are recorded as interrupted, and no transcript write is cut off. The desktop app
// asks over its IPC channel, because on Windows a kill is immediate and can't be caught.
const SHUTDOWN_GRACE_MS = 5000;
let shuttingDown = false;
function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down (${reason})`);
  server.close();
  server.closeAllConnections();
  const forced = setTimeout(() => {
    console.error("Runs didn't stop in time; exiting anyway.");
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  void gateway.shutdown().then(() => {
    clearTimeout(forced);
    process.exit(0);
  });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("message", (message: unknown) => {
  if (typeof message === "object" && message !== null && "type" in message && message.type === "shutdown") {
    shutdown("asked by the app");
  }
});
// Started by the app, which has gone away without asking (crashed or killed): don't linger.
process.on("disconnect", () => shutdown("the app went away"));
