// Both themes are readable (#24): WCAG contrast of text, icons and the focus ring on every surface, the user bubble
// never worse than today, and the window's own background equal to the theme's app color.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { WINDOW_BACKGROUND } from "../src/main/window-theme.ts";

const css = readFileSync(new URL("../src/renderer/src/theme/tokens.css", import.meta.url), "utf8");

function declared(text: string, selector: string): Map<string, string> {
  const start = text.indexOf(`${selector} {`);
  assert.ok(start >= 0, `tokens.css has a ${selector} block`);
  let depth = 0;
  let end = start;
  for (let i = text.indexOf("{", start); i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  const body = text.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1] ?? "", (m[2] ?? "").trim());
  return out;
}

const dark = declared(css, ":root");
const lightAt = css.indexOf("prefers-color-scheme: light");
assert.ok(lightAt >= 0, "tokens.css has a light block");
const light = new Map([...dark, ...declared(css.slice(lightAt), ":root")]);
const themes = [
  ["dark", dark],
  ["light", light],
] as const;

type Rgba = [number, number, number, number];

function color(value: string | undefined, theme: Map<string, string>): Rgba {
  const v = (value ?? "").trim();
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) return color(theme.get(ref[1] ?? ""), theme);
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = Number.parseInt(hex[1] ?? "", 16);
    return [n >> 16, (n >> 8) & 255, n & 255, 1];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)\s*(?:[/,]\s*([\d.]+%?))?\s*\)$/.exec(v);
  if (rgb) {
    const a = rgb[4] === undefined ? 1 : rgb[4].endsWith("%") ? Number.parseFloat(rgb[4]) / 100 : Number(rgb[4]);
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), a];
  }
  throw new Error(`can't read the color ${v}`);
}

const over = (fg: Rgba, bg: Rgba): Rgba => [
  fg[0] * fg[3] + bg[0] * (1 - fg[3]),
  fg[1] * fg[3] + bg[1] * (1 - fg[3]),
  fg[2] * fg[3] + bg[2] * (1 - fg[3]),
  1,
];
const luminance = (c: Rgba) => {
  const [r, g, b] = [c[0], c[1], c[2]].map((x) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
};
const ratio = (a: Rgba, b: Rgba) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

/** The contrast of `fg` on `bg`, each composited as the app draws it (over the app background). */
function contrast(theme: Map<string, string>, fg: string, bg: string): number {
  const app = color(theme.get("--color-app"), theme);
  const back = over(color(theme.get(bg), theme), app);
  return ratio(over(color(theme.get(fg), theme), back), back);
}

const SURFACES = ["--color-app", "--color-surface", "--color-sidebar", "--color-surface-hover"];

test("theme: text, icons and the focus ring meet WCAG contrast in both themes", () => {
  const low: string[] = [];
  const need = (theme: string, map: Map<string, string>, fg: string, bg: string, min: number) => {
    const r = contrast(map, fg, bg);
    if (r < min) low.push(`${theme}: ${fg} on ${bg} is ${r.toFixed(2)}, needs ${min}`);
  };
  for (const [name, map] of themes) {
    for (const bg of SURFACES) {
      for (const fg of [
        "--color-text",
        "--color-text-soft",
        "--color-text-secondary",
        "--color-link",
        "--color-danger-text",
      ]) {
        need(name, map, fg, bg, 4.5);
      }
      for (const fg of ["--color-icon", "--color-text-tertiary", "--color-focus-ring"]) need(name, map, fg, bg, 3);
    }
    need(name, map, "--color-on-accent", "--color-accent", 4.5);
    need(name, map, "--color-on-contrast", "--color-contrast", 4.5);
  }
  assert.deepEqual(low, []);
});

test("theme: the user bubble's text never gets less readable than today", () => {
  // The bubble and its text as tokens.css defines them: color-mix(bot N%, black), and the text color (the white
  // bot's is its own). The bot colors and these are the same in both themes.
  const FLOOR = 3.4; // amber, the default, as measured from the reference
  const bots = declared(css, "[data-bot-color]");
  const mix = /color-mix\(in srgb, var\(--bot\) (\d+)%, black\)/.exec(bots.get("--color-user-bubble") ?? "");
  assert.ok(mix, "the user bubble is a mix of the bot color with black");
  const share = Number(mix[1]) / 100;
  const textOn = (key: string) =>
    color(
      key === "--color-bot-white"
        ? declared(css, '[data-bot-color="white"]').get("--color-on-user-bubble")
        : dark.get("--color-on-user-bubble"),
      dark,
    );
  for (const key of [...dark.keys()].filter((k) => k.startsWith("--color-bot-"))) {
    const bot = color(dark.get(key), dark);
    const bubble: Rgba = [bot[0] * share, bot[1] * share, bot[2] * share, 1];
    const r = ratio(textOn(key), bubble);
    assert.ok(r >= FLOOR, `${key}: ${r.toFixed(2)} < ${FLOOR}`);
  }
});

test("theme: the window background is the theme's app color", () => {
  assert.equal(dark.get("--color-app")?.split(" ")[0], WINDOW_BACKGROUND.dark);
  assert.equal(light.get("--color-app")?.split(" ")[0], WINDOW_BACKGROUND.light);
});

test("light theme: a white bot turns black with white eyes, readable on every light surface", () => {
  const rule = declared(css.slice(lightAt), '.avatar[data-bot-color="white"]');
  assert.equal(rule.get("--bot"), "var(--color-contrast)");
  assert.equal(rule.get("--color-on-bot"), "var(--color-on-contrast)");
  const body = color(rule.get("--bot"), light);
  const eyes = color(rule.get("--color-on-bot"), light);
  assert.ok(ratio(eyes, body) >= 4.5, "the eyes stand out from the body");
  for (const surface of ["--color-app", "--color-sidebar", "--color-surface", "--color-surface-hover"]) {
    const back = color(light.get(surface), light);
    assert.ok(ratio(body, back) >= 3, `the body reads on ${surface}`);
  }
  assert.equal(
    css.slice(0, lightAt).includes('.avatar[data-bot-color="white"]'),
    false,
    "dark mode keeps the white bot white",
  );
});
