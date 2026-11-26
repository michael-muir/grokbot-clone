// Stores the app settings as JSON in the user-data folder. A missing or damaged file gives the defaults; writes go
// through a temporary file, so a crash mid-write can't leave half a file.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type AppSettings, parseSettings } from "../shared/settings.ts";

export class SettingsStore {
  private readonly file: string;
  private current: AppSettings;

  constructor(file: string) {
    this.file = file;
    this.current = SettingsStore.load(file);
  }

  get(): AppSettings {
    return this.current;
  }

  /** Applies an already-checked change and saves it. Returns the full settings. */
  set(patch: Partial<AppSettings>): AppSettings {
    this.current = { ...this.current, ...patch };
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.current, null, 2)}\n`);
    renameSync(temp, this.file);
    return this.current;
  }

  private static load(file: string): AppSettings {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`Couldn't read ${file}; using defaults`, err);
      return parseSettings(undefined);
    }
    try {
      return parseSettings(JSON.parse(text));
    } catch (err) {
      console.warn(`${file} isn't valid JSON; using defaults`, err);
      return parseSettings(undefined);
    }
  }
}
