// One display row of the chat: a bubble, status line, card, notice or error, or a time separator. Messages have a
// hover bar (reference/screens/36-msg-hover.png): reply in a thread, roll back.
// Memoized: rows are rebuilt on every change, but an unchanged entry keeps its reference, so sameRow() lets
// only the rows that changed re-render.
import { memo } from "react";
import type { TranscriptEntry } from "../../../../../server/src/types.ts";
import { Avatar } from "../shell/Avatar.tsx";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { ChoiceCard } from "./ChoiceCard.tsx";
import { Markdown } from "./Markdown.tsx";
import type { Row, RowActions } from "./rows.ts";

export interface RowContext {
  botId: string;
  botName: string;
  botAvatar: { shape: string; color: string };
  answerApproval(entry: TranscriptEntry, allow: boolean, reason?: string): Promise<unknown>;
  answerChoice(entry: TranscriptEntry, answer: string): Promise<unknown>;
  /** Opens the thread started from this message (an empty one if it has none yet). */
  openThread(entry: TranscriptEntry): void;
  /** Asks to roll the conversation back to before this message of the user's. */
  rollBack(entry: TranscriptEntry): void;
}

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
        {row.replies !== undefined && (
          <button type="button" className="thread-replies" onClick={() => context.openThread(entry)}>
            {row.replies === 1 ? "1 reply" : `${row.replies} replies`}
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

/** The hover bar: shown on hover, and while one of its buttons has keyboard focus. */
function MessageActions({
  actions,
  entry,
  context,
}: {
  actions: RowActions;
  entry: TranscriptEntry;
  context: RowContext;
}) {
  return (
    <div className="row-actions">
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
      {actions.rollBack && (
        <button
          type="button"
          className="row-action"
          aria-label="Roll back to here"
          title="Roll back to here"
          onClick={() => context.rollBack(entry)}
        >
          <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 8a5 5 0 105-5H5.5M7.5 1L5.5 3l2 2M8 5.5V8l1.75 1.75" />
          </svg>
        </button>
      )}
    </div>
  );
}

const sameActions = (a: RowActions | undefined, b: RowActions | undefined) =>
  a === b || (a !== undefined && b !== undefined && a.thread === b.thread && a.rollBack === b.rollBack);

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
      sameActions(x.actions, y.actions)
    );
  }
  return false;
}

export const ChatRow = memo(ChatRowView, sameRow);
