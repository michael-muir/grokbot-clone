// Avatar names the theme and the drawings know (`--color-bot-*` and `[data-bot-color]` in theme/tokens.css; the
// shapes in shell/Avatar.tsx). The lists are the gateway's; a test keeps the colors and the theme file in step.
import { AVATAR_COLORS, AVATAR_SHAPES, type AvatarColor, type AvatarShape } from "../../../../server/src/types.ts";

export const BOT_COLORS = AVATAR_COLORS;

export type BotColor = AvatarColor;

const isBotColor = (v: string): v is BotColor => (BOT_COLORS as readonly string[]).includes(v);
const isShape = (v: string): v is AvatarShape => (AVATAR_SHAPES as readonly string[]).includes(v);

/** A bot's color for `data-bot-color`; names the theme doesn't know show the default. */
export const botColor = (color: string): BotColor => (isBotColor(color) ? color : "amber");

/** A bot's shape; names from before shapes existed (or unknown ones) draw as a circle. */
export const botShape = (shape: string): AvatarShape => (isShape(shape) ? shape : "circle");
