// Globals the preload adds to the renderer.
import type { DesktopApi } from "../../shared/ipc.ts";

declare global {
  interface Window {
    desktop: DesktopApi;
  }
}
