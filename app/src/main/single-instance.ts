// One running app: which launches take the single-instance lock, and how the running app comes forward when
// another launch hands over to it.

/** A smoke run checks a real startup, so it never hands over to a running app (that would pass without testing). */
export const takesLock = (argv: readonly string[]): boolean => !argv.includes("--smoke");

export interface FrontWindow {
  isMinimized(): boolean;
  restore(): void;
  isVisible(): boolean;
  show(): void;
  focus(): void;
}

/** Brings the running window to the user: out of the taskbar or Dock, visible, focused. */
export function bringToFront(win: FrontWindow): void {
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}
