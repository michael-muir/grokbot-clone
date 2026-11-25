// Finds the gateway the app talks to: attaches to GATEWAY_URL when set, otherwise starts the repo's gateway on a
// free port with a fresh token. No Electron imports, so it's testable with plain Node.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { GatewayClient } from "../../../server/src/client/gateway-client.ts";

export interface StartGatewayOptions {
  /** The gateway's package directory (`server/`). */
  serverDir: string;
  env?: NodeJS.ProcessEnv;
  /** Script to run, relative to serverDir. */
  entry?: string;
  /** Node binary that runs the gateway. */
  node?: string;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface GatewayHandle {
  client: GatewayClient;
  /** True when this app started the gateway (and so stops it). */
  spawned: boolean;
  /** Settles if a gateway this app started stops on its own. */
  exited: Promise<void>;
  stop(): Promise<void>;
}

const STOP_GRACE_MS = 3000;

export async function startGateway(opts: StartGatewayOptions): Promise<GatewayHandle> {
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const log = opts.log ?? ((line: string) => console.log(line));

  if (env.GATEWAY_URL) {
    const client = new GatewayClient({ baseUrl: env.GATEWAY_URL, token: env.GATEWAY_TOKEN || undefined });
    await waitUntilHealthy(client, timeoutMs, () => undefined);
    return { client, spawned: false, exited: new Promise(() => {}), stop: async () => {} };
  }

  const port = await freePort();
  const token = randomBytes(32).toString("hex");
  const child = spawn(opts.node ?? "node", ["--env-file-if-exists=.env", opts.entry ?? join("src", "main.ts")], {
    cwd: opts.serverDir,
    // Our port and token win over the user's server/.env: Node's --env-file never overrides set variables.
    env: { ...env, PORT: String(port), GATEWAY_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const recentErrors: string[] = [];
  let failure: string | undefined;
  const exited = new Promise<void>((resolve) => {
    // "close", not "exit": it waits for stdout and stderr to drain, so the last error lines are in.
    child.once("close", (code, signal) => {
      failure ??= `The gateway exited (${signal ?? `code ${code}`}) before it was ready.`;
      resolve();
    });
    // Spawning failed (no node on PATH, say): there will be no exit event.
    child.once("error", (err) => {
      failure ??= `Couldn't start the gateway: ${err.message}`;
      resolve();
    });
  });
  let running = true;
  void exited.then(() => {
    running = false;
  });

  createInterface({ input: child.stdout }).on("line", (line) => log(`[gateway] ${line}`));
  createInterface({ input: child.stderr }).on("line", (line) => {
    log(`[gateway] ${line}`);
    recentErrors.push(line);
    if (recentErrors.length > 10) recentErrors.shift();
  });

  const stop = async () => {
    if (!running) return;
    child.kill();
    if (await settlesWithin(exited, STOP_GRACE_MS)) return;
    child.kill("SIGKILL");
    await settlesWithin(exited, STOP_GRACE_MS);
  };

  const client = new GatewayClient({ baseUrl: `http://127.0.0.1:${port}`, token });
  try {
    await waitUntilHealthy(client, timeoutMs, () =>
      failure ? [failure, ...recentErrors.slice(-3)].join("\n") : undefined,
    );
  } catch (err) {
    await stop();
    throw err;
  }
  return { client, spawned: true, exited, stop };
}

/** Polls /health until it answers. Fails at once when `failed` reports a reason or the token is refused. */
async function waitUntilHealthy(client: GatewayClient, timeoutMs: number, failed: () => string | undefined) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reason = failed();
    if (reason) throw new Error(reason);
    if (await client.health(AbortSignal.timeout(1000))) return;
    if (Date.now() > deadline) {
      throw new Error(`The gateway at ${client.baseUrl} didn't answer within ${Math.round(timeoutMs / 1000)} s.`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A port nothing is listening on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("Couldn't find a free port"))));
    });
  });
}

async function settlesWithin(p: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  try {
    return await Promise.race([p.then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
