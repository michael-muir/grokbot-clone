// Pending approval cards: a provider asks, the user answers through the API.
import type { ApprovalDecision } from "./types.ts";

interface Pending {
  resolve: (decision: ApprovalDecision) => void;
}

export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();

  /** Wait for the user's answer to the approval card `entryId`. Aborting denies it. */
  wait(entryId: string, signal: AbortSignal): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve({ allow: false, reason: "The run was stopped." });
      const onAbort = () => {
        this.pending.delete(entryId);
        resolve({ allow: false, reason: "The run was stopped." });
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(entryId, {
        resolve: (decision) => {
          signal.removeEventListener("abort", onAbort);
          this.pending.delete(entryId);
          resolve(decision);
        },
      });
    });
  }

  /** Returns false when there's no pending card with that id. */
  answer(entryId: string, decision: ApprovalDecision): boolean {
    const p = this.pending.get(entryId);
    if (!p) return false;
    p.resolve(decision);
    return true;
  }
}
