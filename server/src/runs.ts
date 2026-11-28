// Rules about runs that both the gateway and the app's rows apply, so the Resume button shows exactly when the
// gateway would accept it. Pure, with no Node APIs, so the renderer can import it.
import type { TranscriptEntry } from "./types.ts";

/**
 * Whether a cut-off run is still the one to resume (#22): the latest run of its conversation (ignoring failed
 * attempts to resume it), with no fresh start since.
 */
export function isLatestCutOff(entries: readonly TranscriptEntry[], cut: TranscriptEntry): boolean {
  let latest: TranscriptEntry | undefined;
  let resetAfter = false;
  for (const e of entries) {
    if (e.hidden || e.threadId !== cut.threadId) continue;
    const b = e.body;
    if (b.kind === "notice" && b.reset && e.seq > cut.seq) resetAfter = true;
    if (b.kind !== "run") continue;
    if (b.resumes === cut.id && b.state === "failed") continue;
    latest = e;
  }
  return latest?.id === cut.id && !resetAfter;
}
