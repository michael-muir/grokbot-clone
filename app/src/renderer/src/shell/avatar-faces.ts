// The bot faces as data: each shape's outline, its lean and where its eyes sit, on a 32-unit square.
import type { AvatarShape } from "../../../../../server/src/types.ts";

export type Point = readonly [number, number];

export type Part =
  | { kind: "polygon"; points: readonly Point[] }
  | { kind: "circle"; cx: number; cy: number; r: number }
  | { kind: "rect"; x: number; y: number; width: number; height: number; rx: number };

export interface Face {
  /** Filled and stroked in the bot's color; together they make the body. */
  parts: readonly Part[];
  /**
   * A lean back, in degrees (negative: counterclockwise) around `pivot`: with the eyes high and right, every bot
   * faces up and to the right, as in the reference.
   */
  tilt: number;
  pivot: Point;
  /** The point between the eyes at rest: high and to the right of the body, as far as fits (see the tests). */
  eyes: Point;
}

export const VIEW = 32;
/** The body's outline, round-joined: it softens every corner, which makes the shapes chunky rather than sharp. */
export const STROKE = 5;
/**
 * Two pills, big enough to read at the 24 px avatar (about 2.5 by 5 px there). Each leans back by `slant` degrees
 * (counterclockwise) on top of the body's tilt, as eyes on a head turned up and to the right do.
 */
export const EYE = { width: 3.4, height: 7, gap: 3, slant: -15 } as const;

/** A regular polygon's corners (or a star's, when `inner` is given), the first one at `startDeg`. */
function corners(sides: number, radius: number, center: Point, startDeg = -90, inner?: number): Point[] {
  const count = inner === undefined ? sides : sides * 2;
  return Array.from({ length: count }, (_, i) => {
    const r = inner !== undefined && i % 2 === 1 ? inner : radius;
    const a = ((startDeg + (360 / count) * i) * Math.PI) / 180;
    return [round(center[0] + r * Math.cos(a)), round(center[1] + r * Math.sin(a))] as const;
  });
}

const round = (n: number) => Math.round(n * 100) / 100;
const polygon = (points: readonly Point[]): Part => ({ kind: "polygon", points });
const circle = (cx: number, cy: number, r: number): Part => ({ kind: "circle", cx, cy, r });

export const FACES: Record<AvatarShape, Face> = {
  circle: { parts: [circle(16, 16, 12.5)], tilt: -12, pivot: [16, 16], eyes: [20.7, 13.2] },
  square: {
    parts: [{ kind: "rect", x: 5.5, y: 5.5, width: 21, height: 21, rx: 4 }],
    tilt: -12,
    pivot: [16, 16],
    eyes: [19.7, 11],
  },
  diamond: { parts: [polygon(corners(4, 12.5, [16, 16]))], tilt: -10, pivot: [16, 16], eyes: [19, 15.5] },
  hexagon: { parts: [polygon(corners(6, 12.5, [16, 16]))], tilt: -8, pivot: [16, 16], eyes: [19.9, 13.5] },
  pentagon: { parts: [polygon(corners(5, 12.5, [16, 17]))], tilt: -10, pivot: [16, 17], eyes: [19.4, 15.2] },
  octagon: { parts: [polygon(corners(8, 12.5, [16, 16], -67.5))], tilt: -10, pivot: [16, 16], eyes: [20.5, 14] },
  // A broad wedge pointing right: leaning back, it points up and ahead, like something on its way.
  triangle: {
    parts: [
      polygon([
        [27.5, 14],
        [5.5, 5.5],
        [7.5, 27],
      ]),
    ],
    tilt: -12,
    pivot: [13, 15.5],
    eyes: [14.6, 15],
  },
  // A plump star: its inner corners sit well out, so the eyes fit and the points stay soft.
  star: { parts: [polygon(corners(5, 12.5, [16, 16.5], -90, 8.5))], tilt: -12, pivot: [16, 16.5], eyes: [18.2, 15] },
  flower: {
    parts: [...corners(5, 6.5, [16, 16]).map(([x, y]) => circle(x, y, 6)), circle(16, 16, 8)],
    tilt: -10,
    pivot: [16, 16],
    eyes: [20.5, 13.8],
  },
  cloud: {
    parts: [
      circle(10.5, 18.5, 6.5),
      circle(21.5, 18.5, 6.5),
      circle(16, 13, 8),
      { kind: "rect", x: 4.5, y: 17, width: 23, height: 8.5, rx: 4.25 },
    ],
    tilt: -8,
    pivot: [16, 17],
    eyes: [17.2, 12.5],
  },
  shield: {
    parts: [
      polygon([
        [16, 5],
        [26, 8.5],
        [26, 16],
        [16, 27],
        [6, 16],
        [6, 8.5],
      ]),
    ],
    tilt: -10,
    pivot: [16, 16],
    eyes: [19.3, 12.9],
  },
  drop: {
    parts: [
      circle(16, 18.5, 10),
      polygon([
        [16, 3.5],
        [24.5, 14],
        [7.5, 14],
      ]),
    ],
    tilt: -14,
    pivot: [16, 17],
    eyes: [19.1, 16.6],
  },
};

/** The two eyes as rectangles, left then right, in the face's own (untilted) coordinates, moved by `look`. */
export function eyeRects(face: Face, look: Point = [0, 0]): { x: number; y: number; width: number; height: number }[] {
  const cx = face.eyes[0] + look[0];
  const cy = face.eyes[1] + look[1];
  const half = (EYE.gap + EYE.width) / 2;
  return [cx - half, cx + half].map((x) => ({
    x: round(x - EYE.width / 2),
    y: round(cy - EYE.height / 2),
    width: EYE.width,
    height: EYE.height,
  }));
}
