// The first-run flow's decisions as pure functions: which providers to offer and which comes first, when to ask
// for a key, which model to preselect, when the model step is complete, and what makes a bot name.
import type { ProviderId, ProviderSummary } from "../../../../../server/src/types.ts";
import { isPlaceholder } from "../settings/settings-state.ts";

export const MAX_BOT_NAME = 40;

/** Providers the user can pick now, in the gateway's order. */
export const usableProviders = (list: readonly ProviderSummary[]): ProviderSummary[] =>
  list.filter((p) => !isPlaceholder(p));

/** The bot's own provider if it can be used, else one that's already set up, else the first usable one. */
export function firstProvider(list: readonly ProviderSummary[], current: ProviderId): ProviderId | undefined {
  const usable = usableProviders(list);
  return usable.find((p) => p.id === current)?.id ?? usable.find((p) => p.configured)?.id ?? usable[0]?.id;
}

/** The key field shows when the provider takes a key and doesn't have one yet. */
export const needsKey = (p: ProviderSummary): boolean => p.needsKey && !p.configured;

/** Shown when a key is missing, and after a failed test: the saved key may be the problem. */
export const showKeyField = (p: ProviderSummary, testFailed: boolean): boolean =>
  p.needsKey && (!p.configured || testFailed);

/**
 * "Default" works only where something picks a model without being told: Claude's own default, or a local server's
 * first installed model. Hosted OpenAI-compatible and Gemini providers need a model named.
 */
export const allowsDefaultModel = (p: ProviderSummary): boolean => p.local || p.id === "claude";

/** The bot's model if the provider lists it, else "" (Default, or "choose one" where there's no default). */
export const firstModel = (models: readonly string[], current: string | undefined): string =>
  current && models.includes(current) ? current : "";

/** The model step is complete once the provider answered and there's a model, or a default that works. */
export const canContinue = (p: ProviderSummary, tested: boolean, model: string): boolean =>
  tested && (model !== "" || allowsDefaultModel(p));

export function checkBotName(typed: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = typed.trim();
  if (name === "") return { ok: false, error: "Give your bot a name." };
  if (name.length > MAX_BOT_NAME) return { ok: false, error: `Keep it to ${MAX_BOT_NAME} characters or fewer.` };
  return { ok: true, name };
}
