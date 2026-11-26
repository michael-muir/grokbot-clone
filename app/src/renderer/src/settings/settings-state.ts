// The Settings pages' decisions as pure functions: provider hints, key status, model choices, and which providers
// take a server address.
import type { ProviderId, ProviderSummary } from "../../../../../server/src/types.ts";

/** Local servers whose address can be changed (OpenAI-compatible, on this machine or the network). */
const SERVERS: readonly ProviderId[] = ["ollama", "lmstudio"];

export const takesServerAddress = (id: ProviderId): boolean => SERVERS.includes(id);

/** Listed but not usable yet: not local, no key to add, and not set up (Codex, Cursor for now). */
export const isPlaceholder = (p: ProviderSummary): boolean => !p.local && !p.needsKey && !p.configured;

/** The short note after a provider's name in the picker. */
export function providerHint(p: ProviderSummary): string {
  if (isPlaceholder(p)) return "coming later";
  if (p.local) return "local";
  if (p.needsKey && !p.configured) return "needs a key";
  return "";
}

/** Where the provider's key comes from, said plainly. Never includes the key. */
export function keyStatus(p: ProviderSummary): string {
  if (!p.needsKey) return "No key needed";
  if (p.keySource === "keychain") return "Saved in your keychain";
  if (p.keySource === "env") return "From an environment variable";
  return "No key yet";
}

/**
 * The model picker's options: what the provider listed, sorted, plus the bot's current model if the list doesn't
 * have it (so a custom or retired model isn't silently dropped from view).
 */
export function modelChoices(listed: readonly string[], current: string | undefined): string[] {
  const all = new Set(listed);
  if (current) all.add(current);
  return [...all].sort((a, b) => a.localeCompare(b));
}

/** A typed server address, or the reason it isn't one. */
export function checkServerAddress(
  typed: string,
): { ok: true; url: string | undefined } | { ok: false; error: string } {
  const text = typed.trim();
  if (text === "") return { ok: true, url: undefined }; // back to the default
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: "That isn't a web address. Try http://127.0.0.1:11434/v1" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "The address must start with http:// or https://" };
  }
  return { ok: true, url: text.replace(/\/+$/, "") };
}
