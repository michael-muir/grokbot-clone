// The message composer: a growing text field and one round button that sends, or stops the running reply.
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { draftFor, primaryButton, saveDraft, shouldSend } from "./composer-state.ts";

export function Composer({
  draftKey,
  placeholder,
  busy,
  onSend,
  onStop,
  onEscape,
  fill,
  onFilled,
  sendWithCtrlEnter = false,
  spellcheck = true,
}: {
  /** Whose unsent text this is: a bot's chat, or one of its threads. */
  draftKey: string;
  /** Also the field's name for screen readers ("Message Nova"). */
  placeholder: string;
  busy: boolean;
  /** Escape in an empty field (leaves a thread). */
  onEscape?(): void;
  /** Text to put in the field (a rolled-back message), after any draft; `n` makes the same text count again. */
  fill?: { text: string; n: number };
  /** The fill was used: it mustn't come back in the next composer shown (another thread's, say). */
  onFilled?(): void;
  /** The "Send with Ctrl+Enter" setting. */
  sendWithCtrlEnter?: boolean;
  spellcheck?: boolean;
  /** Rejects when the send fails; the draft is kept so nothing typed is lost. */
  onSend(text: string): Promise<void>;
  onStop(): Promise<void>;
}) {
  const [draft, setDraft] = useState(() => draftFor(draftKey));
  // A ref as well as state: a second Enter in the same tick must already see the first send.
  const sendingNow = useRef(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  // A finished run makes Stop available again for the next one.
  useEffect(() => {
    if (!busy) setStopping(false);
  }, [busy]);

  // A rolled-back message comes back to be edited. Text already being written stays first, the message after it:
  // the gateway has hidden the message, so this is the only place its text is left.
  useEffect(() => {
    if (!fill) return;
    setDraft((current) => {
      const next = current.trim() === "" ? fill.text : `${current.trimEnd()}\n\n${fill.text}`;
      saveDraft(draftKey, next);
      return next;
    });
    field.current?.focus();
    onFilled?.();
  }, [fill, draftKey, onFilled]);

  const button = primaryButton({ draft, busy, sending, stopping });

  const update = (text: string) => {
    setDraft(text);
    saveDraft(draftKey, text);
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || busy || sendingNow.current) return;
    sendingNow.current = true;
    setSending(true);
    try {
      await onSend(text);
      // Clear only what was sent: anything typed while the send was in flight stays.
      setDraft((current) => {
        const next = current.trim() === text ? "" : current;
        saveDraft(draftKey, next);
        return next;
      });
    } catch {
      // The chat shows the error; the draft stays.
    } finally {
      sendingNow.current = false;
      setSending(false);
      field.current?.focus();
    }
  };

  const stop = async () => {
    setStopping(true);
    // The button disables under the cursor or keyboard focus; keep focus somewhere useful.
    field.current?.focus();
    try {
      await onStop();
    } catch {
      setStopping(false); // the chat shows the error; let the user try again
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (button.kind === "stop") void stop();
    else void send();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape" && onEscape && draft === "" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onEscape();
      return;
    }
    const mode = { ctrlEnter: sendWithCtrlEnter, modifier: e.ctrlKey || e.metaKey };
    if (!shouldSend(e.key, e.shiftKey, e.nativeEvent.isComposing, mode)) return;
    e.preventDefault(); // no new line, whether or not this Enter sends
    void send();
  };

  return (
    <form className="composer" onSubmit={onSubmit}>
      <textarea
        ref={field}
        aria-label={placeholder}
        placeholder={placeholder}
        value={draft}
        rows={1}
        spellCheck={spellcheck}
        // biome-ignore lint/a11y/noAutofocus: opening a chat is opening it to write in; this is the main input.
        autoFocus
        onChange={(e) => update(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="submit"
        className="composer-action"
        data-kind={button.kind}
        aria-label={button.label}
        title={button.label}
        disabled={!button.enabled}
      >
        {button.kind === "stop" ? <StopIcon /> : <SendIcon />}
      </button>
    </form>
  );
}

function SendIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  );
}
