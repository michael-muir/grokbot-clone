// macOS behavior.
import type { Platform } from "./types.ts";

export const mac: Platform = {
  quitWhenAllWindowsClosed: false,
  reopenOnActivate: true,
  hideMenuBar: false,
};
