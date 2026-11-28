// Windows behavior.
import type { Platform } from "./types.ts";

export const windows: Platform = {
  quitWhenAllWindowsClosed: true,
  reopenOnActivate: false,
  menuBar: "hidden",
};
