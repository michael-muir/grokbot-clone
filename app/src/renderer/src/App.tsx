// The scaffold's one screen: connection state, the bot list, and a live chat with the selected bot. A working
// base for the real screens, which replace it from #9 on.
import { type FormEvent, type KeyboardEvent, useEffect, useReducer, useRef, useState } from "react";
import type { StreamState } from "../../../../server/src/client/subscribe.ts";
import { TranscriptView } from "../../../../server/src/client/transcript-view.ts";
import type { PublicBot, TranscriptEntry } from "../../../../server/src/types.ts";
import type { ConnectionInfo } from "../../shared/ipc.ts";
import { call } from "./gateway.ts";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function App() {
  const [connection, setConnection] = useState<ConnectionInfo>();
  const [bots, setBots] = useState<PublicBot[]>();
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    (async () => {
      const info = await window.desktop.connection();
      if (!live) return;
      setConnection(info);
      if (!info.ok) return;
      const list = await call("listBots");
      if (!live) return;
      setBots(list);
      setSelected((current) => current ?? list[0]?.id);
      window.desktop.ready(list.length);
    })().catch((err: unknown) => {
      if (live) setError(message(err));
    });
    return () => {
      live = false;
    };
  }, []);

  const bot = bots?.find((b) => b.id === selected);
  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Bots">
        <h1 className="app-name">GrokBot Clone</h1>
        <p className="connection" role="status">
          {connection === undefined
            ? "Connecting to the gateway…"
            : connection.ok
              ? `Gateway ${connection.spawned ? "started" : "attached"} at ${connection.url}`
              : connection.error}
        </p>
        {error && <p className="error">{error}</p>}
        <ul className="bot-list">
          {bots?.map((b) => (
            <li key={b.id}>
              <button type="button" aria-current={b.id === selected} onClick={() => setSelected(b.id)}>
                {b.name}
                <span className="muted"> · {b.provider}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main className="chat">{bot ? <Chat key={bot.id} bot={bot} /> : <p className="muted">No bot selected.</p>}</main>
    </div>
  );
}

function Chat({ bot }: { bot: PublicBot }) {
  const view = useRef(new TranscriptView());
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [stream, setStream] = useState<StreamState | "ended">("connecting");
  const [problem, setProblem] = useState<string>();
  const [draft, setDraft] = useState("");
  const end = useRef<HTMLLIElement>(null);
  // Follow new output only while the user is at the bottom; scrolling up to read stops the jumping.
  const atBottom = useRef(true);
  // A ref, not state: a second Enter in the same tick must already see the first send.
  const sending = useRef(false);
  const [isSending, setIsSending] = useState(false);

  useEffect(() => {
    // Resume from what's already held, so a re-subscribe (StrictMode, a reload of this view) repeats nothing.
    return window.desktop.subscribe(bot.id, view.current.cursor, (event) => {
      if (event.kind === "entry") {
        if (view.current.apply(event.entry)) rerender();
      } else if (event.kind === "state") {
        setStream(event.state);
        if (event.state === "live") setProblem(undefined);
      } else if (event.kind === "error") {
        setProblem(event.message);
      } else {
        setStream("ended");
        if (event.error) setProblem(event.error);
      }
    });
  }, [bot.id]);

  const entries = view.current.entries();
  const lastRun = entries.findLast((e) => e.body.kind === "run");
  const busy = lastRun?.body.kind === "run" && lastRun.body.state === "running";

  const cursor = view.current.cursor;
  useEffect(() => {
    // Runs when an entry arrives or changes (the cursor moves), not on every keystroke in the composer.
    if (cursor >= 0 && atBottom.current) end.current?.scrollIntoView({ block: "end" });
  }, [cursor]);

  const send = async (e?: FormEvent) => {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || sending.current) return;
    sending.current = true;
    setIsSending(true);
    try {
      await call("sendMessage", bot.id, text);
      setDraft("");
      setProblem(undefined);
      atBottom.current = true;
    } catch (err) {
      setProblem(message(err));
    } finally {
      sending.current = false;
      setIsSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) void send(e);
  };

  return (
    <>
      <header className="chat-header">
        <h2>{bot.name}</h2>
        <span className="muted">
          {bot.provider}
          {bot.model ? ` · ${bot.model}` : ""} · {stream}
        </span>
      </header>
      <ol
        className="transcript"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {entries.map((entry) => (
          <Entry key={entry.id} entry={entry} botId={bot.id} onError={setProblem} />
        ))}
        <li ref={end} aria-hidden="true" className="transcript-end" />
      </ol>
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <form className="composer" onSubmit={send}>
        <textarea
          aria-label={`Message ${bot.name}`}
          placeholder={`Message ${bot.name}`}
          value={draft}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {busy ? (
          <button type="button" onClick={() => call("interrupt", bot.id).catch((err) => setProblem(message(err)))}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!draft.trim() || isSending}>
            Send
          </button>
        )}
      </form>
    </>
  );
}

function Entry({ entry, botId, onError }: { entry: TranscriptEntry; botId: string; onError(m: string): void }) {
  const b = entry.body;
  switch (b.kind) {
    case "user_message":
      return <li className="entry user">{b.text}</li>;
    case "assistant_text":
      return (
        <li className="entry assistant">
          {b.text}
          {b.streaming && <span className="muted"> …</span>}
        </li>
      );
    case "status":
      return (
        <li className="entry status muted">
          {b.label} · {b.state}
        </li>
      );
    case "approval": {
      const answer = (allow: boolean) =>
        call("answerApproval", botId, entry.id, allow ? { allow } : { allow, reason: "Denied by the user." }).catch(
          (err) => onError(message(err)),
        );
      return (
        <li className="entry approval">
          <strong>Allow {b.tool}?</strong> {b.summary}
          {b.state === "pending" ? (
            <span className="actions">
              <button type="button" onClick={() => answer(true)}>
                Allow
              </button>
              <button type="button" onClick={() => answer(false)}>
                Deny
              </button>
            </span>
          ) : (
            <span className="muted"> · {b.state}</span>
          )}
        </li>
      );
    }
    case "error":
      return <li className="entry error">{b.message}</li>;
    case "notice":
      return <li className="entry notice muted">{b.text}</li>;
    case "run":
      return b.state === "running" || b.state === "finished" ? null : (
        <li className="entry notice muted">Run {b.state}</li>
      );
  }
}
