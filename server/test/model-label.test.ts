// Model labels (#97): Cursor's bracketed settings read as words in parentheses; the id itself never changes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { listedModels, modelLabel, modelOptions } from "../src/model-label.ts";

test("model labels: settings in brackets show in parentheses, in words", () => {
  assert.equal(
    modelLabel("claude-sonnet-4-5[thinking=true,context=200k]"),
    "claude-sonnet-4-5 (thinking, context 200k)",
  );
  assert.equal(
    modelLabel("claude-haiku-5-5[thinking=true,context=300k,reasoning_effort=high]"),
    "claude-haiku-5-5 (thinking, context 300k, reasoning effort high)",
  );
  assert.equal(
    modelLabel("claude-opus-5-5[context=300k,effort=medium,fast=false]"),
    "claude-opus-5-5 (context 300k, effort medium)",
  );
  assert.equal(modelLabel("composer-2.5[fast=true]"), "composer-2.5 (fast)");
  assert.equal(modelLabel("grok-4.6[]"), "grok-4.6", "no settings: just the name");
  assert.equal(modelLabel("default[]"), "Auto", "Cursor's own choice");
});

test("model labels: any other id shows as it is", () => {
  for (const id of ["gpt-6.2-sol", "llama3.2", "claude-opus-5-5", "models/gemini-4-neon", "odd[id", "a[b]c"]) {
    assert.equal(modelLabel(id), id);
  }
});

test("model labels: Cursor's Auto entry isn't listed, since Default already means it", () => {
  assert.deepEqual(listedModels(["default[]", "grok-4.7[fast=true]", "gpt-5.5"]), ["grok-4.7[fast=true]", "gpt-5.5"]);
});

test("model labels: where two ids would read the same, the picker shows the ids", () => {
  assert.deepEqual(modelOptions(["composer-2.5[]", "composer-2.5[fast=false]", "grok-4.7[fast=true]"]), [
    { value: "composer-2.5[]", label: "composer-2.5[]" },
    { value: "composer-2.5[fast=false]", label: "composer-2.5[fast=false]" },
    { value: "grok-4.7[fast=true]", label: "grok-4.7 (fast)" },
  ]);
});
