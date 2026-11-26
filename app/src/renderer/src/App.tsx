// The app's one screen so far: the bot tiles, and a live chat with the selected bot. The sidebar and composer are
// still the scaffold's (#11, #12 replace them); the transcript is the real chat view (chat/).
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { StreamState } from "../../../../server/src/client/subscribe.ts";
import { TranscriptView } from "../../../../server/src/client/transcript-view.ts";
import type { PublicBot, TranscriptEntry } from "../../../../server/src/types.ts";
import type { ConnectionInfo } from "../../shared/ipc.ts";
import { botColor, initial } from "./bot-colors.ts";
import type { RowContext } from "./chat/ChatRow.tsx";
import { Transcript } from "./chat/Transcript.tsx";
import { call } from "./gateway.ts";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const colorOf = (bot: PublicBot) => botColor(bot.avatar.color);

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

  const connectionText =
    connection === undefined
      ? "Connecting to the gateway…"
      : connection.ok
        ? `Gateway ${connection.spawned ? "started" : "attached"} at ${connection.url}`
        : connection.error;
  const bot = bots?.find((b) => b.id === selected);

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Bots">
        <ul className="bot-list">
          {bots?.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                className="bot-tile"
                aria-current={b.id === selected}
                aria-label={`${b.name} (${b.provider})`}
                title={b.name}
                data-bot-color={colorOf(b)}
                onClick={() => setSelected(b.id)}
              >
                <span className="avatar" aria-hidden="true">
                  {initial(b.name)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {/* A live region announces its text content, so the words are in it (hidden), not in aria-label. */}
        <span
          className="connection-dot"
          role="status"
          title={connectionText}
          data-state={connection === undefined ? "pending" : connection.ok ? "ok" : "failed"}
        >
          <span className="visually-hidden">{connectionText}</span>
        </span>
      </nav>
      <main className="chat">
        {connection?.ok === false && (
          <p className="banner" role="alert">
            {connection.error}
          </p>
        )}
        {error && (
          <p className="banner" role="alert">
            {error}
          </p>
        )}
        {bot ? <Chat key={bot.id} bot={bot} /> : connection?.ok && <p className="muted">No bot selected.</p>}
      </main>
    </div>
  );
}

function Chat({ bot }: { bot: PublicBot }) {
  const view = useRef(new TranscriptView()).current;
  const entries = useSyncExternalStore(
    useCallback((onChange) => view.subscribe(onChange), [view]),
    () => view.entries(),
  );
  const [stream, setStream] = useState<StreamState | "ended">("connecting");
  const [problem, setProblem] = useState<string>();
  const [draft, setDraft] = useState("");
  // A ref, not state: a second Enter in the same tick must already see the first send.
  const sending = useRef(false);
  const [isSending, setIsSending] = useState(false);

  useEffect(() => {
    // Resume from what's already held, so a re-subscribe (StrictMode, a reload of this view) repeats nothing.
    return window.desktop.subscribe(bot.id, view.cursor, (event) => {
      if (event.kind === "entry") {
        view.apply(event.entry);
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
  }, [bot.id, view]);

  const lastRun = entries.findLast((e) => e.body.kind === "run");
  const busy = lastRun?.body.kind === "run" && lastRun.body.state === "running";

  const context = useMemo<RowContext>(
    () => ({
      botName: bot.name,
      answerApproval: (entry: TranscriptEntry, allow: boolean, reason?: string) =>
        call("answerApproval", bot.id, entry.id, allow ? { allow } : { allow, reason: reason ?? "" }).catch(
          (err: unknown) => {
            setProblem(message(err));
            throw err;
          },
        ),
    }),
    [bot.id, bot.name],
  );

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
    <div className="chat-body" data-bot-color={colorOf(bot)}>
      <header className="chat-header">
        <h2 className="name-pill">
          <span className="avatar small" aria-hidden="true">
            {initial(bot.name)}
          </span>
          <span className="name">{bot.name}</span>
        </h2>
        <span className="header-meta">
          {bot.provider}
          {bot.model ? ` · ${bot.model}` : ""} · {stream}
        </span>
      </header>
      <Transcript entries={entries} context={context} label={`Conversation with ${bot.name}`} />
      {problem && (
        <p className="banner" role="alert">
          {problem}
        </p>
      )}
      <form className="composer" onSubmit={send}>
        <textarea
          aria-label={`Message ${bot.name}`}
          placeholder={`Message ${bot.name}`}
          value={draft}
          rows={1}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {busy ? (
          <button
            type="button"
            className="send"
            onClick={() => call("interrupt", bot.id).catch((err) => setProblem(message(err)))}
          >
            Stop
          </button>
        ) : (
          <button type="submit" className="send" disabled={!draft.trim() || isSending}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}
