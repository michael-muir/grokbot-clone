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
  /** Gives up on starting (and stops the process) when it fires. */
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface GatewayHandle {
  client: GatewayClient;
  /** True when this app started the gateway (and so stops it). */
  spawned: boolean;
  /** Settles when a gateway this app started has exited, for whatever reason. */
  exited: Promise<void>;
  stop(): Promise<void>;
}

/** How long the gateway gets to finish runs after being asked to stop: its own limit, plus a margin. */
const STOP_GRACE_MS = 7000;
const KILL_WAIT_MS = 3000;
const PORT_ATTEMPTS = 3;

export async function startGateway(opts: StartGatewayOptions): Promise<GatewayHandle> {
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const log = opts.log ?? ((line: string) => console.log(line));

  if (env.GATEWAY_URL) {
    const client = new GatewayClient({ baseUrl: env.GATEWAY_URL, token: env.GATEWAY_TOKEN || undefined });
    await waitUntilHealthy(client, timeoutMs, opts.signal, () => undefined);
    return { client, spawned: false, exited: new Promise(() => {}), stop: async () => {} };
  }

  // The port is free when picked but could be taken before the gateway binds it; a fresh port fixes that.
  for (let attempt = 1; ; attempt++) {
    try {
      return await spawnGateway(opts, env, timeoutMs, log);
    } catch (err) {
      if (!(err instanceof PortTakenError) || attempt >= PORT_ATTEMPTS) throw err;
      log(`[gateway] port ${err.port} was taken; trying another`);
    }
  }
}

class PortTakenError extends Error {
  readonly port: number;
  constructor(port: number) {
    super(`Port ${port} is in use`);
    this.port = port;
  }
}

async function spawnGateway(
  opts: StartGatewayOptions,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  log: (line: string) => void,
): Promise<GatewayHandle> {
  const port = await freePort();
  const token = randomBytes(32).toString("hex");
  const child = spawn(opts.node ?? "node", ["--env-file-if-exists=.env", opts.entry ?? join("src", "main.ts")], {
    cwd: opts.serverDir,
    // Our port and token win over the user's server/.env: Node's --env-file never overrides set variables.
    env: { ...env, PORT: String(port), GATEWAY_TOKEN: token },
    // The IPC channel carries the shutdown request (a kill on Windows can't be caught) and tells the gateway
    // to exit if the app dies.
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });

  const recentErrors: string[] = [];
  let failure: string | undefined;
  let running = true;
  const exited = new Promise<void>((resolve) => {
    // "close", not "exit": it waits for stdout and stderr to drain, so the last error lines are in.
    child.once("close", (code, signal) => {
      failure ??= `The gateway exited (${signal ?? `code ${code}`}) before it was ready.`;
      running = false;
      resolve();
    });
    // Spawning failed (no node on PATH, say): there may be no close event.
    child.once("error", (err) => {
      failure ??= `Couldn't start the gateway: ${err.message}`;
      running = false;
      resolve();
    });
  });

  // Both are pipes (see stdio above); the types allow null only because stdio is configurable.
  const { stdout, stderr } = child;
  if (!stdout || !stderr) throw new Error("The gateway's output pipes weren't created");
  createInterface({ input: stdout }).on("line", (line) => log(`[gateway] ${line}`));
  createInterface({ input: stderr }).on("line", (line) => {
    log(`[gateway] ${line}`);
    recentErrors.push(line);
    if (recentErrors.length > 10) recentErrors.shift();
  });

  /** Graceful: ask first, so runs can record their end. A gateway that never got ready has none: kill it. */
  const stop = async (graceful = true) => {
    if (!running) return;
    if (graceful && child.connected) {
      child.send({ type: "shutdown" });
      if (await settlesWithin(exited, STOP_GRACE_MS)) return;
      log("[gateway] didn't stop when asked; killing it");
    }
    child.kill();
    if (await settlesWithin(exited, KILL_WAIT_MS)) return;
    child.kill("SIGKILL");
    await settlesWithin(exited, KILL_WAIT_MS);
  };

  const client = new GatewayClient({ baseUrl: `http://127.0.0.1:${port}`, token });
  try {
    await waitUntilHealthy(client, timeoutMs, opts.signal, () =>
      failure ? [failure, ...recentErrors.slice(-3)].join("\n") : undefined,
    );
  } catch (err) {
    await stop(false);
    if (recentErrors.some((line) => line.includes("EADDRINUSE"))) throw new PortTakenError(port);
    throw err;
  }
  return { client, spawned: true, exited, stop: () => stop(true) };
}

/**
 * Polls /health until it answers. Fails at once when `failed` reports a reason, the token is refused, or the
 * signal fires.
 */
async function waitUntilHealthy(
  client: GatewayClient,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  failed: () => string | undefined,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new Error("Stopped while the gateway was starting.");
    const reason = failed();
    if (reason) throw new Error(reason);
    const attempt = signal ? AbortSignal.any([signal, AbortSignal.timeout(1000)]) : AbortSignal.timeout(1000);
    if (await client.health(attempt)) return;
    if (Date.now() > deadline) {
      throw new Error(`The gateway at ${client.baseUrl} didn't answer within ${Math.round(timeoutMs / 1000)} s.`);
    }
    await sleep(100, signal);
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
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
