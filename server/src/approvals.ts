// Pending approval cards: a provider asks, the user answers through the API.
import type { ApprovalDecision } from "./types.ts";

interface Pending {
  resolve: (decision: ApprovalDecision) => void;
}

export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();
  /** Answers that arrived before anyone was waiting (the card was posted, but wait() hadn't started yet). */
  private readonly early = new Map<string, ApprovalDecision>();

  /** Wait for the user's answer to the approval card `entryId`. Aborting denies it. */
  wait(entryId: string, signal: AbortSignal): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      const answered = this.early.get(entryId);
      if (answered) {
        this.early.delete(entryId);
        return resolve(answered);
      }
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

  /**
   * Answers a card. The caller has already checked the card exists and is pending; if its waiter hasn't started
   * yet, the answer is kept until it does.
   */
  answer(entryId: string, decision: ApprovalDecision): boolean {
    const p = this.pending.get(entryId);
    if (p) p.resolve(decision);
    else this.early.set(entryId, decision);
    return true;
  }
}
