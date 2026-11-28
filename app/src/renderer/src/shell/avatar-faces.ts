// The bot faces: each shape's outline, its lean and where its eyes sit, on a 32-unit square. Plain data, so the
// tests can check that every face fits its shape and the square.
import type { AvatarShape } from "../../../../../server/src/types.ts";

export type Point = readonly [number, number];

export type Part =
  | { kind: "polygon"; points: readonly Point[] }
  | { kind: "circle"; cx: number; cy: number; r: number }
  | { kind: "rect"; x: number; y: number; width: number; height: number; rx: number };

export interface Face {
  /** Filled and stroked in the bot's color; together they make the body. */
  parts: readonly Part[];
  /** A slight lean, in degrees clockwise around `pivot`, so the bots look alive rather than like icons. */
  tilt: number;
  pivot: Point;
  /** The point between the eyes: a little right of the middle, as if the bot glances that way. */
  eyes: Point;
}

export const VIEW = 32;
/** The body's outline, round-joined: it softens every corner, which makes the shapes chunky rather than sharp. */
export const STROKE = 5;
/** Two upright pills, big enough to read at the 24 px avatar (about 2.5 by 5 px there). */
export const EYE = { width: 3.4, height: 7, gap: 3 } as const;

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
  circle: { parts: [circle(16, 16, 12.5)], tilt: -10, pivot: [16, 16], eyes: [17.5, 15] },
  square: {
    parts: [{ kind: "rect", x: 5.5, y: 5.5, width: 21, height: 21, rx: 4 }],
    tilt: 8,
    pivot: [16, 16],
    eyes: [17, 15.5],
  },
  diamond: { parts: [polygon(corners(4, 12.5, [16, 16]))], tilt: 12, pivot: [16, 16], eyes: [17, 16] },
  hexagon: { parts: [polygon(corners(6, 12.5, [16, 16]))], tilt: -6, pivot: [16, 16], eyes: [17, 15.5] },
  pentagon: { parts: [polygon(corners(5, 12.5, [16, 17]))], tilt: 8, pivot: [16, 17], eyes: [17, 17] },
  octagon: { parts: [polygon(corners(8, 12.5, [16, 16], -67.5))], tilt: -8, pivot: [16, 16], eyes: [17, 15.5] },
  // Leans far enough to point ahead, like something on its way.
  triangle: { parts: [polygon(corners(3, 12, [16, 17.5]))], tilt: 24, pivot: [16, 17.5], eyes: [16, 19] },
  // A plump star: its inner corners sit well out, so the eyes fit and the points stay soft.
  star: { parts: [polygon(corners(5, 12.5, [16, 16.5], -90, 8.5))], tilt: 10, pivot: [16, 16.5], eyes: [16.3, 17] },
  flower: {
    parts: [...corners(5, 6.5, [16, 16]).map(([x, y]) => circle(x, y, 6)), circle(16, 16, 8)],
    tilt: 0,
    pivot: [16, 16],
    eyes: [16.8, 16],
  },
  cloud: {
    parts: [
      circle(10.5, 18.5, 6.5),
      circle(21.5, 18.5, 6.5),
      circle(16, 13, 8),
      { kind: "rect", x: 4.5, y: 17, width: 23, height: 8.5, rx: 4.25 },
    ],
    tilt: -6,
    pivot: [16, 17],
    eyes: [17, 18],
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
    tilt: 6,
    pivot: [16, 16],
    eyes: [17, 15],
  },
  drop: {
    parts: [
      circle(16, 19.5, 8.5),
      polygon([
        [16, 4.5],
        [23.6, 15.5],
        [8.4, 15.5],
      ]),
    ],
    tilt: -12,
    pivot: [16, 17],
    eyes: [16.5, 19.5],
  },
};

/** The two eyes as rectangles, left then right, in the face's own (untilted) coordinates. */
export function eyeRects(face: Face): { x: number; y: number; width: number; height: number }[] {
  const [cx, cy] = face.eyes;
  const half = (EYE.gap + EYE.width) / 2;
  return [cx - half, cx + half].map((x) => ({
    x: round(x - EYE.width / 2),
    y: round(cy - EYE.height / 2),
    width: EYE.width,
    height: EYE.height,
  }));
}
