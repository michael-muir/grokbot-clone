// The first-run flow's decisions: provider order, when to ask for a key, the model step, and bot names.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderId, ProviderSummary } from "../../server/src/types.ts";
import {
  allowsDefaultModel,
  canContinue,
  checkBotName,
  firstModel,
  firstProvider,
  MAX_BOT_NAME,
  needsKey,
  showKeyField,
  usableProviders,
} from "../src/renderer/src/onboarding/onboarding-state.ts";

const p = (id: ProviderId, over: Partial<ProviderSummary> = {}): ProviderSummary => ({
  id,
  label: id,
  local: false,
  configured: false,
  needsKey: true,
  keySource: null,
  ...over,
});

const claude = p("claude", { needsKey: false, configured: true });
const openai = p("openai");
const xai = p("xai", { configured: true, keySource: "keychain" });
const ollama = p("ollama", { local: true, needsKey: false, configured: true });
const codex = p("codex", { needsKey: false, configured: false }); // a placeholder: nothing to set up yet

test("onboarding: only usable providers are offered, in the gateway's order", () => {
  assert.deepEqual(
    usableProviders([codex, openai, ollama, claude]).map((x) => x.id),
    ["openai", "ollama", "claude"],
  );
});

test("onboarding: the bot's own provider comes first, then one already set up, then the first usable", () => {
  assert.equal(firstProvider([openai, xai, claude], "claude"), "claude");
  assert.equal(firstProvider([codex, openai, xai], "codex"), "xai", "a placeholder is never preselected");
  assert.equal(firstProvider([codex, openai], "codex"), "openai");
  assert.equal(firstProvider([codex], "codex"), undefined);
});

test("onboarding: the key field shows only for a keyed provider without a key", () => {
  assert.equal(needsKey(openai), true);
  assert.equal(needsKey(xai), false, "already has a key");
  assert.equal(needsKey(ollama), false);
  assert.equal(needsKey(claude), false);
});

test("onboarding: after a failed test, a saved key can be replaced", () => {
  assert.equal(showKeyField(xai, false), false, "a saved key that works isn't asked for again");
  assert.equal(showKeyField(xai, true), true, "the saved key may be wrong");
  assert.equal(showKeyField(openai, false), true);
  assert.equal(showKeyField(ollama, true), false, "no key to fix on a local server");
});

test("onboarding: the model step needs a test, and a model where there's no default", () => {
  assert.equal(firstModel(["a", "b"], "b"), "b");
  assert.equal(firstModel(["a", "b"], "gone"), "", "a model the provider no longer lists isn't kept");
  assert.equal(firstModel([], undefined), "");

  assert.equal(allowsDefaultModel(ollama), true);
  assert.equal(allowsDefaultModel(claude), true);
  assert.equal(allowsDefaultModel(xai), false);

  assert.equal(canContinue(ollama, false, ""), false, "not tested yet");
  assert.equal(canContinue(ollama, true, ""), true);
  assert.equal(canContinue(xai, true, ""), false, "a hosted provider needs a model named");
  assert.equal(canContinue(xai, true, "grok-4"), true);
});

test("onboarding: a bot name is trimmed, and can't be empty or too long", () => {
  assert.deepEqual(checkBotName("  Sunny "), { ok: true, name: "Sunny" });
  assert.equal(checkBotName("   ").ok, false);
  assert.equal(checkBotName("x".repeat(MAX_BOT_NAME)).ok, true);
  assert.equal(checkBotName("x".repeat(MAX_BOT_NAME + 1)).ok, false);
});
