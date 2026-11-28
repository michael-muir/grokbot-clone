// Cards the bot posts and waits on (#19): a widget (pick one option, like the reference's onboarding question) and a
// form. Answered cards lock and show the answer; a card whose run stopped says it's no longer waiting.
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import type { CardAnswerIn, EntryBody, FormCard, SecretCard, WidgetCard } from "../../../../../server/src/types.ts";

type CardBody = Extract<EntryBody, { kind: "card" }>;

/** The card kinds this app can show: sent with every message, so bots know what they may post. */
export const RENDERED_CARD_KINDS = ["widget", "form", "secret"] as const;

const letter = (i: number) => String.fromCharCode(65 + i);

export function Card({
  body,
  answer,
}: {
  body: CardBody;
  /** Sends the answer; rejects with the gateway's reason when it's refused. */
  answer(answer: CardAnswerIn): Promise<unknown>;
}) {
  const [sending, setSending] = useState(false);
  /** Answered, and waiting for the gateway's copy to say so: a second answer would only be refused. */
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  const card = useRef<HTMLElement>(null);
  const result = useRef<HTMLParagraphElement>(null);
  const pending = body.state === "pending";

  // When the card locks, the control the user used is disabled: keep keyboard focus on its result line instead. Only
  // on that change: a card that was already answered when the chat opened mustn't take focus or scroll to itself.
  const wasPending = useRef(pending);
  useEffect(() => {
    if (pending) return;
    setError(undefined);
    if (!wasPending.current) return;
    wasPending.current = false;
    if (card.current?.contains(document.activeElement) || document.activeElement === document.body) {
      result.current?.focus();
    }
  }, [pending]);

  const send = async (value: CardAnswerIn) => {
    if (sending || sent || !pending) return;
    setSending(true);
    setError(undefined);
    try {
      await answer(value);
      setSent(true);
    } catch (err) {
      // What the user filled in stays, so they can fix it and send again.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const label =
    body.card.kind === "widget"
      ? `Question: ${body.card.prompt}`
      : body.card.kind === "form"
        ? `Form: ${body.card.title}`
        : `Secret: ${body.card.label}`;
  return (
    <section ref={card} className="card" aria-label={label}>
      {body.card.kind === "widget" ? (
        <Widget
          card={body.card}
          body={body}
          disabled={!pending || sending || sent}
          onPick={(value) => void send({ kind: "widget", value })}
        />
      ) : body.card.kind === "secret" ? (
        <Secret card={body.card} disabled={!pending || sending || sent} onSend={(a) => void send(a)} />
      ) : (
        <Form
          card={body.card}
          body={body}
          disabled={!pending || sending || sent}
          onSubmit={(values) => void send({ kind: "form", values })}
        />
      )}
      {error && (
        <p className="card-error" role="alert">
          {error}
        </p>
      )}
      {!pending && (
        <p ref={result} className="card-result" data-state={body.state} tabIndex={-1}>
          {body.state === "expired" ? "No longer waiting for an answer" : answered(body)}
        </p>
      )}
    </section>
  );
}

/** "Answered: Medium", "Sent" for a form (its fields show the values), or what became of a secret. */
function answered(body: CardBody): string {
  const a = body.answer;
  if (a?.kind === "secret" && body.card.kind === "secret") {
    return a.saved ? `Saved as ${body.card.name}` : "Not shared";
  }
  if (a?.kind === "widget" && body.card.kind === "widget") {
    return `Answered: ${body.card.options.find((o) => o.value === a.value)?.label ?? a.value}`;
  }
  return "Sent";
}

/**
 * Asks for a secret (#20). The value lives in the password field only, never in React state, a draft or a log, and
 * the field is cleared the moment it's sent. The bot gets the name; commands it runs get the value.
 */
function Secret({
  card,
  disabled,
  onSend,
}: {
  card: SecretCard;
  disabled: boolean;
  onSend(answer: CardAnswerIn): void;
}) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const [filled, setFilled] = useState(false);

  const save = (e: FormEvent) => {
    e.preventDefault();
    const input = field.current;
    if (!input?.value || disabled) return;
    const value = input.value;
    input.value = "";
    setFilled(false);
    onSend({ kind: "secret", value });
  };

  // Whatever was typed goes too: a declined secret mustn't stay in the page.
  const decline = () => {
    if (field.current) field.current.value = "";
    setFilled(false);
    onSend({ kind: "secret", declined: true });
  };

  return (
    <form className="card-form" onSubmit={save}>
      <p className="card-prompt">{card.label}</p>
      {card.reason && <p className="card-detail">{card.reason}</p>}
      <div className="card-field">
        <label className="card-label" htmlFor={`${id}-value`}>
          Saved as {card.name}, only for this bot. The bot never sees the value.
        </label>
        <input
          ref={field}
          id={`${id}-value`}
          className="card-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          maxLength={10_000}
          disabled={disabled}
          onChange={(e) => setFilled(e.target.value !== "")}
        />
      </div>
      {!disabled && (
        <div className="card-actions">
          <button type="button" className="button secondary" onClick={decline}>
            Don't share
          </button>
          <button type="submit" className="button primary" disabled={!filled}>
            Save
          </button>
        </div>
      )}
    </form>
  );
}

function Widget({
  card,
  body,
  disabled,
  onPick,
}: {
  card: WidgetCard;
  body: CardBody;
  disabled: boolean;
  onPick(value: string): void;
}) {
  const chosen = body.answer?.kind === "widget" ? body.answer.value : undefined;
  return (
    <>
      <p className="card-prompt">{card.prompt}</p>
      <div className="choices">
        {card.options.map((option, i) => (
          <button
            key={option.value}
            type="button"
            className="choice"
            data-chosen={chosen === option.value || undefined}
            aria-pressed={body.state === "pending" ? undefined : chosen === option.value}
            disabled={disabled}
            onClick={() => onPick(option.value)}
          >
            <span className="key-cap" aria-hidden="true">
              {letter(i)}
            </span>
            {option.label}
          </button>
        ))}
      </div>
    </>
  );
}

function Form({
  card,
  body,
  disabled,
  onSubmit,
}: {
  card: FormCard;
  body: CardBody;
  disabled: boolean;
  onSubmit(values: Record<string, string | boolean>): void;
}) {
  const id = useId();
  const sent = body.answer?.kind === "form" ? body.answer.values : undefined;
  const [values, setValues] = useState<Record<string, string | boolean>>(
    () => sent ?? Object.fromEntries(card.fields.map((f) => [f.name, f.type === "checkbox" ? false : ""])),
  );
  // An answered card shows what was sent, whatever was typed here before.
  const shown = sent ?? values;
  const missing = card.fields.some((f) => f.required && !String(shown[f.name] ?? "").trim());
  const set = (name: string, value: string | boolean) => setValues((v) => ({ ...v, [name]: value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!missing && !disabled) onSubmit(values);
  };

  return (
    <form className="card-form" onSubmit={submit}>
      <p className="card-prompt">{card.title}</p>
      {card.fields.map((f) => {
        const fieldId = `${id}-${f.name}`;
        const value = shown[f.name];
        if (f.type === "checkbox") {
          return (
            <label key={f.name} className="card-check" htmlFor={fieldId}>
              <input
                id={fieldId}
                type="checkbox"
                checked={value === true}
                disabled={disabled}
                onChange={(e) => set(f.name, e.target.checked)}
              />
              {f.label}
            </label>
          );
        }
        const common = {
          id: fieldId,
          className: "card-input",
          value: typeof value === "string" ? value : "",
          disabled,
          required: f.required,
        };
        return (
          <div key={f.name} className="card-field">
            <label className="card-label" htmlFor={fieldId}>
              {f.label}
              {f.required && <span aria-hidden="true"> *</span>}
            </label>
            {f.type === "textarea" ? (
              <textarea
                {...common}
                rows={3}
                maxLength={10_000}
                placeholder={f.placeholder}
                onChange={(e) => set(f.name, e.target.value)}
              />
            ) : f.type === "select" ? (
              <select {...common} onChange={(e) => set(f.name, e.target.value)}>
                <option value="">Choose…</option>
                {f.options?.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                {...common}
                type="text"
                maxLength={2_000}
                placeholder={f.placeholder}
                onChange={(e) => set(f.name, e.target.value)}
              />
            )}
          </div>
        );
      })}
      {body.state === "pending" && (
        <div className="card-actions">
          <button type="submit" className="button primary" disabled={disabled || missing}>
            {card.submitLabel ?? "Send"}
          </button>
        </div>
      )}
    </form>
  );
}
