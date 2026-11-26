// One display row of the chat: a bubble, status line, card, notice or error, or a time separator.
// Memoized: rows are rebuilt on every change, but an unchanged entry keeps its reference, so sameRow() lets
// only the rows that changed re-render.
import { memo } from "react";
import type { TranscriptEntry } from "../../../../../server/src/types.ts";
import { initial } from "../bot-colors.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { Markdown } from "./Markdown.tsx";
import type { Row } from "./rows.ts";

export interface RowContext {
  botName: string;
  answerApproval(entry: TranscriptEntry, allow: boolean, reason?: string): Promise<unknown>;
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
        <StatusLine botName={context.botName} label="Thinking" state="running" />
      </div>
    );
  }

  const { entry } = row;
  const time = new Date(entry.createdAt).toISOString();
  return (
    <div className="chat-row" data-side={row.side} data-gap={row.gap}>
      <div className="row-content">{content(row.entry, row.group, context)}</div>
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
      return <StatusLine botName={context.botName} label={b.label} state={b.state} />;
    case "approval":
      return <ApprovalCard body={b} answer={(allow, reason) => context.answerApproval(entry, allow, reason)} />;
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

function StatusLine({ botName, label, state }: { botName: string; label: string; state: string }) {
  return (
    <div className="status-line" data-state={state}>
      <span className="status-slot" aria-hidden="true">
        <span className="avatar small">{initial(botName)}</span>
      </span>
      <span className="status-label">{label}</span>
      {state === "failed" && <span className="visually-hidden">(failed)</span>}
    </div>
  );
}

/** Re-render only when what the row shows changed: a new entry version, position in its group, or spacing. */
function sameRow(a: { row: Row; context: RowContext }, b: { row: Row; context: RowContext }): boolean {
  if (a.context.botName !== b.context.botName) return false;
  const x = a.row;
  const y = b.row;
  if (x.type !== y.type || x.key !== y.key || x.gap !== y.gap) return false;
  if (x.type === "separator" && y.type === "separator") return x.label === y.label;
  if (x.type === "thinking" && y.type === "thinking") return true;
  if (x.type === "entry" && y.type === "entry") {
    return x.entry === y.entry && x.group === y.group && x.time === y.time && x.side === y.side;
  }
  return false;
}

export const ChatRow = memo(ChatRowView, sameRow);
