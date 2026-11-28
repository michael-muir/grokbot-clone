// What differs between operating systems. Each OS has one file implementing this; nothing else checks the OS.
export interface Platform {
  /** Quit when the last window closes. macOS apps keep running in the Dock instead. */
  quitWhenAllWindowsClosed: boolean;
  /** Open a new window when the app is activated with none open (clicking the Dock icon on macOS). */
  reopenOnActivate: boolean;
  /**
   * The window's menu bar, which the reference doesn't show. "hidden": never shown, its shortcuts still work (checked
   * on Windows). "auto-hide": out of sight until Alt, for Linux, where a hidden bar's shortcuts may not fire (GTK).
   * "system": macOS shows menus in the system bar, so there's no bar in the window.
   */
  menuBar: "hidden" | "auto-hide" | "system";
}
