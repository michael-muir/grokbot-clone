// The bot color names the theme defines (`--color-bot-*` and `[data-bot-color]` in theme/tokens.css). A test
// keeps this list and the theme file in step.
export const BOT_COLORS = [
  "white",
  "brown",
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
  "gray",
] as const;

export type BotColor = (typeof BOT_COLORS)[number];

const isBotColor = (v: string): v is BotColor => (BOT_COLORS as readonly string[]).includes(v);

/** A bot's color for `data-bot-color`; names the theme doesn't know show the default. */
export const botColor = (color: string): BotColor => (isBotColor(color) ? color : "amber");

/** The avatar letter: the first character, emoji and other astral characters kept whole. */
export const initial = (name: string): string => (Array.from(name.trim())[0] ?? "?").toUpperCase();
