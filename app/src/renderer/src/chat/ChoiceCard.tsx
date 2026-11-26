// The choice card: the bot asks a question with lettered choices (the reference's widget card), and with
// allowCustom the user can type their own answer instead.
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { EntryBody } from "../../../../../server/src/types.ts";

type Choice = Extract<EntryBody, { kind: "choice" }>;

const letter = (i: number) => String.fromCharCode(65 + i);

export function ChoiceCard({
  body,
  answer,
}: {
  body: Choice;
  /** Sends the answer; rejects when the gateway refuses it. */
  answer(value: string): Promise<unknown>;
}) {
  const [sending, setSending] = useState(false);
  const card = useRef<HTMLElement>(null);
  const result = useRef<HTMLParagraphElement>(null);
  const [typing, setTyping] = useState(false);
  const [custom, setCustom] = useState("");
  const otherButton = useRef<HTMLButtonElement>(null);
  const pending = body.state === "pending";
  const chosen = body.answer;
  const pickedListed = body.options.some((o) => o.value === chosen);

  // Once answered, the choice the user pressed is disabled: keep keyboard focus on the card's result line instead
  // of letting it fall to the page.
  useEffect(() => {
    if (pending) return;
    if (card.current?.contains(document.activeElement) || document.activeElement === document.body) {
      result.current?.focus();
    }
  }, [pending]);

  const send = async (value: string) => {
    if (sending || !pending) return;
    setSending(true);
    try {
      await answer(value);
    } catch {
      // The chat shows why. The card stays as it was, so the user can try again.
    } finally {
      setSending(false);
    }
  };

  const submitCustom = (e: FormEvent) => {
    e.preventDefault();
    const text = custom.trim();
    if (text) void send(text);
  };

  const cancelCustom = () => {
    if (sending) return;
    setTyping(false);
    setCustom("");
    requestAnimationFrame(() => otherButton.current?.focus());
  };

  return (
    <section ref={card} className="card" aria-label={`Question: ${body.prompt}`}>
      <p className="card-prompt">{body.prompt}</p>
      <div className="choices">
        {body.options.map((option, i) => (
          <button
            key={option.value}
            type="button"
            className="choice"
            data-chosen={chosen === option.value || undefined}
            aria-pressed={pending ? undefined : chosen === option.value}
            disabled={!pending || sending}
            onClick={() => void send(option.value)}
          >
            <span className="key-cap" aria-hidden="true">
              {letter(i)}
            </span>
            {option.label}
          </button>
        ))}
        {body.allowCustom && pending && !typing && (
          <button ref={otherButton} type="button" className="choice" disabled={sending} onClick={() => setTyping(true)}>
            <span className="key-cap" aria-hidden="true">
              {letter(body.options.length)}
            </span>
            Something else…
          </button>
        )}
      </div>
      {typing && pending && (
        <form className="deny-form" onSubmit={submitCustom}>
          <input
            className="deny-reason"
            aria-label="Your answer"
            placeholder="Type your answer"
            value={custom}
            maxLength={500}
            // biome-ignore lint/a11y/noAutofocus: the user just chose to type; the field is the next step.
            autoFocus
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                cancelCustom();
              }
            }}
          />
          <button type="submit" className="button primary" disabled={sending || !custom.trim()}>
            Send
          </button>
          <button type="button" className="button secondary" disabled={sending} onClick={cancelCustom}>
            Cancel
          </button>
        </form>
      )}
      {!pending && (
        <p ref={result} className="card-result" data-state={body.state} tabIndex={-1}>
          {body.state === "expired"
            ? "No answer"
            : pickedListed
              ? `Answered: ${body.options.find((o) => o.value === chosen)?.label ?? chosen}`
              : `You said: ${chosen ?? ""}`}
        </p>
      )}
    </section>
  );
}
