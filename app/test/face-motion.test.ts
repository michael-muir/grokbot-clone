// Bot face motion: the blink's rhythm and shape, where the eyes look, and which runs earn a reaction.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BLINK,
  BLINK_FRAMES,
  blinkDelay,
  type Frame,
  GAZE,
  gaze,
  POKES,
  phaseMs,
  reactions,
  SURPRISED_SCALE,
} from "../src/renderer/src/shell/face-motion.ts";

test("motion: blinks come every 2.8 to 6.5 s and take about a quarter second", () => {
  assert.equal(blinkDelay(0), 2800);
  assert.equal(blinkDelay(1), 6500);
  assert.equal(BLINK.durationMs, 260);
});

function scaleY(f: Frame): number {
  const m = f.transform.match(/^scaleY\(([\d.]+)\)$/);
  assert.ok(m, f.transform);
  return Number(m[1]);
}

test("motion: a blink closes, holds, opens past fully and settles", () => {
  const offsets = BLINK_FRAMES.map((f) => f.offset);
  assert.deepEqual(
    offsets,
    [...offsets].sort((a, b) => a - b),
  );
  assert.equal(offsets[0], 0);
  assert.equal(offsets.at(-1), 1);
  const ys = BLINK_FRAMES.map(scaleY);
  assert.equal(ys[0], 1);
  assert.equal(ys.at(-1), 1);
  assert.ok(Math.min(...ys) <= 0.15, "the lids close");
  assert.ok(Math.max(...ys) > 1, "the eyes overshoot as they open");
});

test("motion: the eyes look toward the pointer, eased, within their limit", () => {
  const center = { x: 100, y: 100 };
  assert.deepEqual(gaze(center, { x: 102, y: 101 }, 0), [0, 0], "a pointer on the face doesn't move them");
  const [farX, farY] = gaze(center, { x: 1000, y: 100 }, 0);
  assert.equal(farX, GAZE.maxUnits);
  assert.equal(farY, 0);
  const [, down] = gaze(center, { x: 100, y: 400 }, 0);
  assert.equal(down, GAZE.maxUnits, "down the screen is down in the face");
  const near = gaze(center, { x: 160, y: 100 }, 0)[0];
  const mid = gaze(center, { x: 220, y: 100 }, 0)[0];
  assert.ok(near > 0 && near < mid && mid < GAZE.maxUnits, "further pointers move them further, up to the limit");
  assert.ok(near > (GAZE.maxUnits * 60) / GAZE.reachPx, "eased: quick at first");
  // A face drawn tilted 90° clockwise: a pointer to the right is "up" in its own coordinates.
  const [tx, ty] = gaze(center, { x: 1000, y: 100 }, 90);
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
  for (const sel of [".avatar .avatar-face", ".avatar .avatar-tilt", ".avatar .avatar-eyes", ".avatar .avatar-eye"]) {
    assert.ok(block.includes(sel), `${sel} is stilled`);
  }
  assert.match(block, /animation: none;\s*transition: none;/);
});
