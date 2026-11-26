// App settings: parsing a stored file, checking changes from the renderer, and the store on disk.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SettingsStore } from "../src/main/settings.ts";
import { checkSettingsPatch, DEFAULT_SETTINGS, parseSettings } from "../src/shared/settings.ts";

test("settings: a missing or bad file gives the defaults, field by field", () => {
  assert.deepEqual(parseSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings("nonsense"), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings({ theme: "dark", spellcheck: "yes", extra: 1 }), {
    ...DEFAULT_SETTINGS,
    theme: "dark",
  });
  assert.deepEqual(parseSettings({ theme: "purple" }).theme, "system");
});

test("settings: a change from the renderer must have known keys and valid values", () => {
  assert.deepEqual(checkSettingsPatch({ theme: "light" }), { theme: "light" });
  assert.deepEqual(checkSettingsPatch({ sendWithCtrlEnter: true, spellcheck: false }), {
    sendWithCtrlEnter: true,
    spellcheck: false,
  });
  assert.equal(checkSettingsPatch({ theme: "purple" }), undefined);
  assert.equal(checkSettingsPatch({ spellcheck: 1 }), undefined);
  assert.equal(checkSettingsPatch({ apiKey: "x" }), undefined, "unknown keys are refused");
  // As it arrives from IPC or JSON: an own "__proto__" key, refused like any unknown key.
  assert.equal(checkSettingsPatch(JSON.parse('{"__proto__":{"theme":"dark"}}')), undefined);
  assert.equal(checkSettingsPatch(null), undefined);
});

test("settings store: defaults when there's no file, saves changes, reloads them, survives a bad file", () => {
  const dir = mkdtempSync(join(tmpdir(), "grokbot-settings-"));
  try {
    const file = join(dir, "nested", "settings.json");
    const store = new SettingsStore(file);
    assert.deepEqual(store.get(), DEFAULT_SETTINGS);
    assert.deepEqual(store.set({ theme: "light" }).theme, "light");
    assert.equal(new SettingsStore(file).get().theme, "light", "a new store reads what was saved");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).theme, "light");

    writeFileSync(file, "{ not json");
    assert.deepEqual(new SettingsStore(file).get(), DEFAULT_SETTINGS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
