// Bot face motion as numbers: where a bot's eyes look while the pointer is over it, and its reactions to runs.
import type { BotActivity } from "../../../../../server/src/types.ts";

/** One keyframe for the Web Animations API, kept free of DOM types so tests can read it. */
export interface Frame {
  transform: string;
  offset: number;
  easing?: string;
}

/**
 * While the pointer is over a bot, its eyes follow it: up to `maxUnits` (face units) from the middle, reached at the
 * edge of the bot's control. Within `deadPx` of the middle they stay put. The reference's icons do the same and don't
 * blink (the owner checked); its blinking, window-wide watching mark is the one beside the composer.
 */
export const GAZE = { maxUnits: 1, deadPx: 2 } as const;

/** How much the eyes grow when the pointer is over the bot: a surprised, attentive look. */
export const SURPRISED_SCALE = 1.25;

/**
 * Where the eyes look, in face units, for a pointer at `pointer` and a face centered at `center` (screen pixels),
 * reaching the limit `reachPx` away. Eased so they move a lot at first and settle at the limit; turned back by the
 * face's tilt, since the eyes sit inside the drawing.
 */
export function gaze(
  center: { x: number; y: number },
  pointer: { x: number; y: number },
  tiltDeg: number,
  reachPx: number,
): [number, number] {
  const dx = pointer.x - center.x;
  const dy = pointer.y - center.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= GAZE.deadPx) return [0, 0];
  const e = Math.min(1, distance / Math.max(reachPx, 1));
  const reach = GAZE.maxUnits * e * (2 - e);
  const sx = (dx / distance) * reach;
  const sy = (dy / distance) * reach;
  const a = (-tiltDeg * Math.PI) / 180;
  const round = (n: number) => Math.round(n * 100) / 100 || 0;
  return [round(sx * Math.cos(a) - sy * Math.sin(a)), round(sx * Math.sin(a) + sy * Math.cos(a))];
}

export type Poke = "celebrate" | "droop";

/**
 * One-off reactions, on the whole face. Every frame lists the same transform functions so they interpolate.
 * Celebrate: a full turn, then a hop with squash on take-off and landing. Droop: a short sag and recovery.
 */
export const POKES: Record<Poke, { frames: readonly Frame[]; durationMs: number }> = {
  celebrate: {
    durationMs: 1520,
    frames: [
      { transform: "rotateY(0deg) translateY(0%) scale(1, 1)", offset: 0, easing: "cubic-bezier(0.37, 0, 0.63, 1)" },
      { transform: "rotateY(360deg) translateY(0%) scale(1, 1)", offset: 0.59, easing: "ease-out" },
      {
        transform: "rotateY(360deg) translateY(0%) scale(1.08, 0.9)",
        offset: 0.65,
        easing: "cubic-bezier(0.2, 0.8, 0.4, 1)",
      },
      {
        transform: "rotateY(360deg) translateY(-18%) scale(0.96, 1.06)",
        offset: 0.79,
        easing: "cubic-bezier(0.6, 0, 0.8, 0.4)",
      },
      { transform: "rotateY(360deg) translateY(0%) scale(1.08, 0.9)", offset: 0.92, easing: "ease-out" },
      { transform: "rotateY(360deg) translateY(0%) scale(1, 1)", offset: 1 },
    ],
  },
  droop: {
    durationMs: 900,
    frames: [
      { transform: "rotateY(0deg) translateY(0%) scale(1, 1)", offset: 0, easing: "ease-out" },
      { transform: "rotateY(0deg) translateY(8%) scale(1.04, 0.92)", offset: 0.35 },
      { transform: "rotateY(0deg) translateY(8%) scale(1.04, 0.92)", offset: 0.65, easing: "ease-in-out" },
      { transform: "rotateY(0deg) translateY(0%) scale(1, 1)", offset: 1 },
    ],
  },
};

/** The reactions an activity change calls for: a run that just finished celebrates, one that failed droops. */
export function reactions(
  before: readonly BotActivity[],
  now: readonly BotActivity[],
): { botId: string; poke: Poke }[] {
  const wasRunning = new Set(before.filter((b) => b.running).map((b) => b.botId));
  const out: { botId: string; poke: Poke }[] = [];
  for (const bot of now) {
    if (bot.running || !wasRunning.has(bot.botId)) continue;
    if (bot.lastRun === "finished") out.push({ botId: bot.botId, poke: "celebrate" });
    else if (bot.lastRun === "failed") out.push({ botId: bot.botId, poke: "droop" });
  }
  return out;
}

/** A stable phase per bot, so bots don't sway in step but every copy of one bot does. */
export function phaseMs(botId: string, periodMs: number): number {
  let h = 0;
  for (const c of botId) h = (h * 31 + (c.codePointAt(0) ?? 0)) >>> 0;
  return h % periodMs;
}
