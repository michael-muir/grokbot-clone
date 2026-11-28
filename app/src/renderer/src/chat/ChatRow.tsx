// One display row of the chat: a bubble, status line, card, notice or error, or a time separator. Messages have a
// hover bar (reference/screens/36-msg-hover.png): react, reply in a thread, and More (copy, roll back, rate).
// Memoized: rows are rebuilt on every change, but an unchanged entry keeps its reference, so sameRow() lets
// only the rows that changed re-render.
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { type CardAnswerIn, type Feedback, REACTIONS, type TranscriptEntry } from "../../../../../server/src/types.ts";
import { Avatar } from "../shell/Avatar.tsx";
import { type MenuItem, PopupMenu, ReactionPicker } from "../shell/PopupMenu.tsx";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { Card } from "./Card.tsx";
import { ChoiceCard } from "./ChoiceCard.tsx";
import { Markdown } from "./Markdown.tsx";
import type { Row, RowActions } from "./rows.ts";

export interface RowContext {
  botId: string;
  botName: string;
  botAvatar: { shape: string; color: string };
  answerApproval(entry: TranscriptEntry, allow: boolean, reason?: string): Promise<unknown>;
  answerChoice(entry: TranscriptEntry, answer: string): Promise<unknown>;
  /** Answers a widget or form card; rejects with the gateway's reason when it doesn't fit. */
  answerCard(entry: TranscriptEntry, answer: CardAnswerIn): Promise<unknown>;
  /** Opens the thread started from this message (an empty one if it has none yet). */
  openThread(entry: TranscriptEntry): void;
  /** Asks to roll the conversation back to before this message of the user's. */
  rollBack(entry: TranscriptEntry): void;
  /** Adds or removes one of the user's reactions. Failures show in the chat. */
  react(entry: TranscriptEntry, emoji: string, on: boolean): Promise<unknown>;
  /** Rates a bot message (null clears it). Failures show in the chat. */
  rate(entry: TranscriptEntry, vote: Feedback | null): Promise<unknown>;
  /** Puts text on the clipboard; rejects (and the chat says why) when it can't. */
  copy(text: string): Promise<void>;
}

/** How long the More button shows "Copied". */
const COPIED_MS = 1500;
/** Space between a hover-bar button and the popup it opens. */
const POPUP_GAP_PX = 4;

function ChatRowView({ row, context }: { row: Row; context: RowContext }) {
  if (row.type === "separator") {
    return (
      <div className="chat-row" data-side="center" data-gap={row.gap}>
        <p className="time-separator">{row.label}</p>
      </div>
    );
  }
  if (row.type === "thinking") {
    return (
      <div className="chat-row" data-side="bot" data-gap={row.gap}>
        <StatusLine context={context} label="Thinking" state="running" />
      </div>
    );
  }

  const { entry } = row;
  const time = new Date(entry.createdAt).toISOString();
  return (
    <div className="chat-row" data-side={row.side} data-gap={row.gap}>
      <div className="row-content" data-pending={row.pending || undefined}>
        {content(row.entry, row.group, context)}
        <Reactions entry={entry} context={context} />
        {row.replies !== undefined && (
          <button
            type="button"
            className="thread-replies"
            data-waiting={row.waiting || undefined}
            onClick={() => context.openThread(entry)}
          >
            {row.replies === 1 ? "1 reply" : `${row.replies} replies`}
            {row.waiting && " · Needs you"}
          </button>
        )}
      </div>
      {row.actions && <MessageActions actions={row.actions} entry={entry} context={context} />}
      {row.side !== "center" && (
        <time className="row-time" dateTime={time}>
          {row.time}
        </time>
      )}
    </div>
  );
}

function content(entry: TranscriptEntry, group: string, context: RowContext) {
  const b = entry.body;
  switch (b.kind) {
    case "user_message":
      return (
        <div className="bubble" data-side="user" data-group={group}>
          <p className="plain">{b.text}</p>
        </div>
      );
    case "assistant_text":
      return (
        <div className="bubble" data-side="bot" data-group={group} aria-busy={b.streaming}>
          {/* While streaming, chat.css draws a pulsing dot after the last paragraph. */}
          <Markdown text={b.text} />
        </div>
      );
    case "status":
      return <StatusLine context={context} label={b.label} state={b.state} />;
    case "approval":
      return <ApprovalCard body={b} answer={(allow, reason) => context.answerApproval(entry, allow, reason)} />;
    case "choice":
      return <ChoiceCard body={b} answer={(value) => context.answerChoice(entry, value)} />;
    case "card":
      return <Card body={b} answer={(a) => context.answerCard(entry, a)} />;
    case "notice":
      return <p className="notice">{b.text}</p>;
    case "error":
      return (
        <p className="notice" data-tone="error">
          {b.message}
        </p>
      );
    case "run":
      // Only interrupted runs reach here (rows.ts hides the rest).
      return <p className="notice">Stopped</p>;
  }
}

