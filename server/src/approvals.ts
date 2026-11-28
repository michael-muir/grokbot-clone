// Cards waiting for the user (approvals, choices): a provider asks, the user answers through the API, and stopping
// the run settles the wait with a fallback value.

export class Waiters<T> {
  private readonly pending = new Map<string, (value: T) => void>();
  private readonly onAbort: T;

  /** `onAbort` is what a wait settles with when its run is stopped. */
  constructor(onAbort: T) {
    this.onAbort = onAbort;
  }

  /** Waits for the answer to the card `entryId`. Aborting settles it with the fallback. */
  wait(entryId: string, signal: AbortSignal): Promise<T> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(this.onAbort);
      const abort = () => {
        this.pending.delete(entryId);
        resolve(this.onAbort);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(entryId, (value) => {
        signal.removeEventListener("abort", abort);
        this.pending.delete(entryId);
        resolve(value);
      });
    });
  }

  /** Whether a card is still waiting for its answer. */
  has(entryId: string): boolean {
    return this.pending.has(entryId);
  }

  /** Returns false when there's no pending card with that id. */
  answer(entryId: string, value: T): boolean {
    const settle = this.pending.get(entryId);
    if (!settle) return false;
    settle(value);
    return true;
  }
}
