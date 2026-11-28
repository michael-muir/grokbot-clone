// What differs between operating systems. Each OS has one file implementing this; nothing else checks the OS.
export interface Platform {
  /** Quit when the last window closes. macOS apps keep running in the Dock instead. */
  quitWhenAllWindowsClosed: boolean;
  /** Open a new window when the app is activated with none open (clicking the Dock icon on macOS). */
  reopenOnActivate: boolean;
  /**
   * Hide the window's menu bar, as the reference does. Its shortcuts still work. macOS shows menus in the system bar
   * instead, so it has no bar to hide.
   */
  hideMenuBar: boolean;
}
