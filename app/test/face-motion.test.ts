// Bot face motion: where the eyes look while the pointer is over a bot, and which runs earn a reaction.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type Frame,
  GAZE,
  gaze,
  POKES,
  phaseMs,
  reactions,
  SURPRISED_SCALE,
} from "../src/renderer/src/shell/face-motion.ts";

test("motion: over a bot, the eyes follow the pointer, eased, up to their limit at the control's edge", () => {
  const center = { x: 100, y: 100 };
  const reach = 30; // half the control
  assert.deepEqual(gaze(center, { x: 101, y: 101 }, 0, reach), [0, 0], "a pointer on the middle doesn't move them");
  const [edgeX, edgeY] = gaze(center, { x: 130, y: 100 }, 0, reach);
  assert.equal(edgeX, GAZE.maxUnits);
  assert.equal(edgeY, 0);
  const [, down] = gaze(center, { x: 100, y: 140 }, 0, reach);
  assert.equal(down, GAZE.maxUnits, "down the screen is down in the face, and it stops at the limit");
  const near = gaze(center, { x: 108, y: 100 }, 0, reach)[0];
  const mid = gaze(center, { x: 118, y: 100 }, 0, reach)[0];
  assert.ok(near > 0 && near < mid && mid < GAZE.maxUnits, "further moves them further, up to the limit");
  assert.ok(near > (GAZE.maxUnits * 8) / reach, "eased: quick at first");
  // A face drawn tilted 90° clockwise: a pointer to the right is "up" in its own coordinates.
  const [tx, ty] = gaze(center, { x: 200, y: 100 }, 90, reach);
  assert.ok(Math.abs(tx) < 0.01 && Math.abs(ty + GAZE.maxUnits) < 0.01, `${tx},${ty}`);
});
test("motion: a run that finishes celebrates, one that fails droops, others don't react", () => {
  const before = [
    { botId: "a", running: true },
    { botId: "b", running: true },
    { botId: "c", running: true },
    { botId: "d", running: false, lastRun: "finished" as const },
  ];
  const now = [
    { botId: "a", running: false, lastRun: "finished" as const },
    { botId: "b", running: false, lastRun: "failed" as const },
    { botId: "c", running: false, lastRun: "interrupted" as const },
    { botId: "d", running: false, lastRun: "finished" as const },
    { botId: "e", running: false, lastRun: "finished" as const },
  ];
  assert.deepEqual(reactions(before, now), [
    { botId: "a", poke: "celebrate" },
    { botId: "b", poke: "droop" },
  ]);
  assert.deepEqual(reactions(now, now), [], "no change, no reaction");
  assert.deepEqual(reactions(before, []), [], "a lost connection isn't a finished run");
});

test("motion: reactions interpolate (same functions every frame) and end where they began", () => {
  for (const [name, { frames, durationMs }] of Object.entries(POKES)) {
    assert.ok(durationMs > 0 && durationMs <= 2000, `${name} is short`);
    const fns = (f: Frame) => f.transform.match(/[a-zA-Z]+(?=\()/g)?.join(" ");
    const first = frames[0];
    const last = frames.at(-1);
    assert.ok(first && last);
    for (const f of frames) assert.equal(fns(f), fns(first), `${name}: ${f.transform}`);
    assert.equal(first.offset, 0);
    assert.equal(last.offset, 1);
    // A full turn looks the same as none.
    assert.equal(last.transform.replace("360deg", "0deg"), first.transform, `${name} ends at rest`);
  }
});

test("motion: every bot has its own sway phase, the same each time", () => {
  assert.equal(phaseMs("nova", 4000), phaseMs("nova", 4000));
  assert.notEqual(phaseMs("nova", 4000), phaseMs("rex", 4000));
  for (const id of ["nova", "rex", "a", ""]) {
    const p = phaseMs(id, 4000);
    assert.ok(p >= 0 && p < 4000);
  }
});

test("motion: the CSS and the code agree on the shared numbers", () => {
  const tokens = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "renderer", "src", "theme", "tokens.css"),
    "utf8",
  );
  const director = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "renderer", "src", "shell", "face-director.ts"),
    "utf8",
  );
  assert.equal(Number(tokens.match(/--face-surprised-scale:\s*([\d.]+)/)?.[1]), SURPRISED_SCALE);
  assert.equal(
    Number(tokens.match(/--duration-face-idle:\s*(\d+)ms/)?.[1]),
    Number(director.match(/const SWAY_MS = (\d+);/)?.[1]),
  );
});

test("motion: reduced motion stops the sway and the eye transitions", () => {
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "renderer", "src", "styles.css"),
    "utf8",
  );
  const block = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
  for (const sel of [
    ".avatar[data-live][data-motion] .avatar-face",
    ".avatar[data-live] .avatar-tilt",
    ".avatar .avatar-eyes",
    ".avatar .avatar-eye",
  ]) {
    assert.ok(block.includes(sel), `${sel} is stilled`);
  }
  assert.match(block, /animation: none;\s*transition: none;/);
});
