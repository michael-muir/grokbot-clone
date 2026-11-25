// Live transcript subscription for clients: reads the gateway's event stream, reconnects with backoff, and resumes
// from the last entry it saw, so nothing is lost or repeated. No Node APIs, so the desktop renderer can use it.
import type { TranscriptEntry } from "../types.ts";

export type StreamState = "connecting" | "live" | "reconnecting";

export interface SubscribeOptions {
  onEntry(entry: TranscriptEntry): void;
  onState?(state: StreamState): void;
  signal: AbortSignal;
  token?: string;
  /** Resume after this updatedSeq (default: from the start). */
  since?: number;
  backoff?: { initialMs: number; maxMs: number };
  /** With no data or heartbeat for this long, the connection is treated as dead and replaced. */
  staleAfterMs?: number;
  fetch?: typeof fetch;
}

/** The server said no in a way retrying won't fix (unknown bot, bad token). */
export class SubscriptionError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const PERMANENT = new Set([400, 401, 403, 404]);
const DEFAULT_BACKOFF = { initialMs: 500, maxMs: 10_000 };
/** Three missed 15-second heartbeats. */
const DEFAULT_STALE_MS = 45_000;

/**
 * Streams a bot's transcript until `signal` aborts. Every entry is delivered once per change, in the order the
 * changes happened, across any number of reconnects. Rejects only with a SubscriptionError.
 */
export async function subscribeTranscript(baseUrl: string, botId: string, opts: SubscribeOptions): Promise<void> {
  const { signal } = opts;
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_MS;
  const fetchFn = opts.fetch ?? fetch;
  let cursor = opts.since ?? -1;
  let delay = backoff.initialMs;
  let firstAttempt = true;

  while (!signal.aborted) {
    opts.onState?.(firstAttempt ? "connecting" : "reconnecting");
    firstAttempt = false;

    const attempt = new AbortController();
    const stop = () => attempt.abort();
    signal.addEventListener("abort", stop, { once: true });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const kick = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(stop, staleAfterMs);
    };

    try {
      kick();
      const url = `${baseUrl.replace(/\/+$/, "")}/bots/${encodeURIComponent(botId)}/events?since=${cursor}`;
      const res = await fetchFn(url, {
        headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
        signal: attempt.signal,
      });
      if (PERMANENT.has(res.status)) {
        throw new SubscriptionError(res.status, `The gateway refused the stream (${res.status}): ${await res.text()}`);
      }
      if (!res.ok || !res.body) throw new Error(`The gateway answered ${res.status}`);
      opts.onState?.("live");
      delay = backoff.initialMs;

      for await (const data of sseEvents(res.body, kick)) {
        const entry = JSON.parse(data) as TranscriptEntry;
        // The stream is in updatedSeq order and resumes after the cursor, so anything older is a repeat.
        if (entry.updatedSeq <= cursor) continue;
        cursor = entry.updatedSeq;
        opts.onEntry(entry);
      }
    } catch (err) {
      if (err instanceof SubscriptionError) throw err;
      // Anything else (network error, server restart, stale connection) is retried.
    } finally {
      clearTimeout(watchdog);
      signal.removeEventListener("abort", stop);
    }

    if (signal.aborted) break;
    await wait(delay, signal);
    delay = Math.min(delay * 2, backoff.maxMs);
  }
}

/** Yields each event's data; calls `onActivity` for every event, comments (heartbeats) included. */
async function* sseEvents(body: ReadableStream<Uint8Array>, onActivity: () => void): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    for (let end = buf.indexOf("\n\n"); end >= 0; end = buf.indexOf("\n\n")) {
      const block = buf.slice(0, end);
      buf = buf.slice(end + 2);
      onActivity();
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""));
      if (data.length) yield data.join("\n");
    }
  }
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
