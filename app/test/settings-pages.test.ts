// Settings page logic: provider hints, key status, model choices and server addresses.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderSummary } from "../../server/src/types.ts";
import {
  checkServerAddress,
  isPlaceholder,
  keyStatus,
  modelChoices,
  providerHint,
  takesServerAddress,
} from "../src/renderer/src/settings/settings-state.ts";

const p = (over: Partial<ProviderSummary>): ProviderSummary => ({
  id: "openai",
  label: "OpenAI",
  local: false,
  configured: false,
  needsKey: true,
  keySource: null,
  ...over,
});

test("settings: provider hints and placeholders", () => {
  assert.equal(providerHint(p({})), "needs a key");
  assert.equal(providerHint(p({ configured: true, keySource: "keychain" })), "");
  assert.equal(providerHint(p({ id: "ollama", local: true, needsKey: false, configured: true })), "local");
  const codex = p({ id: "codex", needsKey: false });
  assert.ok(isPlaceholder(codex));
  assert.equal(providerHint(codex), "coming later");
  assert.ok(!isPlaceholder(p({})), "a provider that needs a key isn't a placeholder");
});

test("settings: key status says where the key comes from, never the key", () => {
  assert.equal(keyStatus(p({})), "No key yet");
  assert.equal(keyStatus(p({ keySource: "keychain", configured: true })), "Saved in your keychain");
  assert.equal(keyStatus(p({ keySource: "env", configured: true })), "From an environment variable");
  assert.equal(keyStatus(p({ needsKey: false, local: true })), "No key needed");
});

test("settings: model choices keep the current model even when it isn't listed", () => {
  assert.deepEqual(modelChoices(["b", "a"], undefined), ["a", "b"]);
  assert.deepEqual(modelChoices(["b", "a"], "a"), ["a", "b"]);
  assert.deepEqual(modelChoices([], "my-custom"), ["my-custom"]);
});

test("settings: server addresses", () => {
  assert.ok(takesServerAddress("ollama"));
  assert.ok(!takesServerAddress("openai"));
  assert.deepEqual(checkServerAddress("  http://10.0.0.5:11434/v1/ "), { ok: true, url: "http://10.0.0.5:11434/v1" });
  assert.deepEqual(checkServerAddress(""), { ok: true, url: undefined });
  assert.equal(checkServerAddress("localhost:11434").ok, false);
  assert.equal(checkServerAddress("file:///etc/passwd").ok, false);
});
