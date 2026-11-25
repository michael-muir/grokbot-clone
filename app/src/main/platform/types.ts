// What differs between operating systems. Each OS has one file implementing this; nothing else checks the OS.
export interface Platform {
  /** Quit when the last window closes. macOS apps keep running in the Dock instead. */
  quitWhenAllWindowsClosed: boolean;
  /** Open a new window when the app is activated with none open (clicking the Dock icon on macOS). */
  reopenOnActivate: boolean;
}