type Popup = { kind: "react" | "more"; at: { x: number; y: number } };

const MORE_ICONS = {
  copy: (
    <path d="M5.5 5.5V3a.5.5 0 01.5-.5h7a.5.5 0 01.5.5v7a.5.5 0 01-.5.5h-2.5M3 5.5h7a.5.5 0 01.5.5v7a.5.5 0 01-.5.5H3a.5.5 0 01-.5-.5V6a.5.5 0 01.5-.5z" />
  ),
  "roll-back": <path d="M3 8a5 5 0 105-5H5.5M7.5 1L5.5 3l2 2M8 5.5V8l1.75 1.75" />,
  up: <path d="M5 7.5l2.5-5A1.5 1.5 0 019 4v2.5h3.5a1 1 0 011 1.2l-1 5a1 1 0 01-1 .8H5zM5 7.5H3v6h2" />,
  down: <path d="M5 8.5l2.5 5A1.5 1.5 0 009 12V9.5h3.5a1 1 0 001-1.2l-1-5a1 1 0 00-1-.8H5zM5 8.5H3v-6h2" />,
} as const;

type MoreKey = keyof typeof MORE_ICONS;

/**
 * The hover bar (36-msg-hover): React, Reply in a thread, More. Shown on hover, and while one of its buttons has
 * keyboard focus or one of its popups is open.
 */
