// Model lists, kept for a while: some providers (Codex, Cursor) start a whole CLI to list their models, which takes
// seconds, so the model picker reads a recent list instead of asking every time it opens.
import type { ProviderRegistry } from "./providers/index.ts";
import type { ProviderId } from "./types.ts";

/** How long a list stays fresh enough for the picker. */
export const MODEL_LIST_TTL_MS = 10 * 60_000;
/** How long one load may take. */
const LOAD_TIMEOUT_MS = 15_000;

export class ModelLists {
  private readonly providers: ProviderRegistry;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly kept = new Map<string, { models: string[]; at: number }>();
  private readonly loading = new Map<string, Promise<string[]>>();
  /** Bumped by forget(): a load started before it doesn't store its list. */
  private readonly generation = new Map<ProviderId, number>();

  constructor(providers: ProviderRegistry, ttlMs = MODEL_LIST_TTL_MS, now: () => number = Date.now) {
    this.providers = providers;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /**
   * The provider's models. With `cached`, a list loaded in the last TTL will do; otherwise it's asked again. Asks
   * made while a list is loading share that load. A failed load isn't kept.
   */
  get(id: ProviderId, opts: { baseUrl?: string; cached?: boolean } = {}): Promise<string[]> {
    const provider = this.providers.get(id);
    if (!provider?.listModels) return Promise.reject(new Error("This provider doesn't list its models"));
    const key = `${id}\n${opts.baseUrl ?? ""}`;
    const kept = this.kept.get(key);
    if (opts.cached && kept && this.now() - kept.at < this.ttlMs) return Promise.resolve(kept.models);
    const inFlight = this.loading.get(key);
    if (inFlight) return inFlight;
    const started = this.generation.get(id) ?? 0;
    const load = provider
      .listModels(AbortSignal.timeout(LOAD_TIMEOUT_MS), opts.baseUrl)
      .then((models) => {
        if ((this.generation.get(id) ?? 0) === started) this.kept.set(key, { models, at: this.now() });
        return models;
      })
      .finally(() => {
        if (this.loading.get(key) === load) this.loading.delete(key);
      });
    this.loading.set(key, load);
    return load;
  }

  /** Forgets a provider's lists: a new key can change what it offers. */
  forget(id: ProviderId): void {
    this.generation.set(id, (this.generation.get(id) ?? 0) + 1);
    for (const key of [...this.kept.keys()]) if (key.startsWith(`${id}\n`)) this.kept.delete(key);
    // A load already running was for the old key: the next ask starts a new one.
    for (const key of [...this.loading.keys()]) if (key.startsWith(`${id}\n`)) this.loading.delete(key);
  }

  /** Loads lists in the background, so the picker has them when it opens. Failures are only logged. */
  warm(ids: readonly ProviderId[]): void {
    for (const id of ids) {
      if (this.providers.get(id)?.info?.().configured === false) continue;
      this.get(id).catch((err: unknown) =>
        console.warn(`Couldn't load the ${id} models ahead of time: ${err instanceof Error ? err.message : err}`),
      );
    }
  }
}
