// The app's main screen: the bot sidebar, the open bot's chat, and the bot panel. App owns what's shared between
// them (the bots, the selection, every bot's activity, new replies, the panel); Chat owns one conversation.
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { StreamState } from "../../../../server/src/client/subscribe.ts";
import { TranscriptView } from "../../../../server/src/client/transcript-view.ts";
import type { BotActivity, ProviderSummary, PublicBot, TranscriptEntry } from "../../../../server/src/types.ts";
import type { ConnectionInfo } from "../../shared/ipc.ts";
import { botColor, initial } from "./bot-colors.ts";
import type { RowContext } from "./chat/ChatRow.tsx";
import { Composer } from "./chat/Composer.tsx";
import { Transcript } from "./chat/Transcript.tsx";
import { call } from "./gateway.ts";
import { BotPanel, PANEL_ID } from "./shell/BotPanel.tsx";
import { Sidebar } from "./shell/Sidebar.tsx";
import { nextUnread } from "./shell/sidebar-state.ts";
import "./shell/shell.css";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const colorOf = (bot: PublicBot) => botColor(bot.avatar.color);

export function App() {
  const [connection, setConnection] = useState<ConnectionInfo>();
  const [bots, setBots] = useState<PublicBot[]>([]);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [selected, setSelected] = useState<string>();
  const [activity, setActivity] = useState<BotActivity[]>([]);
  const [unread, setUnread] = useState<ReadonlySet<string>>(() => new Set());
  const [panelOpen, setPanelOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [renameError, setRenameError] = useState<string>();
  const [activityError, setActivityError] = useState<string>();
  const pill = useRef<HTMLButtonElement>(null);
  // The latest values, for the activity listener, which outlives renders.
  const selectedNow = useRef(selected);
  selectedNow.current = selected;
  const activityNow = useRef<BotActivity[]>([]);

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
      // Only labels for the panel: a failure here mustn't block the chat.
      call("listProviders").then(
        (p) => {
          if (live) setProviders(p);
        },
        (err: unknown) => console.warn("Couldn't list providers:", err),
      );
    })().catch((err: unknown) => {
      if (live) setError(message(err));
    });
    return () => {
      live = false;
    };
  }, []);

  const connected = connection?.ok === true;
  useEffect(() => {
    if (!connected) return;
    return window.desktop.activity((event) => {
      if (event.kind === "activity") {
        const before = activityNow.current;
        activityNow.current = event.bots;
        setActivity(event.bots);
        setUnread((u) => nextUnread(u, before, event.bots, selectedNow.current));
        setActivityError(undefined);
      } else if (event.kind === "ended") {
        // No more updates: show nothing rather than a state that may be stale ("working" forever).
        activityNow.current = [];
        setActivity([]);
        if (event.error) setActivityError(`Bot status stopped updating: ${event.error}`);
      }
    });
  }, [connected]);

  const select = useCallback((botId: string) => {
    setSelected(botId);
    setUnread((u) => {
      if (!u.has(botId)) return u;
      const next = new Set(u);
      next.delete(botId);
      return next;
    });
  }, []);

  const closePanel = useCallback(() => {
    setPanelOpen(false);
    // Back to where the user opened it from.
    requestAnimationFrame(() => pill.current?.focus());
  }, []);

  const rename = useCallback(async (botId: string, name: string) => {
    try {
      const updated = await call("updateBot", botId, { name });
      setBots((list) => list.map((b) => (b.id === updated.id ? updated : b)));
      setRenameError(undefined);
    } catch (err) {
      setRenameError(`Couldn't rename: ${message(err)}`);
      throw err;
    }
  }, []);

  const connectionInfo = {
    state: connection === undefined ? ("pending" as const) : connection.ok ? ("ok" as const) : ("failed" as const),
    text:
      connection === undefined
        ? "Connecting to the gateway…"
        : connection.ok
          ? `Gateway ${connection.spawned ? "started" : "attached"} at ${connection.url}`
          : connection.error,
  };
  const bot = bots.find((b) => b.id === selected);
  const showPanel = panelOpen && bot !== undefined;

  return (
    <div className="shell" data-panel={showPanel ? "open" : "closed"}>
      <Sidebar
        bots={bots}
        selected={selected}
        activity={activity}
        unread={unread}
        connection={connectionInfo}
        onSelect={select}
      />
      <main className="chat">
        {connection?.ok === false && (
          <p className="banner" role="alert">
            {connection.error}
          </p>
        )}
        {[error, activityError, renameError].map(
          (text) =>
            text && (
              <p key={text} className="banner" role="alert">
                {text}
              </p>
            ),
        )}
        {bot ? (
          <Chat
            key={bot.id}
            bot={bot}
            pill={pill}
            panelOpen={showPanel}
            onTogglePanel={() => (panelOpen ? closePanel() : setPanelOpen(true))}
          />
        ) : (
          connected && <p className="muted">No bot selected.</p>
        )}
      </main>
      {showPanel && (
        <BotPanel
          bot={bot}
          providerLabel={providers.find((p) => p.id === bot.provider)?.label ?? bot.provider}
          onClose={closePanel}
          onRename={(name) => rename(bot.id, name)}
        />
      )}
    </div>
  );
}

function Chat({
  bot,
  pill,
  panelOpen,
  onTogglePanel,
}: {
  bot: PublicBot;
  pill: RefObject<HTMLButtonElement | null>;
  panelOpen: boolean;
  onTogglePanel(): void;
}) {
  const [view] = useState(() => new TranscriptView());
  const entries = useSyncExternalStore(
    useCallback((onChange) => view.subscribe(onChange), [view]),
    () => view.entries(),
  );
  const [stream, setStream] = useState<StreamState | "ended">("connecting");
  const [problem, setProblem] = useState<string>();

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
      } else if (event.kind === "ended") {
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

  /** Runs a gateway call; a failure shows in the banner and is re-thrown so the caller keeps its state. */
  const report = useCallback(async (run: () => Promise<unknown>) => {
    try {
      await run();
      setProblem(undefined);
    } catch (err) {
      setProblem(message(err));
      throw err;
    }
  }, []);

  return (
    <div className="chat-body" data-bot-color={colorOf(bot)}>
      <header className="chat-header">
        <h2 className="chat-title">
          {/* The name pill opens the bot panel, as in the reference. */}
          <button
            ref={pill}
            type="button"
            className="name-pill"
            aria-expanded={panelOpen}
            aria-controls={panelOpen ? PANEL_ID : undefined}
            title={panelOpen ? "Hide bot details" : "Show bot details"}
            onClick={onTogglePanel}
          >
            <span className="avatar small" aria-hidden="true">
              {initial(bot.name)}
            </span>
            <span className="name">{bot.name}</span>
          </button>
        </h2>
      </header>
      <Transcript entries={entries} context={context} label={`Conversation with ${bot.name}`} />
      {problem ? (
        <p className="banner" role="alert">
          {problem}
        </p>
      ) : (
        stream === "reconnecting" && (
          <p className="banner" role="status">
            Reconnecting to the gateway…
          </p>
        )
      )}
      <Composer
        botId={bot.id}
        botName={bot.name}
        busy={busy}
        onSend={(text) => report(() => call("sendMessage", bot.id, text))}
        onStop={() => report(() => call("interrupt", bot.id))}
      />
    </div>
  );
}
