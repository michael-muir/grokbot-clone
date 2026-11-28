// Secrets a user gives a bot (#20): kept in the OS keychain per bot and name, handed to the bot's commands as
// environment variables, and cut out of anything that goes back to the model or the transcript. Values never go to
// files, logs, error messages or model context.
import { Entry } from "@napi-rs/keyring";

/** A secret's name, which is also its environment variable: upper case, digits and _, 2 to 64 characters. */
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
export const MAX_SECRET_LENGTH = 10_000;
/** Shorter values aren't redacted: "a" or "123" would mangle ordinary output and hide nothing worth hiding. */
const MIN_REDACTED = 4;

/** Names a secret can't take: it would break the bot's commands or reach into the app's own environment. */
const RESERVED = new Set([
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SHELL",
  "PWD",
  "GATEWAY_TOKEN",
  "GATEWAY_URL",
  "DATA_DIR",
  "NODE_OPTIONS",
  "NODE_PATH",
  // Read by shells and loaders before a command runs: a secret here would run code nobody approved.
  "BASH_ENV",
  "ENV",
  "ZDOTDIR",
  "PROMPT_COMMAND",
  "IFS",
  "PS4",
  "SHELLOPTS",
  "BASHOPTS",
  "PSMODULEPATH",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PERL5OPT",
  "RUBYOPT",
  // Windows' own.
  "SYSTEMDRIVE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PUBLIC",
]);

/** Prefixes of loader variables (LD_PRELOAD, DYLD_INSERT_LIBRARIES…) and the app's own. */
const RESERVED_PREFIXES = ["LD_", "DYLD_", "CLAUDE"];

/** Why a name can't be used, or undefined when it can. */
export function secretNameProblem(name: unknown): string | undefined {
  if (typeof name !== "string" || !SECRET_NAME.test(name)) {
    return "A secret's name must be 2 to 64 upper-case letters, digits or _, starting with a letter, like GITHUB_TOKEN.";
  }
  if (RESERVED.has(name) || RESERVED_PREFIXES.some((p) => name.startsWith(p))) {
    return `${name} is reserved; pick another name.`;
  }
  return undefined;
}

/** Replaces every value in `text` with "[secret NAME]", longest first so one value inside another can't leak. */
export function redact(text: string, secrets: Readonly<Record<string, string>>): string {
  const pairs = Object.entries(secrets)
    .filter(([, value]) => value.length >= MIN_REDACTED)
    .sort(([, a], [, b]) => b.length - a.length);
  let out = text;
  for (const [name, value] of pairs) out = out.split(value).join(`[secret ${name}]`);
  return out;
}

export interface SecretStore {
  get(account: string): string | undefined;
  set(account: string, value: string): void;
  delete(account: string): void;
}

export class SecretStoreUnavailableError extends Error {}

const SERVICE = "smarty-prompts-bot-secrets";

/** The OS keychain. Errors say what failed, never with the value. */
export class KeychainSecretStore implements SecretStore {
  private readonly service: string;

  constructor(service = SERVICE) {
    this.service = service;
  }

  get(account: string): string | undefined {
    try {
      return new Entry(this.service, account).getPassword() ?? undefined;
    } catch (err) {
      console.warn(`Couldn't read a bot secret (${account}) from the OS keychain. (${message(err)})`);
      return undefined;
    }
  }

  set(account: string, value: string): void {
    try {
      new Entry(this.service, account).setPassword(value);
    } catch (err) {
      throw new SecretStoreUnavailableError(`Couldn't save the secret in the OS keychain: ${message(err)}`);
    }
  }

  delete(account: string): void {
    try {
      new Entry(this.service, account).deletePassword();
    } catch (err) {
      throw new SecretStoreUnavailableError(`Couldn't remove a secret from the OS keychain: ${message(err)}`);
    }
  }
}

export class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  /** Tests set this to see how a failing keychain is handled. */
  unavailable = false;

  get(account: string): string | undefined {
    return this.values.get(account);
  }

  set(account: string, value: string): void {
    if (this.unavailable) throw new SecretStoreUnavailableError("Couldn't save the secret in the OS keychain: locked");
    this.values.set(account, value);
  }

  delete(account: string): void {
    this.values.delete(account);
  }
}

/** One bot's secrets by name, on a store. Which names a bot has is kept on the bot (`Bot.secretNames`). */
export class BotSecrets {
  private readonly store: SecretStore;

  constructor(store: SecretStore) {
    this.store = store;
  }

  set(botId: string, name: string, value: string): void {
    this.store.set(account(botId, name), value);
  }

  delete(botId: string, name: string): void {
    this.store.delete(account(botId, name));
  }

  /** The values of these names that the store still has. */
  all(botId: string, names: readonly string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of names) {
      const value = this.store.get(account(botId, name));
      if (value !== undefined) out[name] = value;
    }
    return out;
  }
}

const account = (botId: string, name: string) => `${botId}/${name}`;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
