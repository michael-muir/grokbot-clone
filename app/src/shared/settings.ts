// App settings (not per bot): their shape, defaults, and validation. Shared by main (which stores and applies
// them) and the renderer (which edits them). Pure, so it's tested without Electron.

export type ThemeSetting = "system" | "light" | "dark";

export interface AppSettings {
  theme: ThemeSetting;
  spellcheck: boolean;
  /** Ctrl+Enter (⌘+Enter on macOS) sends; Enter alone starts a new line. */
  sendWithCtrlEnter: boolean;
  /** Applied at startup only. */
  hardwareAcceleration: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  spellcheck: true,
  sendWithCtrlEnter: false,
  hardwareAcceleration: true,
};

const THEMES: readonly ThemeSetting[] = ["system", "light", "dark"];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Checks one field; undefined when the value doesn't fit. */
function field<K extends keyof AppSettings>(key: K, value: unknown): AppSettings[K] | undefined {
  if (key === "theme") return (THEMES.includes(value as ThemeSetting) ? value : undefined) as AppSettings[K];
  return (typeof value === "boolean" ? value : undefined) as AppSettings[K];
}

/** A stored file's contents, field by field: anything missing or invalid falls back to its default. */
export function parseSettings(raw: unknown): AppSettings {
  const out: AppSettings = { ...DEFAULT_SETTINGS };
  if (!isRecord(raw)) return out;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
    const value = field(key, raw[key]);
    if (value !== undefined) (out as unknown as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** A change sent from the renderer. Undefined unless every key is known and every value valid. */
export function checkSettingsPatch(v: unknown): Partial<AppSettings> | undefined {
  if (!isRecord(v)) return undefined;
  const out: Partial<AppSettings> = {};
  for (const [key, value] of Object.entries(v)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, key)) return undefined;
    const checked = field(key as keyof AppSettings, value);
    if (checked === undefined) return undefined;
    (out as Record<string, unknown>)[key] = checked;
  }
  return out;
}
