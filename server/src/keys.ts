// API keys for providers: kept in the OS keychain (Windows Credential Manager, macOS Keychain, Linux Secret
// Service), with the provider's environment variable as a fallback. Keys never go to files, logs or responses.
import { Entry } from "@napi-rs/keyring";
import type { KeySource, ProviderId } from "./types.ts";

export type { KeySource };

const SERVICE = "smarty-prompts";
/** Earlier service names. A key found under one is moved to SERVICE the first time it's read. */
const LEGACY_SERVICES = ["grokbot-clone"];

/** The environment variables each provider's key can come from, in order. Providers not listed take no key. */
export const KEY_ENV: Partial<Record<ProviderId, string[]>> = {
  claude: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  xai: ["XAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  // Local servers work without a key, but take one when they sit behind an auth proxy.
  ollama: ["OLLAMA_API_KEY"],
  lmstudio: ["LMSTUDIO_API_KEY"],
};

const OPTIONAL_KEY: ProviderId[] = ["ollama", "lmstudio"];

/** The provider can use a key (required or optional). */
export const acceptsKey = (provider: ProviderId): boolean => provider in KEY_ENV;
/** The provider can't run without a key. */
export const needsKey = (provider: ProviderId): boolean => acceptsKey(provider) && !OPTIONAL_KEY.includes(provider);

export interface KeyStore {
  get(provider: ProviderId): string | undefined;
  set(provider: ProviderId, key: string): void;
  delete(provider: ProviderId): void;
}

export class KeyStoreUnavailableError extends Error {}

export class KeychainKeyStore implements KeyStore {
  /** Failures already logged, so a missing keychain doesn't flood the log but a new kind of failure still shows. */
  private readonly logged = new Set<string>();
  private readonly service: string;

  private readonly legacy: readonly string[];

  /**
   * `service` is the keychain entry's service name; tests use their own so they never touch real keys.
   * `legacy` lists older service names whose keys are moved over on first read.
   */
  constructor(service = SERVICE, legacy: readonly string[] = service === SERVICE ? LEGACY_SERVICES : []) {
    this.service = service;
    this.legacy = legacy;
  }

  get(provider: ProviderId): string | undefined {
    try {
      return new Entry(this.service, provider).getPassword() ?? this.moveLegacy(provider);
    } catch (err) {
      // E.g. no Secret Service on a Linux server, or access denied: fall back to env, and say so (never the key).
      const reason = message(err);
      const seen = `${provider}: ${reason}`;
      if (!this.logged.has(seen)) {
        this.logged.add(seen);
        console.warn(
          `Couldn't read the ${provider} key from the OS keychain; using the environment instead. (${reason})`,
        );
      }
      return undefined;
    }
  }

  set(provider: ProviderId, key: string): void {
    try {
      new Entry(this.service, provider).setPassword(key);
    } catch (err) {
      throw new KeyStoreUnavailableError(`Couldn't save the key in the OS keychain: ${message(err)}`);
    }
  }

  delete(provider: ProviderId): void {
    try {
      new Entry(this.service, provider).deletePassword();
    } catch (err) {
      throw new KeyStoreUnavailableError(`Couldn't remove the key from the OS keychain: ${message(err)}`);
    }
    // A removed key must not come back from an old name that was never read.
    for (const old of this.legacy) removeQuietly(old, provider);
  }

  /** A key still under an old service name: copied to the current one, then removed from the old. */
  private moveLegacy(provider: ProviderId): string | undefined {
    for (const old of this.legacy) {
      const key = new Entry(old, provider).getPassword();
      if (!key) continue;
      new Entry(this.service, provider).setPassword(key);
      removeQuietly(old, provider);
      return key;
    }
    return undefined;
  }
}

/** Removes a keychain entry if it's there; a missing one is fine. */
function removeQuietly(service: string, provider: ProviderId): void {
  try {
    new Entry(service, provider).deletePassword();
  } catch {
    // Nothing stored under that name (the usual case), or the keychain refused: either way nothing to undo.
  }
}

export class MemoryKeyStore implements KeyStore {
  private readonly keys = new Map<ProviderId, string>();

  get(provider: ProviderId): string | undefined {
    return this.keys.get(provider);
  }

  set(provider: ProviderId, key: string): void {
    this.keys.set(provider, key);
  }

  delete(provider: ProviderId): void {
    this.keys.delete(provider);
  }
}

/** Where providers get their keys: the key store first, then the environment. Read on every call, never cached. */
export class Credentials {
  private readonly store: KeyStore;
  private readonly env: NodeJS.ProcessEnv;

  constructor(store: KeyStore, env: NodeJS.ProcessEnv = process.env) {
    this.store = store;
    this.env = env;
  }

  key(provider: ProviderId): string | undefined {
    return this.lookup(provider)?.key;
  }

  source(provider: ProviderId): KeySource | undefined {
    return this.lookup(provider)?.source;
  }

  /** The variable a user can set instead of saving a key, for error messages. */
  envName(provider: ProviderId): string | undefined {
    return KEY_ENV[provider]?.[0];
  }

  set(provider: ProviderId, key: string): void {
    this.store.set(provider, key);
  }

  delete(provider: ProviderId): void {
    this.store.delete(provider);
  }

  private lookup(provider: ProviderId): { key: string; source: KeySource } | undefined {
    const names = KEY_ENV[provider];
    if (!names) return undefined;
    const stored = this.store.get(provider);
    if (stored) return { key: stored, source: "keychain" };
    for (const name of names) {
      const value = this.env[name];
      if (value) return { key: value, source: "env" };
    }
    return undefined;
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
