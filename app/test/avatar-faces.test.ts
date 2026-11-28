// Bot faces: each fits its square and its eyes sit on its body and stand out against every bot color.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AVATAR_SHAPES } from "../../server/src/types.ts";
import {
  EYE,
  eyeRects,
  FACES,
  type Face,
  type Part,
  type Point,
  STROKE,
  VIEW,
} from "../src/renderer/src/shell/avatar-faces.ts";
import { GAZE, SURPRISED_SCALE } from "../src/renderer/src/shell/face-motion.ts";

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

/** Distance from p to the segment a–b. */
function toSegment([px, py]: Point, [ax, ay]: Point, [bx, by]: Point): number {
  const [dx, dy] = [bx - ax, by - ay];
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** On the body as drawn: the fill plus up to `grow` of its outline stroke. */
function onDrawnBody(p: Point, face: Face, grow: number): boolean {
  return onBody(p, face) || face.parts.some((part) => nearPart(p, part, grow));
}

function nearPart(p: Point, part: Part, grow: number): boolean {
  switch (part.kind) {
    case "circle":
      return Math.hypot(p[0] - part.cx, p[1] - part.cy) <= part.r + grow;
    case "rect":
      return (
        p[0] >= part.x - grow &&
        p[0] <= part.x + part.width + grow &&
        p[1] >= part.y - grow &&
        p[1] <= part.y + part.height + grow
      );
    case "polygon":
      return part.points.some((a, i) => {
        const b = part.points[(i + 1) % part.points.length] ?? a;
        return toSegment(p, a, b) <= grow;
      });
  }
}

/** Corners and edge midpoints of an eye `e`, moved by (dx, dy), grown by `scale`, slanted as drawn (EYE.slant). */
function eyePoints(e: { x: number; y: number; width: number; height: number }, scale = 1, dx = 0, dy = 0): Point[] {
  const c: Point = [e.x + e.width / 2 + dx, e.y + e.height / 2 + dy];
  const [hw, hh] = [(e.width * scale) / 2, (e.height * scale) / 2];
  const out: Point[] = [];
  for (const fx of [-1, 0, 1])
    for (const fy of [-1, 0, 1]) out.push(turn([c[0] + fx * hw, c[1] + fy * hh], EYE.slant, c));
  return out;
}

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
      for (const [x, y] of eyePoints(e))
        assert.ok(onBody([x, y], face), `${shape}: eye point ${x},${y} is off the body`);
    }
  }
});

test("faces: the eyes stay on the body while they look around, also wide open", () => {
  // From rest, the furthest they look (GAZE.maxUnits) in eight directions, at normal size and grown
  // (SURPRISED_SCALE).
  const directions = Array.from({ length: 8 }, (_, i) => (i * Math.PI) / 4);
  for (const shape of AVATAR_SHAPES) {
    const face = FACES[shape];
    for (const scale of [1, SURPRISED_SCALE]) {
      for (const a of directions) {
        const dx = Math.cos(a) * GAZE.maxUnits;
        const dy = Math.sin(a) * GAZE.maxUnits;
        for (const e of eyeRects(face)) {
          for (const [x, y] of eyePoints(e, scale, dx, dy)) {
            // At least one unit of the bot's color stays around a moving eye.
            assert.ok(
              onDrawnBody([x, y], face, STROKE / 2 - 1),
              `${shape}: at scale ${scale}, looking ${a.toFixed(2)}, ${x},${y} is off`,
            );
          }
        }
      }
    }
  }
});

test("faces: a hovered bot's eyes fit in the middle of its body, wide open (it turns to look at you)", () => {
  for (const shape of AVATAR_SHAPES) {
    const face = FACES[shape];
    const front: Point = [face.pivot[0] - face.eyes[0], face.pivot[1] - face.eyes[1]];
    for (const e of eyeRects(face, front)) {
      for (const [x, y] of eyePoints(e, SURPRISED_SCALE)) {
        assert.ok(onDrawnBody([x, y], face, STROKE / 2 - 1), `${shape}: facing you, ${x},${y} is off the body`);
      }
    }
  }
});

test("faces: at rest every bot faces up and to the right on screen, as in the reference", () => {
  for (const shape of AVATAR_SHAPES) {
    const face = FACES[shape];
    assert.ok(face.tilt < 0, `${shape} leans back (counterclockwise), not forward`);
    // Where the eyes sit relative to the body's middle, as drawn on screen (turned by the tilt).
    const [x, y] = turn(face.eyes, face.tilt, face.pivot);
    const [dx, dy] = [x - face.pivot[0], y - face.pivot[1]];
    assert.ok(dx > 0.25 && dy < -0.25, `${shape}: the eyes sit ${dx.toFixed(2)}, ${dy.toFixed(2)} from the middle`);
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
