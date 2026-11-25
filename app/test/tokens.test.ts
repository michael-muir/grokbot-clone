// Theme tests: the token file is complete, light covers every themed color, and nothing else in the renderer
// hard-codes colors, type sizes or radii (CLAUDE.md: "Colors, spacing and type come from tokens, never literals").
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
  const selectors = [...tokens.matchAll(/\[data-bot-color="(\w+)"\]/g)].map((m) => m[1]);
  assert.deepEqual([...selectors].sort(), [...palette].sort());
});

function filesIn(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? filesIn(join(dir, d.name), ext) : ext.test(d.name) ? [join(dir, d.name)] : [],
  );
}

const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i;

test("no color, type size or radius literals outside the theme file", () => {
  const problems = new Set<string>();
  for (const file of filesIn(rendererDir, /\.css$/)) {
    if (file === tokensFile) continue;
    const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([\w-]+)\s*:\s*([^;{}]+);/g)) {
      const [, prop = "", value = ""] = m;
      const where = `${relative(rendererDir, file)}: ${prop}: ${value.trim()}`;
      if (COLOR_LITERAL.test(value)) problems.add(where);
      const typed = ["font-size", "line-height", "letter-spacing", "font-weight", "border-radius", "font-family"];
      if (typed.includes(prop) && !/var\(|^\s*(inherit|0|normal)\s*$/.test(value)) problems.add(where);
      // Named and system colors (Canvas, GrayText, red…) bypass the theme just like hex does.
      if (/^(color|background|background-color|border-color|outline-color|fill|stroke)$/.test(prop)) {
        if (!/var\(|^\s*(transparent|currentColor|inherit|none)\s*$/.test(value)) problems.add(where);
      }
    }
  }
  for (const file of filesIn(rendererDir, /\.tsx?$/)) {
    const source = readFileSync(file, "utf8");
    if (COLOR_LITERAL.test(source)) problems.add(`${relative(rendererDir, file)}: color literal`);
    if (/style=\{\{/.test(source)) problems.add(`${relative(rendererDir, file)}: inline style (use a class)`);
  }
  assert.deepEqual([...problems], []);
});
