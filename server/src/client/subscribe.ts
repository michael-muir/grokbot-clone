// Live transcript subscription for clients: reads the gateway's event stream, reconnects with backoff, and resumes
// from the last entry it saw, so nothing is lost or repeated. No Node APIs, so the desktop renderer can use it.
import type { TranscriptEntry } from "../types.ts";

export type StreamState = "connecting" | "live" | "reconnecting";

export interface SubscribeOptions {
  /** Called once per change. If it throws, the subscription stops with that error (nothing is skipped). */
  onEntry(entry: TranscriptEntry): void;
  onState?(state: StreamState): void;
  /** Why a connection ended before a retry (network error, server restart, a skipped bad event…). */
  onError?(err: unknown): void;
  signal: AbortSignal;
  token?: string;
  /** Resume after this updatedSeq (default: from the start). */
  since?: number;
  backoff?: { initialMs: number; maxMs: number };
  /** With no data or heartbeat for this long, the connection is treated as dead and replaced. */
  staleAfterMs?: number;
  fetch?: typeof fetch;
}

/** The server said no in a way retrying won't fix (unknown bot, bad token), or the stream can't be read. */
export class SubscriptionError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Wraps an error thrown by the caller's onEntry, so it stops the subscription instead of looking like a drop. */
class ConsumerError extends Error {
  readonly inner: unknown;
  constructor(inner: unknown) {
    super("onEntry threw");
    this.inner = inner;
  }
}

const PERMANENT = new Set([400, 401, 403, 404]);
const DEFAULT_BACKOFF = { initialMs: 500, maxMs: 10_000 };
/** Three missed 15-second heartbeats. */
const DEFAULT_STALE_MS = 45_000;

/**
 * Streams a bot's transcript until `signal` aborts. Every entry is delivered once per change, in the order the
 * changes happened, across any number of reconnects. Rejects with a SubscriptionError, or with what onEntry threw.
 */
export async function subscribeTranscript(baseUrl: string, botId: string, opts: SubscribeOptions): Promise<void> {
  const { signal } = opts;
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_MS;
  const fetchFn = opts.fetch ?? fetch;
  const reportError =
    opts.onError ?? ((err: unknown) => console.warn(`transcript stream for ${botId} dropped; reconnecting`, err));
  let cursor = opts.since ?? -1;
  let delay = backoff.initialMs;

  opts.onState?.("connecting");
  while (!signal.aborted) {
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

      for await (const event of sseEvents(res.body, kick)) {
        let entry: TranscriptEntry;
        try {
          entry = JSON.parse(event.data) as TranscriptEntry;
        } catch {
          // Without its id, a bad event can't be stepped over: retrying would just hit it again.
          if (event.id === undefined) throw new SubscriptionError(0, "The gateway sent an event that isn't JSON.");
          reportError(new Error(`Skipped an event that isn't JSON (id ${event.id})`));
          cursor = Math.max(cursor, event.id);
          continue;
        }
        // The stream is in updatedSeq order and resumes after the cursor, so anything older is a repeat.
        if (entry.updatedSeq <= cursor) continue;
        try {
          opts.onEntry(entry);
        } catch (err) {
          throw new ConsumerError(err);
        }
        // Only now: if onEntry had thrown, the entry must not count as delivered.
        cursor = entry.updatedSeq;
      }
    } catch (err) {
      if (err instanceof SubscriptionError) throw err;
      if (err instanceof ConsumerError) throw err.inner;
      if (!signal.aborted) reportError(err);
    } finally {
      clearTimeout(watchdog);
      signal.removeEventListener("abort", stop);
    }

    if (signal.aborted) break;
    // Say so at once: the wait before the next try can be several seconds.
    opts.onState?.("reconnecting");
    await wait(delay, signal);
    delay = Math.min(delay * 2, backoff.maxMs);
  }
}

/**
 * Yields each event's data (and id, when given); calls `onActivity` for every event, heartbeats included.
 * Accepts LF, CRLF and CR line endings, as the SSE format allows.
 */
async function* sseEvents(
  body: ReadableStream<Uint8Array>,
  onActivity: () => void,
): AsyncGenerator<{ data: string; id?: number }> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    // A trailing CR may be the first half of a CRLF split across chunks; leave it for the next chunk.
    const ready = buf.endsWith("\r") ? buf.slice(0, -1) : buf;
    const held = buf.slice(ready.length);
    buf = ready.replace(/\r\n?/g, "\n") + held;
    for (let end = buf.indexOf("\n\n"); end >= 0; end = buf.indexOf("\n\n")) {
      const block = buf.slice(0, end);
      buf = buf.slice(end + 2);
      onActivity();
      let id: number | undefined;
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        else if (line.startsWith("id:")) {
          const n = Number(line.slice(3).trim());
          if (Number.isInteger(n)) id = n;
        }
      }
      if (data.length) yield { data: data.join("\n"), id };
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
