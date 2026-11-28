// Brings bot faces to life in this window: eyes that follow the pointer over a bot, a busier sway while it works,
// and a reaction when its run ends. It changes the DOM directly, so none of this re-renders React.
import type { BotActivity } from "../../../../../server/src/types.ts";
import type { Face } from "./avatar-faces.ts";
import { type Frame, gaze, POKES, type Poke, phaseMs, reactions } from "./face-motion.ts";

interface Live {
  el: HTMLElement;
  botId: string;
}

/** The idle sway's period; the CSS animation lasts as long (`--duration-face-idle`, checked by a test). */
const SWAY_MS = 4000;

const lives = new Set<Live>();
const working = new Set<string>();

/** Reduced motion turns all of it off; the CSS stops the sway and transitions under the same query. */
const still = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const livesFor = (botId: string) => [...lives].filter((l) => l.botId === botId);

/**
 * Makes `el` (an `.avatar` drawing `face`) a live face of `botId`. Every copy of one bot reacts together. Returns the
 * function that stops it.
 *
 * As in the reference, a bot's eyes follow the pointer only while it's over the bot (or the control it sits in): then
 * the bot turns to face you (styles.css) and watches the pointer move across it.
 */
export function liven(el: HTMLElement, botId: string, face: Face): () => void {
  const { tilt, pivot, eyes } = face;
  const live: Live = { el, botId };
  lives.add(live);
  // For turning to face you: the tilt, the point it turns around, and how far the eyes move from rest to the middle
  // of the body. SVG px are face units.
  el.style.setProperty("--face-tilt", `${tilt}deg`);
  el.style.setProperty("--face-pivot", `${pivot[0]}px ${pivot[1]}px`);
  el.style.setProperty("--face-front-x", `${round(pivot[0] - eyes[0])}px`);
  el.style.setProperty("--face-front-y", `${round(pivot[1] - eyes[1])}px`);
  el.style.setProperty("--face-phase", `-${phaseMs(botId, SWAY_MS)}ms`);
  el.dataset.motion = working.has(botId) ? "working" : "idle";
  setGaze(el, 0, 0);

  const zone = el.closest<HTMLElement>("button, [role='button']") ?? el;
  const move = (e: PointerEvent) => {
    if (still()) return setGaze(el, 0, 0);
    const r = el.getBoundingClientRect();
    const z = zone.getBoundingClientRect();
    // Facing you, the bot is upright: no tilt to undo. Its eyes reach their limit at the zone's edge.
    const [x, y] = gaze(
      { x: r.left + r.width / 2, y: r.top + r.height / 2 },
      { x: e.clientX, y: e.clientY },
      0,
      Math.max(z.width, z.height) / 2,
    );
    setGaze(el, x, y);
  };
  const leave = () => setGaze(el, 0, 0);
  zone.addEventListener("pointermove", move, { passive: true });
  zone.addEventListener("pointerleave", leave);
  return () => {
    lives.delete(live);
    zone.removeEventListener("pointermove", move);
    zone.removeEventListener("pointerleave", leave);
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

function setGaze(el: HTMLElement, x: number, y: number): void {
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
