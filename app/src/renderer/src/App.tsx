// The app's main screen: the bot sidebar, the open bot's chat, and the bot panel. App owns what's shared between
// them (the bots, the selection, every bot's activity, new replies, the panel); Chat owns one conversation.
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { StreamState } from "../../../../server/src/client/subscribe.ts";
import { TranscriptView } from "../../../../server/src/client/transcript-view.ts";
import type { BotActivity, ProviderSummary, PublicBot, TranscriptEntry } from "../../../../server/src/types.ts";
import type { ConnectionInfo } from "../../shared/ipc.ts";
import { type AppSettings, DEFAULT_SETTINGS } from "../../shared/settings.ts";
import { botColor, initial } from "./bot-colors.ts";
import type { RowContext } from "./chat/ChatRow.tsx";
import { Composer } from "./chat/Composer.tsx";
import { isConfirmed, type PendingMessage } from "./chat/rows.ts";
import { Transcript } from "./chat/Transcript.tsx";
import { call } from "./gateway.ts";
import { Onboarding } from "./onboarding/Onboarding.tsx";
import { GeneralPage } from "./settings/GeneralPage.tsx";
import { ModelsPage } from "./settings/ModelsPage.tsx";
import { SettingsDialog, type SettingsPage } from "./settings/SettingsDialog.tsx";
import { DeleteBotDialog } from "./shell/BotMenu.tsx";
import { BotPanel, PANEL_ID } from "./shell/BotPanel.tsx";
import { Sidebar } from "./shell/Sidebar.tsx";
import { afterDelete, type MenuAction, nextUnread } from "./shell/sidebar-state.ts";
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
  /** A bot-menu action that failed (pin, hide, copy). */
  const [botError, setBotError] = useState<string>();
  /** The bot being deleted, while its confirmation is open. */
  const [deleting, setDeleting] = useState<{ bot: PublicBot; busy: boolean; error?: string }>();
  /** A sidebar tile to focus after the next change renders (see Sidebar). */
  const [refocus, setRefocus] = useState<{ botId: string }>();
  const [activityError, setActivityError] = useState<string>();
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  /** The stored settings have arrived: until then, whether to onboard isn't known. */
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsError, setSettingsError] = useState<string>();
  /** Open Settings: which page, and for Models & keys, which bot. */
  const [settingsOpen, setSettingsOpen] = useState<{ page: SettingsPage; botId?: string }>();
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

  useEffect(() => {
    window.desktop.settings.get().then(
      (s) => {
        setSettings(s);
        setSettingsLoaded(true);
      },
      // Without them, onboarding stays off: better than asking someone who set up long ago.
      (err: unknown) => console.warn("Couldn't read settings:", err),
    );
    const stopChange = window.desktop.settings.onChange(setSettings);
    const stopOpen = window.desktop.settings.onOpen(() => setSettingsOpen((open) => open ?? { page: "general" }));
    return () => {
      stopChange();
      stopOpen();
    };
  }, []);

  const changeSettings = useCallback(async (patch: Partial<AppSettings>) => {
    try {
      setSettings(await window.desktop.settings.set(patch));
      setSettingsError(undefined);
    } catch (err) {
      setSettingsError(`Couldn't save the setting: ${message(err)}`);
    }
  }, []);

  /** Onboarding is over (finished or put off). Saving can fail; the flow closes anyway and returns next launch. */
  const endOnboarding = useCallback(async () => {
    setSettingsOpen(undefined); // a Settings shortcut pressed during the flow mustn't pop up over the chat
    try {
      setSettings(await window.desktop.settings.set({ onboarded: true }));
    } catch (err) {
      console.error("Couldn't save that onboarding is done:", err);
      setSettings((s) => ({ ...s, onboarded: true }));
    }
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

  const mainId = bots[0]?.id;
  const replaceBot = useCallback((updated: PublicBot) => {
    setBots((list) => list.map((b) => (b.id === updated.id ? updated : b)));
  }, []);

  const menuAction = useCallback(
    async (bot: PublicBot, action: MenuAction) => {
      setBotError(undefined);
      try {
        if (action === "delete") return setDeleting({ bot, busy: false });
        if (action === "copy-id") return await navigator.clipboard.writeText(bot.id);
        const patch =
          action === "pin" || action === "unpin" ? { pinned: action === "pin" } : { hidden: action === "hide" };
        replaceBot(await call("updateBot", bot.id, patch));
      } catch (err) {
        setBotError(`Couldn't ${action === "copy-id" ? "copy the bot ID" : "change the bot"}: ${message(err)}`);
      }
    },
    [replaceBot],
  );

  const confirmDelete = useCallback(async () => {
    if (!deleting) return;
    const { bot } = deleting;
    setDeleting({ bot, busy: true });
    try {
      await call("deleteBot", bot.id);
      setSelected((current) => afterDelete(mainId, bot.id, current));
      setBots((list) => list.filter((b) => b.id !== bot.id));
      setDeleting(undefined);
      if (mainId) setRefocus({ botId: mainId });
    } catch (err) {
      // Kept open, so the reason (still working, say) shows where the user is looking.
      setDeleting({ bot, busy: false, error: message(err) });
    }
  }, [deleting, mainId]);

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
  const mainBot = bots[0];

  // Not tied to the connection: a gateway blip mustn't unmount the flow and lose what's been entered.
  if (settingsLoaded && !settings.onboarded && mainBot) {
    return (
      <Onboarding
        bot={mainBot}
        onDone={async (updated) => {
          setBots((list) => list.map((b) => (b.id === updated.id ? updated : b)));
          select(updated.id);
          await endOnboarding();
        }}
        onSkip={() => void endOnboarding()}
      />
    );
  }

  return (
    <div className="shell" data-panel={showPanel ? "open" : "closed"}>
      <Sidebar
        bots={bots}
        selected={selected}
        activity={activity}
        unread={unread}
        connection={connectionInfo}
        onSelect={select}
        onOpenSettings={() => setSettingsOpen({ page: "general" })}
        onMenuAction={menuAction}
        refocus={refocus}
        onRefocus={setRefocus}
      />
      <main className="chat">
        {connection?.ok === false && (
          <p className="banner" role="alert">
            {connection.error}
          </p>
        )}
        {[error, activityError, renameError, botError].map(
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
            settings={settings}
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
          onChangeModel={() => setSettingsOpen({ page: "models", botId: bot.id })}
        />
      )}
      {deleting && (
        <DeleteBotDialog
          name={deleting.bot.name}
          busy={deleting.busy}
          error={deleting.error}
          onConfirm={() => void confirmDelete()}
          onCancel={() => {
            const id = deleting.bot.id;
            setDeleting(undefined);
            setRefocus({ botId: id });
          }}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          page={settingsOpen.page}
          onPage={(page) => setSettingsOpen((open) => ({ ...open, page }))}
          onClose={() => {
            setSettingsOpen(undefined);
            setSettingsError(undefined); // an old failure shouldn't greet the next visit
          }}
        >
          {settingsError && (
            <p className="banner" role="alert">
              {settingsError}
            </p>
          )}
          {settingsOpen.page === "general" ? (
            <GeneralPage settings={settings} onChange={(patch) => void changeSettings(patch)} />
          ) : (
            <ModelsPage
              bots={bots}
              initialBotId={settingsOpen.botId ?? selected}
              onBotChanged={(updated) => setBots((list) => list.map((b) => (b.id === updated.id ? updated : b)))}
              onProvidersChanged={setProviders}
            />
          )}
        </SettingsDialog>
      )}
    </div>
  );
}

function Chat({
  bot,
  pill,
  panelOpen,
  onTogglePanel,
  settings,
}: {
  bot: PublicBot;
  pill: RefObject<HTMLButtonElement | null>;
  panelOpen: boolean;
  onTogglePanel(): void;
  settings: AppSettings;
}) {
  const [view] = useState(() => new TranscriptView());
  const entries = useSyncExternalStore(
    useCallback((onChange) => view.subscribe(onChange), [view]),
    () => view.entries(),
  );
  const [stream, setStream] = useState<StreamState | "ended">("connecting");
  const [problem, setProblem] = useState<string>();
  /** Sent messages not yet back from the gateway. */
  const [pending, setPending] = useState<PendingMessage[]>([]);

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

  // Forget pending messages once the gateway's copy has arrived.
  useEffect(() => {
    setPending((list) => {
      if (list.length === 0) return list;
      const left = list.filter((p) => !isConfirmed(p, entries));
      return left.length === list.length ? list : left;
    });
  }, [entries]);

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
      answerChoice: (entry: TranscriptEntry, answer: string) =>
        call("answerChoice", bot.id, entry.id, answer).catch((err: unknown) => {
          setProblem(message(err));
          throw err;
        }),
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

  /** Shows the message at once (pending), then sends it; the gateway's copy replaces it by nonce. */
  const send = useCallback(
    async (text: string) => {
      const nonce = crypto.randomUUID();
      setPending((list) => [...list, { nonce, text, at: Date.now() }]);
      try {
        let entryId = "";
        await report(async () => {
          entryId = await call("sendMessage", bot.id, text, nonce);
        });
        // The id matches the entry even if this gateway doesn't echo nonces.
        if (entryId) setPending((list) => list.map((p) => (p.nonce === nonce ? { ...p, entryId } : p)));
      } catch (err) {
        setPending((list) => list.filter((p) => p.nonce !== nonce)); // the draft is kept instead
        throw err;
      }
    },
    [bot.id, report],
  );

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
      <Transcript entries={entries} pending={pending} context={context} label={`Conversation with ${bot.name}`} />
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
        onSend={send}
        onStop={() => report(() => call("interrupt", bot.id))}
        sendWithCtrlEnter={settings.sendWithCtrlEnter}
        spellcheck={settings.spellcheck}
      />
    </div>
  );
}