function MessageActions({
  actions,
  entry,
  context,
}: {
  actions: RowActions;
  entry: TranscriptEntry;
  context: RowContext;
}) {
  const [popup, setPopup] = useState<Popup>();
  const popupNow = useRef(popup);
  popupNow.current = popup;
  const [copied, setCopied] = useState(false);
  const reactButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  // What the user last chose, ahead of the gateway's copy: a second click before the update arrives toggles from
  // here, not from what the row last showed. A new copy of the entry resets it.
  const [mine, setMine] = useState({ reactions: entry.reactions ?? [], feedback: entry.feedback });
  useEffect(() => {
    setMine({ reactions: entry.reactions ?? [], feedback: entry.feedback });
  }, [entry]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const open = (kind: Popup["kind"], button: HTMLButtonElement | null) => {
    if (!button) return;
    if (popup?.kind === kind) return setPopup(undefined);
    const r = button.getBoundingClientRect();
    setPopup({ kind, at: { x: r.left, y: r.bottom + POPUP_GAP_PX } });
  };
  const close = useCallback((restoreFocus: boolean) => {
    const kind = popupNow.current?.kind;
    setPopup(undefined);
    if (restoreFocus) (kind === "react" ? reactButton : moreButton).current?.focus();
  }, []);

  const text = entry.body.kind === "user_message" || entry.body.kind === "assistant_text" ? entry.body.text : "";
  const more: MenuItem<MoreKey>[] = [
    ...(actions.copy ? [{ key: "copy" as const, label: "Copy", icon: MORE_ICONS.copy }] : []),
    ...(actions.rollBack
      ? [{ key: "roll-back" as const, label: "Roll back to here", icon: MORE_ICONS["roll-back"] }]
      : []),
    ...(actions.rate
      ? [
          {
            key: "up" as const,
            label: "Good response",
            icon: MORE_ICONS.up,
            checked: mine.feedback === "up",
            startsGroup: true,
          },
          { key: "down" as const, label: "Bad response", icon: MORE_ICONS.down, checked: mine.feedback === "down" },
        ]
      : []),
  ];
  const choose = (key: MoreKey) => {
    close(true);
    if (key === "copy") {
      context.copy(text).then(
        () => setCopied(true),
        () => {}, // the chat shows the error
      );
    } else if (key === "roll-back") context.rollBack(entry);
    else {
      const vote = mine.feedback === key ? null : key;
      setMine((m) => ({ ...m, feedback: vote ?? undefined }));
      void context.rate(entry, vote);
    }
  };

  return (
    <div className="row-actions" data-open={popup ? true : undefined}>
      {actions.react && (
        <button
          ref={reactButton}
          type="button"
          className="row-action"
          aria-label="Add reaction"
          title="Add reaction"
          aria-haspopup="menu"
          aria-expanded={popup?.kind === "react"}
          onClick={() => open("react", reactButton.current)}
        >
          <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 14A6 6 0 108 2a6 6 0 000 12zM5.75 9.5c.5.9 1.3 1.5 2.25 1.5s1.75-.6 2.25-1.5M6 6.5v.5M10 6.5v.5" />
          </svg>
        </button>
      )}
      {actions.thread && (
        <button
          type="button"
          className="row-action"
          aria-label="Reply in a thread"
          title="Reply in a thread"
          onClick={() => context.openThread(entry)}
        >
          <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6.5 4L3 7.5 6.5 11M3 7.5h6.5a3.5 3.5 0 013.5 3.5v1" />
          </svg>
        </button>
      )}
      {more.length > 0 && (
        <button
          ref={moreButton}
          type="button"
          className="row-action"
          aria-label={copied ? "Copied" : "More"}
          title={copied ? "Copied" : "More"}
          aria-haspopup="menu"
          aria-expanded={popup?.kind === "more"}
          onClick={() => open("more", moreButton.current)}
        >
          <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
            {copied ? <path d="M3.5 8.5l3 3 6-7" /> : <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2" />}
          </svg>
        </button>
      )}
      {/* Says "Copied" to screen readers; the More button shows a check meanwhile. */}
      <span className="visually-hidden" role="status">
        {copied ? "Copied" : ""}
      </span>
      {popup?.kind === "react" && (
        <ReactionPicker
          choices={REACTIONS}
          chosen={mine.reactions}
          at={popup.at}
          opener={reactButton}
          onSelect={(emoji) => {
            close(true);
            const on = !mine.reactions.includes(emoji);
            setMine((m) => ({
              ...m,
              reactions: on ? [...m.reactions, emoji] : m.reactions.filter((r) => r !== emoji),
            }));
            void context.react(entry, emoji, on);
          }}
          onClose={close}
        />
      )}
      {popup?.kind === "more" && (
        <PopupMenu
          label="Message actions"
          items={more}
          at={popup.at}
          opener={moreButton}
          onSelect={choose}
          onClose={close}
        />
      )}
    </div>
  );
}

/** The user's reactions under a message; each one removes itself. */
function Reactions({ entry, context }: { entry: TranscriptEntry; context: RowContext }) {
  const reactions = entry.reactions ?? [];
  if (reactions.length === 0) return null;
  return (
    <div className="reactions">
      {reactions.map((emoji) => (
        <button
          key={emoji}
          type="button"
          className="reaction"
          aria-label={`Remove ${emoji}`}
          title="Remove"
          onClick={() => void context.react(entry, emoji, false)}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}

const sameActions = (a: RowActions | undefined, b: RowActions | undefined) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.react === b.react &&
    a.thread === b.thread &&
    a.copy === b.copy &&
    a.rollBack === b.rollBack &&
    a.rate === b.rate);

function StatusLine({ context, label, state }: { context: RowContext; label: string; state: string }) {
  return (
    <div className="status-line" data-state={state}>
      <span className="status-slot" aria-hidden="true">
        <Avatar avatar={context.botAvatar} size="small" botId={context.botId} />
      </span>
      <span className="status-label">{label}</span>
      {state === "failed" && <span className="visually-hidden">(failed)</span>}
    </div>
  );
}

/** Re-render only when what the row shows changed: a new entry version, position in its group, or spacing. */
function sameRow(a: { row: Row; context: RowContext }, b: { row: Row; context: RowContext }): boolean {
  if (a.context.botName !== b.context.botName) return false;
  if (
    a.context.botAvatar.shape !== b.context.botAvatar.shape ||
    a.context.botAvatar.color !== b.context.botAvatar.color
  )
    return false;
  const x = a.row;
  const y = b.row;
  if (x.type !== y.type || x.key !== y.key || x.gap !== y.gap) return false;
  if (x.type === "separator" && y.type === "separator") return x.label === y.label;
  if (x.type === "thinking" && y.type === "thinking") return true;
  if (x.type === "entry" && y.type === "entry") {
    return (
      x.entry === y.entry &&
      x.group === y.group &&
      x.time === y.time &&
      x.side === y.side &&
      x.pending === y.pending &&
      x.replies === y.replies &&
      x.waiting === y.waiting &&
      sameActions(x.actions, y.actions)
    );
  }
  return false;
}

export const ChatRow = memo(ChatRowView, sameRow);
