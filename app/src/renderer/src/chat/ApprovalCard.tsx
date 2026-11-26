// The approval card: the bot asks before a tool acts, the user allows it or denies it with an optional reason.
// Laid out like the reference's choice cards (prompt, then lettered choices).
import { type FormEvent, type KeyboardEvent, useRef, useState } from "react";
import type { EntryBody } from "../../../../../server/src/types.ts";

type Approval = Extract<EntryBody, { kind: "approval" }>;

export function ApprovalCard({
  body,
  answer,
}: {
  body: Approval;
  /** Sends the decision; rejects when the gateway refuses it. */
  answer(allow: boolean, reason?: string): Promise<unknown>;
}) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const denyButton = useRef<HTMLButtonElement>(null);

  const send = async (allow: boolean, why?: string) => {
    if (sending) return;
    setSending(true);
    try {
      await answer(allow, why);
    } catch {
      // The caller shows the error. The card stays as it was, so the user can try again.
    } finally {
      setSending(false);
    }
  };

  const cancelDeny = () => {
    setDenying(false);
    setReason("");
    // Put focus back where the user started, not on the page.
    requestAnimationFrame(() => denyButton.current?.focus());
  };

  const submitDeny = (e: FormEvent) => {
    e.preventDefault();
    void send(false, reason.trim() || undefined);
  };

  const onReasonKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cancelDeny();
    }
  };

  return (
    <section className="card" aria-label={`Permission request: ${body.tool}`}>
      <p className="card-prompt">Allow {body.tool}?</p>
      {body.summary && (
        <p className="card-detail">
          <code className="card-code">{body.summary}</code>
        </p>
      )}
      {body.state !== "pending" ? (
        <p className="card-result" data-state={body.state}>
          {resultText(body)}
        </p>
      ) : denying ? (
        <form className="deny-form" onSubmit={submitDeny}>
          <input
            className="deny-reason"
            aria-label="Reason for denying (optional)"
            placeholder="Tell the bot why (optional)"
            value={reason}
            // biome-ignore lint/a11y/noAutofocus: the user just chose Deny; the reason field is the next step.
            autoFocus
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={onReasonKey}
          />
          <button type="submit" className="button primary" disabled={sending}>
            Deny
          </button>
          <button type="button" className="button secondary" onClick={cancelDeny}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="choices">
          <button type="button" className="choice" disabled={sending} onClick={() => void send(true)}>
            <span className="key-cap" aria-hidden="true">
              A
            </span>
            Allow
          </button>
          <button type="button" className="choice" ref={denyButton} disabled={sending} onClick={() => setDenying(true)}>
            <span className="key-cap" aria-hidden="true">
              B
            </span>
            Deny
          </button>
        </div>
      )}
    </section>
  );
}

function resultText(body: Approval): string {
  switch (body.state) {
    case "approved":
      return "Allowed";
    case "denied":
      return body.reason ? `Denied: ${body.reason}` : "Denied";
    case "expired":
      return "Expired";
    case "pending":
      return "Waiting";
  }
}
