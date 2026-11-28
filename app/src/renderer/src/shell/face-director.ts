// Brings bot faces to life in this window: blinks, eyes that follow the pointer, a busier sway while a bot works,
// and a reaction when its run ends. It changes the DOM directly, so none of this re-renders React.
import type { BotActivity } from "../../../../../server/src/types.ts";
import type { Face } from "./avatar-faces.ts";
import {
  BLINK,
  BLINK_FRAMES,
  blinkDelay,
  type Frame,
  GAZE,
  gaze,
  POKES,
  type Poke,
  phaseMs,
  reactions,
} from "./face-motion.ts";

interface Live {
  el: HTMLElement;
  botId: string;
  tilt: number;
}

/** The idle sway's period; the CSS animation lasts as long (`--duration-face-idle`). */
const SWAY_MS = 4000;

const lives = new Set<Live>();
const blinkTimers = new Map<string, ReturnType<typeof setTimeout>>();
const working = new Set<string>();
let pointer: { x: number; y: number } | null = null;
let aimFrame = 0;
let holdTimer: ReturnType<typeof setTimeout> | undefined;
let stopPointer: (() => void) | undefined;

/** Reduced motion turns all of it off; the CSS stops the sway and transitions under the same query. */
const still = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const livesFor = (botId: string) => [...lives].filter((l) => l.botId === botId);

/**
 * Makes `el` (an `.avatar` drawing `face`) a live face of `botId`. Every copy of one bot blinks and reacts together.
 * Returns the function that stops it.
 */
export function liven(el: HTMLElement, botId: string, face: Face): () => void {
  const { tilt, pivot, eyes } = face;
  const live: Live = { el, botId, tilt };
  lives.add(live);
  // For a hovered bot turning to face you (styles.css): its tilt, the point it turns around, and how far its eyes
  // move from rest to the middle of the body. SVG px are face units.
  el.style.setProperty("--face-tilt", `${tilt}deg`);
  el.style.setProperty("--face-pivot", `${pivot[0]}px ${pivot[1]}px`);
  el.style.setProperty("--face-front-x", `${pivot[0] - eyes[0]}px`);
  el.style.setProperty("--face-front-y", `${pivot[1] - eyes[1]}px`);
  el.style.setProperty("--face-phase", `-${phaseMs(botId, SWAY_MS)}ms`);
  el.dataset.motion = working.has(botId) ? "working" : "idle";
  if (!blinkTimers.has(botId)) scheduleBlink(botId);
  stopPointer ??= followPointer();
  aim(live);
  return () => {
    lives.delete(live);
    if (livesFor(botId).length === 0) {
      clearTimeout(blinkTimers.get(botId));
      blinkTimers.delete(botId);
    }
    if (lives.size === 0) {
      stopPointer?.();
      stopPointer = undefined;
    }
  };
}

function scheduleBlink(botId: string): void {
  const timer = setTimeout(() => {
    blinkTimers.delete(botId);
    const faces = livesFor(botId);
    if (faces.length === 0) return;
    if (!still() && !document.hidden) {
      for (const { el } of faces) {
        el.querySelector(".avatar-eyes")?.animate(keyframes(BLINK_FRAMES), { duration: BLINK.durationMs });
      }
    }
    scheduleBlink(botId);
  }, blinkDelay(Math.random()));
  blinkTimers.set(botId, timer);
}

/** Follows the pointer anywhere in the window; the eyes return to the middle a while after it stops or leaves. */
function followPointer(): () => void {
  const move = (e: PointerEvent) => {
    pointer = { x: e.clientX, y: e.clientY };
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      pointer = null;
      aimAll();
    }, GAZE.holdMs);
    aimFrame ||= requestAnimationFrame(() => {
      aimFrame = 0;
      aimAll();
    });
  };
  const gone = () => {
    pointer = null;
    aimAll();
  };
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  window.addEventListener("pointermove", move, { passive: true });
  window.addEventListener("blur", gone);
  document.documentElement.addEventListener("pointerleave", gone);
  motion.addEventListener("change", gone);
  return () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("blur", gone);
    document.documentElement.removeEventListener("pointerleave", gone);
    motion.removeEventListener("change", gone);
    cancelAnimationFrame(aimFrame);
    aimFrame = 0;
    clearTimeout(holdTimer);
    pointer = null;
  };
}

function aimAll(): void {
  for (const live of lives) aim(live);
}

/** The eyes are drawn at rest (high and right); a gaze moves them from there toward the pointer. */
function aim({ el, tilt }: Live): void {
  let x = 0;
  let y = 0;
  if (pointer && !still()) {
    const r = el.getBoundingClientRect();
    if (r.width > 0) [x, y] = gaze({ x: r.left + r.width / 2, y: r.top + r.height / 2 }, pointer, tilt);
  }
  // SVG lengths in px are user units, so these are face units inside the drawing.
  el.style.setProperty("--gaze-x", `${x}px`);
  el.style.setProperty("--gaze-y", `${y}px`);
}

/** Takes a new activity snapshot: working bots sway faster, and a run that just ended gets its reaction. */
export function noteActivity(before: readonly BotActivity[], now: readonly BotActivity[]): void {
  working.clear();
  for (const bot of now) if (bot.running) working.add(bot.botId);
  for (const live of lives) live.el.dataset.motion = working.has(live.botId) ? "working" : "idle";
  for (const { botId, poke: kind } of reactions(before, now)) poke(botId, kind);
}

export function poke(botId: string, kind: Poke): void {
  if (still()) return;
  const { frames, durationMs } = POKES[kind];
  for (const { el } of livesFor(botId)) {
    el.querySelector(".avatar-face")?.animate(keyframes(frames), { duration: durationMs });
  }
}

/** Our frames as the browser's keyframe type. */
const keyframes = (frames: readonly Frame[]): Keyframe[] => frames.map((f) => ({ ...f }));
