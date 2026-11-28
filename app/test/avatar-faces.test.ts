// Bot faces: every shape has one, it fits the 32-unit square once tilted, its eyes sit on the body, and the eyes
// stand out against every bot color.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AVATAR_SHAPES } from "../../server/src/types.ts";
import {
  eyeRects,
  FACES,
  type Face,
  type Part,
  type Point,
  STROKE,
  VIEW,
} from "../src/renderer/src/shell/avatar-faces.ts";

/** A point turned `deg` degrees clockwise around `pivot`, as SVG's rotate() does (y points down). */
function turn([x, y]: Point, deg: number, [px, py]: Point): Point {
  const a = (deg * Math.PI) / 180;
  const dx = x - px;
  const dy = y - py;
  return [px + dx * Math.cos(a) - dy * Math.sin(a), py + dx * Math.sin(a) + dy * Math.cos(a)];
}

/** Circles that cover each part's outline, stroke included: a polygon corner or a rounded corner is a round cap. */
function reach(part: Part): { center: Point; r: number }[] {
  const half = STROKE / 2;
  switch (part.kind) {
    case "polygon":
      return part.points.map((center) => ({ center, r: half }));
    case "circle":
      return [{ center: [part.cx, part.cy], r: part.r + half }];
    case "rect": {
      const { x, y, width, height, rx } = part;
      return [
        [x + rx, y + rx],
        [x + width - rx, y + rx],
        [x + rx, y + height - rx],
        [x + width - rx, y + height - rx],
      ].map(([cx = 0, cy = 0]) => ({ center: [cx, cy] as const, r: rx + half }));
    }
  }
}

function insidePart([x, y]: Point, part: Part): boolean {
  switch (part.kind) {
    case "circle":
      return (x - part.cx) ** 2 + (y - part.cy) ** 2 <= part.r ** 2;
    case "rect":
      return x >= part.x && x <= part.x + part.width && y >= part.y && y <= part.y + part.height;
    case "polygon": {
      let inside = false;
      const pts = part.points;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi = 0, yi = 0] = pts[i] ?? [];
        const [xj = 0, yj = 0] = pts[j] ?? [];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }
  }
}

const onBody = (p: Point, face: Face) => face.parts.some((part) => insidePart(p, part));

test("faces: every shape has a face", () => {
  assert.deepEqual(Object.keys(FACES).sort(), [...AVATAR_SHAPES].sort());
});

test("faces: each body, tilted and stroked, stays inside the square", () => {
  for (const shape of AVATAR_SHAPES) {
    const face = FACES[shape];
    for (const { center, r } of face.parts.flatMap(reach)) {
      const [x, y] = turn(center, face.tilt, face.pivot);
      assert.ok(x - r >= 0 && y - r >= 0 && x + r <= VIEW && y + r <= VIEW, `${shape} reaches past the edge`);
    }
  }
});

test("faces: both eyes sit wholly on the body, side by side", () => {
  for (const shape of AVATAR_SHAPES) {
    const face = FACES[shape];
    const eyes = eyeRects(face);
    assert.equal(eyes.length, 2);
    const [left, right] = eyes;
    assert.ok(left && right && left.x + left.width < right.x, `${shape}: the eyes don't overlap`);
    for (const e of eyes) {
      // Corners and edge midpoints: the eyes are small enough that these settle it.
      const xs = [e.x, e.x + e.width / 2, e.x + e.width];
      const ys = [e.y, e.y + e.height / 2, e.y + e.height];
      for (const x of xs)
        for (const y of ys) assert.ok(onBody([x, y], face), `${shape}: eye point ${x},${y} is off the body`);
    }
  }
});

/** WCAG relative luminance of a #rrggbb color. */
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

test("faces: the eyes stand out against every bot color (3:1, WCAG non-text contrast)", () => {
  const tokens = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "renderer", "src", "theme", "tokens.css"),
    "utf8",
  );
  const value = (name: string) => tokens.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  const eye = value("--color-on-bot");
  assert.ok(eye, "--color-on-bot is a #rrggbb color");
  const colors = [...tokens.matchAll(/--color-bot-(\w+):\s*(#[0-9a-f]{6})/gi)];
  assert.ok(colors.length >= 11);
  for (const [, name, hex = ""] of colors) {
    const [hi, lo] = [luminance(hex), luminance(eye)].sort((a, b) => b - a);
    const ratio = ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
    assert.ok(ratio >= 3, `eyes on ${name}: ${ratio.toFixed(2)}:1`);
  }
});
