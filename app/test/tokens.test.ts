// Theme tests: the token file is complete, light covers every themed color, and nothing else in the renderer
// hard-codes colors, type sizes or radii (CLAUDE.md: "Colors, spacing and type come from tokens, never literals").
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BOT_COLORS, botColor, botShape } from "../src/renderer/src/bot-colors.ts";

const rendererDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "renderer");
const tokensFile = join(rendererDir, "src", "theme", "tokens.css");
const tokens = readFileSync(tokensFile, "utf8");

/** Custom properties declared in the first block that opens with `selector {`. */
function declared(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} block exists`);
  let depth = 0;
  let end = start;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  const body = css.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1] ?? "", (m[2] ?? "").trim());
  return out;
}

const dark = declared(tokens, ":root");
const light = declared(tokens.slice(tokens.indexOf("prefers-color-scheme: light")), ":root");

test("the theme file has every token group", () => {
  const groups = ["--color-", "--font-sans", "--text-", "--tracking-", "--space-", "--radius-", "--shadow-"];
  for (const group of [...groups, "--duration-", "--ease-", "--size-"]) {
    assert.ok(
      [...dark.keys()].some((k) => k.startsWith(group)),
      `missing ${group}* tokens`,
    );
  }
  // Every type size has its paired line height.
  for (const key of dark.keys()) {
    if (/^--text-[\w-]+$/.test(key) && !key.includes("--line-height")) {
      assert.ok(dark.has(`${key}--line-height`), `${key} has no line height`);
    }
  }
});

test("the light theme overrides every themed color", () => {
  // The same in both themes: the bot palette, the text on a user bubble, the star.
  const shared = (k: string) =>
    k.startsWith("--color-bot-") || ["--color-on-bot", "--color-on-user-bubble", "--color-star"].includes(k);
  const missing = [...dark.keys()].filter((k) => k.startsWith("--color-") && !shared(k) && !light.has(k));
  assert.deepEqual(missing, []);
  const extra = [...light.keys()].filter((k) => !dark.has(k));
  assert.deepEqual(extra, [], "light declares only tokens that exist in dark");
});

test("every bot color has a selector, and every selector a color", () => {
  const palette = [...dark.keys()].filter((k) => k.startsWith("--color-bot-")).map((k) => k.slice(12));
  // A color may have more than one rule (white has a light-theme avatar rule too): each counts once.
  const selectors = new Set([...tokens.matchAll(/\[data-bot-color="(\w+)"\]/g)].map((m) => m[1]));
  assert.deepEqual([...selectors].sort(), [...palette].sort());
});

function filesIn(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? filesIn(join(dir, d.name), ext) : ext.test(d.name) ? [join(dir, d.name)] : [],
  );
}

test("the bot colors in code are exactly the theme's", () => {
  const palette = [...dark.keys()].filter((k) => k.startsWith("--color-bot-")).map((k) => k.slice(12));
  assert.deepEqual([...BOT_COLORS].sort(), palette.sort());
  assert.equal(botColor("violet"), "amber", "unknown names fall back to the default");
  assert.equal(botShape("star"), "star");
  assert.equal(botShape("blob"), "circle", "shapes from before #16 draw as a circle");
});

const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i;
/** Properties whose values may hold a color, including shorthands. */
const COLOR_PROP =
  /^(color|background(-color)?|border(-(top|right|bottom|left))?(-color)?|outline(-color)?|box-shadow|text-shadow|fill|stroke|caret-color|accent-color|text-decoration(-color)?|column-rule(-color)?)$/;
/** Words a color-bearing value may contain besides var(): styles and keywords, never a color name. */
const NON_COLOR_WORDS = new Set([
  "solid",
  "dashed",
  "dotted",
  "double",
  "none",
  "inset",
  "transparent",
  "currentcolor",
  "inherit",
  "initial",
  "unset",
  "auto",
  "calc",
  "underline",
]);
const TYPE_PROP = /^(font|font-size|font-family|font-weight|line-height|letter-spacing|border(-[\w-]+)?-radius)$/;
const stripVars = (value: string) => value.replace(/var\([^()]*\)/g, " ");

/** Why a declaration breaks the token rule, or undefined when it's fine. */
function literalProblem(prop: string, value: string): string | undefined {
  if (COLOR_LITERAL.test(value)) return "color literal";
  const rest = stripVars(value);
  // Spacing, sizes and type all come from tokens: no pixel values written by hand.
  if (/\d*\.?\d+px\b/.test(rest)) return "px literal";
  if (TYPE_PROP.test(prop) && !/var\(/.test(value) && !/^\s*(inherit|0|normal)\s*$/.test(value)) {
    return "type or radius literal";
  }
  // Named and system colors (red, Canvas, GrayText…) bypass the theme just like hex does.
  if (COLOR_PROP.test(prop)) {
    const words = rest.toLowerCase().match(/[a-z][a-z-]*/g) ?? [];
    if (words.some((w) => !NON_COLOR_WORDS.has(w))) return "named color";
  }
  return undefined;
}

test("the literal check catches what it should and passes what it should", () => {
  const caught = [
    ["border", "1px solid red"],
    ["outline", "2px solid Highlight"],
    ["font", "14px serif"],
    ["padding", "8px 16px"],
    ["box-shadow", "0 0 0 1px black"],
    ["background", "#fff"],
    ["color", "GrayText"],
    ["border-radius", "3px"],
  ];
  for (const [prop = "", value = ""] of caught) assert.ok(literalProblem(prop, value), `${prop}: ${value}`);
  const fine = [
    ["border", "var(--size-hairline) solid var(--color-line)"],
    ["outline", "none"],
    ["padding", "0 var(--space-4)"],
    ["max-height", "calc(var(--text-chat--line-height) * 8)"],
    ["background", "transparent"],
    ["letter-spacing", "inherit"],
    ["height", "100vh"],
  ];
  for (const [prop = "", value = ""] of fine) assert.equal(literalProblem(prop, value), undefined, `${prop}: ${value}`);
});

test("no color, spacing, type or radius literals outside the theme file", () => {
  const problems = new Set<string>();
  for (const file of filesIn(rendererDir, /\.css$/)) {
    if (file === tokensFile) continue;
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // A declaration ends at ";" or at the "}" closing its rule (the last one may have no ";").
    for (const m of css.matchAll(/([\w-]+)\s*:\s*([^;{}]+?)\s*(?=[;}])/g)) {
      const [, prop = "", value = ""] = m;
      const problem = literalProblem(prop, value);
      if (problem) problems.add(`${relative(rendererDir, file)}: ${prop}: ${value} (${problem})`);
    }
  }
  for (const file of filesIn(rendererDir, /\.tsx?$/)) {
    const source = readFileSync(file, "utf8");
    if (COLOR_LITERAL.test(source)) problems.add(`${relative(rendererDir, file)}: color literal`);
    if (/style=\{\{/.test(source)) problems.add(`${relative(rendererDir, file)}: inline style (use a class)`);
  }
  assert.deepEqual([...problems], []);
});
