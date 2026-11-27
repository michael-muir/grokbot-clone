// Paths for status labels and approval cards: relative inside the bot's workspace, the real full path outside it.
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_LABEL_PATH = 80;

/** The real location of a path that may not exist yet: its deepest existing ancestor, real, plus the rest. */
function realLocation(path: string): string {
  let existing = path;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(existing), ...rest.reverse());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return path; // nothing on the way up exists: keep it as written
      rest.push(basename(existing));
      existing = parent;
    }
  }
}

/**
 * A relative path is relative to the workspace, as tools treat it. Symlinks are followed, so a link inside the
 * workspace that points out shows where the write would really land (an approval card must not look local when
 * it isn't), and a workspace reached through a link still matches.
 */
export function displayPath(workspaceDir: string, path: string): string {
  const root = realLocation(resolve(workspaceDir));
  const target = realLocation(resolve(root, path));
  const rel = relative(root, target);
  if (rel === "") return ".";
  const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  return outside ? target : rel;
}

/** A path label kept short from the left: the file name, the part that matters, always shows. */
export function labelPath(workspaceDir: string, v: unknown): string {
  if (typeof v !== "string" || !v) return JSON.stringify(v ?? "");
  const shown = displayPath(workspaceDir, v);
  return shown.length > MAX_LABEL_PATH ? `…${shown.slice(-(MAX_LABEL_PATH - 1))}` : shown;
}
