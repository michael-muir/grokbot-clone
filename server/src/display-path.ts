// Paths for status labels and approval cards: relative inside the bot's workspace, so "Writing hello.txt"; the
// full path outside it, so the user notices the bot reaching beyond its computer.
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Lexical only (a label never touches the disk). A relative path is relative to the workspace, as tools treat it. */
export function displayPath(workspaceDir: string, path: string): string {
  const root = resolve(workspaceDir);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === "") return ".";
  const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  return outside ? target : rel;
}
