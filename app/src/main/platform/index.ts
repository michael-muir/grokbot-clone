// Picks the Platform for the OS the app runs on. Other systems get the Linux behavior.
import { linux } from "./linux.ts";
import { mac } from "./mac.ts";
import type { Platform } from "./types.ts";
import { windows } from "./win.ts";

export type { Platform };

export function platformFor(os: NodeJS.Platform = process.platform): Platform {
  if (os === "win32") return windows;
  if (os === "darwin") return mac;
  return linux;
}
