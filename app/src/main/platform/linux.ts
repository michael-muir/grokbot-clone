// Linux behavior.
import type { Platform } from "./types.ts";

export const linux: Platform = {
  quitWhenAllWindowsClosed: true,
  reopenOnActivate: false,
  menuBar: "auto-hide",
};
