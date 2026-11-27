// The visual-review checklist: every scene is distinct, and each named reference shot is in the repo.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SCENES } from "../src/main/review-fixtures.ts";

/** id → file in reference/screens, or null when that screen has no reference shot. */
const EXPECTED: Readonly<Record<string, string | null>> = {
  welcome: "03-onb1.png",
  "onboarding-model": "04-onb2.png",
  "onboarding-name": null,
  chat: "06-main-welcome.png",
  sidebar: "07-sidebar.png",
  thread: "12-main-full.png",
  choice: null,
  panel: "30-panel-activity.png",
  "bot-menu": "39-sidebar-ctx.png",
  "settings-general": "23-settings-General.png",
  "settings-models": null,
};

test("review scenes: every id is unique and every reference shot exists", () => {
  const ids = SCENES.map((scene) => scene.id);
  assert.deepEqual(ids, Object.keys(EXPECTED));
  assert.equal(new Set(ids).size, ids.length);
  const screens = join(process.cwd(), "..", "reference", "screens");
  for (const scene of SCENES) {
    assert.ok(scene.title.length > 0, scene.id);
    assert.ok(scene.start.length > 0, scene.id);
    assert.ok(scene.until.length > 0, scene.id);
    assert.equal(scene.reference, EXPECTED[scene.id], scene.id);
    if (scene.reference) assert.equal(existsSync(join(screens, scene.reference)), true, scene.reference);
  }
});
