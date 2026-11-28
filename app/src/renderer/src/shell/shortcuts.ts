// Keyboard shortcuts (#23): one list for the sheet and the bindings, and what a key press means. Pure, so the
// bindings are tested without a window. "Mod" is ⌘ on macOS and Ctrl elsewhere.

export type ShortcutAction =
  | "search"
  | "new-bot"
  | "go-to-bot"
  | "shortcuts"
  | "focus-chat"
  | "previous-bot"
  | "next-bot"
  | "details";

export interface Shortcut {
  /** The action it runs here, or none when something else handles it (the app menu, the composer). */
  action?: ShortcutAction;
  label: string;
  hint?: string;
  section: "Essentials" | "Chat" | "Navigation" | "Panels" | "Window";
  /** Each alternative is one key combination, like ["Mod", "K"]. */
  keys: string[][];
}

export const SHORTCUTS: readonly Shortcut[] = [
  {
    action: "search",
    label: "Search",
    section: "Essentials",
    keys: [
      ["Mod", "K"],
      ["Mod", "Shift", "F"],
    ],
  },
  { action: "new-bot", label: "New bot", section: "Essentials", keys: [["Mod", "N"]] },
  { label: "Send", hint: "Shift+Enter for a new line", section: "Essentials", keys: [["Enter"]] },
  { action: "go-to-bot", label: "Go to bot", section: "Essentials", keys: [["Mod", "1–9"]] },
  { label: "Settings", section: "Essentials", keys: [["Mod", ","]] },
  { action: "shortcuts", label: "Keyboard shortcuts", section: "Essentials", keys: [["Mod", "/"]] },
  { action: "focus-chat", label: "Focus the message box", section: "Chat", keys: [["Mod", "I"]] },
  { label: "Stop the reply", hint: "In the message box", section: "Chat", keys: [["Esc"]] },
  { action: "previous-bot", label: "Previous bot", section: "Navigation", keys: [["Alt", "↑"]] },
  { action: "next-bot", label: "Next bot", section: "Navigation", keys: [["Alt", "↓"]] },
  { action: "details", label: "Bot details", section: "Panels", keys: [["Mod", "Alt", "B"]] },
  {
    label: "Zoom",
    section: "Window",
    keys: [
      ["Mod", "="],
      ["Mod", "−"],
      ["Mod", "0"],
    ],
  },
  { label: "Full screen", section: "Window", keys: [["F11"]] },
];

export const SECTIONS = ["Essentials", "Chat", "Navigation", "Panels", "Window"] as const;

/** The caps to draw for one combination on this platform. */
export function keyLabels(combo: readonly string[], isMac: boolean): string[] {
  return combo.map((k) => {
    if (k === "Mod") return isMac ? "⌘" : "Ctrl";
    if (k === "Alt") return isMac ? "⌥" : "Alt";
    if (k === "Shift") return isMac ? "⇧" : "Shift";
    return k;
  });
}

/** macOS's full screen is Ctrl+⌘+F, not F11. */
export function platformKeys(s: Shortcut, isMac: boolean): string[][] {
  return isMac && s.label === "Full screen" ? [["Ctrl", "Mod", "F"]] : s.keys;
}

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** What a key press asks for, if anything: an action, and for "go to bot" which one (0-based). */
export function matchShortcut(e: KeyLike, isMac: boolean): { action: ShortcutAction; index?: number } | undefined {
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && !e.altKey) {
    if (!e.shiftKey && key === "k") return { action: "search" };
    if (e.shiftKey && key === "f") return { action: "search" };
    if (!e.shiftKey && key === "n") return { action: "new-bot" };
    if (!e.shiftKey && (key === "/" || e.code === "Slash")) return { action: "shortcuts" };
    if (!e.shiftKey && key === "i") return { action: "focus-chat" };
    // By the physical key too, so Ctrl+1 works on layouts where 1 needs Shift.
    const digit = /^Digit([1-9])$/.exec(e.code ?? "")?.[1] ?? (/^[1-9]$/.test(key) ? key : undefined);
    if (digit && !e.shiftKey) return { action: "go-to-bot", index: Number(digit) - 1 };
  }
  if (mod && e.altKey && !e.shiftKey && (key === "b" || e.code === "KeyB")) return { action: "details" };
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    if (key === "ArrowUp") return { action: "previous-bot" };
    if (key === "ArrowDown") return { action: "next-bot" };
  }
  return undefined;
}

export interface PaletteAction {
  id: "new-bot" | "shortcuts" | "settings" | "models" | "usage" | "start-fresh";
  label: string;
  detail?: string;
}

/** The palette's actions: only what the app can do. */
export function paletteActions(currentBot?: string): PaletteAction[] {
  return [
    { id: "new-bot", label: "New bot" },
    { id: "shortcuts", label: "Keyboard shortcuts", detail: "Help" },
    { id: "settings", label: "Settings", detail: "General" },
    { id: "models", label: "Models & keys", detail: "Settings" },
    { id: "usage", label: "Usage", detail: "Settings" },
    ...(currentBot ? [{ id: "start-fresh" as const, label: "Start fresh", detail: currentBot }] : []),
  ];
}

/** Items whose words all appear (in any case) in their text; everything for an empty query. */
export function filterPalette<T>(items: readonly T[], query: string, text: (item: T) => string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...items];
  return items.filter((item) => {
    const hay = text(item).toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
