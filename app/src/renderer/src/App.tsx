// The app's main screen: the bot sidebar, the open bot's chat, and the bot panel. App owns what's shared between
// them (the bots, the selection, every bot's activity, new replies, the panel); Chat owns one conversation.
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { StreamState } from "../../../../server/src/client/subscribe.ts";
import { TranscriptView } from "../../../../server/src/client/transcript-view.ts";
import type {
  AvatarColor,
  AvatarShape,
  BotActivity,
  CardAnswerIn,
  ProviderSummary,
  PublicBot,
  TranscriptEntry,
} from "../../../../server/src/types.ts";
import type { ConnectionInfo } from "../../shared/ipc.ts";
import { type AppSettings, DEFAULT_SETTINGS } from "../../shared/settings.ts";
import { botColor } from "./bot-colors.ts";
import { RENDERED_CARD_KINDS } from "./chat/Card.tsx";
import type { RowContext } from "./chat/ChatRow.tsx";
import { Composer } from "./chat/Composer.tsx";
import { conversation, isConfirmed, type PendingMessage, replyCounts, waitingThreads } from "./chat/rows.ts";
import { Transcript } from "./chat/Transcript.tsx";
import { call } from "./gateway.ts";
import { Onboarding } from "./onboarding/Onboarding.tsx";
import { GeneralPage } from "./settings/GeneralPage.tsx";
import { ModelsPage } from "./settings/ModelsPage.tsx";
import { SettingsDialog, type SettingsPage } from "./settings/SettingsDialog.tsx";
import { UsagePage } from "./settings/UsagePage.tsx";
import { Avatar } from "./shell/Avatar.tsx";
import { ConfirmDialog, DeleteBotDialog } from "./shell/BotMenu.tsx";
import { BotPanel, PANEL_ID } from "./shell/BotPanel.tsx";
import { CreateBotDialog } from "./shell/CreateBotDialog.tsx";
import { noteActivity } from "./shell/face-director.ts";
import { type PaletteChoice, SearchPalette } from "./shell/SearchPalette.tsx";
import { ShortcutsDialog } from "./shell/ShortcutsDialog.tsx";
import { Sidebar } from "./shell/Sidebar.tsx";
import { matchShortcut } from "./shell/shortcuts.ts";
import { afterDelete, freeColor, type MenuAction, nextUnread, sidebarLayout } from "./shell/sidebar-state.ts";
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
  /** The bot starting fresh, while its confirmation is open. */
  const [freshening, setFreshening] = useState<{ bot: PublicBot; busy: boolean; error?: string }>();
  /** Create New Bot is open. */
  const [creating, setCreating] = useState(false);
  /** The search palette and the shortcuts sheet (#23). */
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** A message to scroll to and highlight, from the palette; `n` makes the same message count again. */
  const [jump, setJump] = useState<{ botId: string; entryId: string; threadId?: string; n: number }>();
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
        noteActivity(before, event.bots);
        setActivity(event.bots);
        setUnread((u) => nextUnread(u, before, event.bots, selectedNow.current));
        setActivityError(undefined);
      } else if (event.kind === "ended") {
        // No more updates: show nothing rather than a state that may be stale ("working" forever).
        noteActivity(activityNow.current, []);
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
        if (action === "start-fresh") return setFreshening({ bot, busy: false });
        if (action === "copy-id") return await navigator.clipboard.writeText(bot.id);
        if (action === "make-main") {
          const updated = await call("updateBot", bot.id, { main: true });
          // The gateway moved it first and kept the others in order: the same here.
          setBots((list) => [updated, ...list.filter((b) => b.id !== updated.id)]);
          return;
        }
        const patch =
          action === "pin" || action === "unpin" ? { pinned: action === "pin" } : { hidden: action === "hide" };
        replaceBot(await call("updateBot", bot.id, patch));
        // A hidden bot has no tile to show which chat is open: go to the main bot, as after a delete.
        if (action === "hide") setSelected((current) => afterDelete(mainId, bot.id, current));
      } catch (err) {
        setBotError(`Couldn't ${action === "copy-id" ? "copy the bot ID" : "change the bot"}: ${message(err)}`);
      }
    },
    [replaceBot, mainId],
  );

  const createBot = useCallback(
    async (input: { name: string; avatar: { shape: AvatarShape; color: AvatarColor } }) => {
      const created = await call("createBot", input);
      setBots((list) => [...list, created]);
      setCreating(false);
      select(created.id);
      setRefocus({ botId: created.id });
    },
    [select],
  );

  /** Avatar saves, one at a time and in order, so quick picks can't land out of order; the last one wins. */
  const avatarSaves = useRef<Promise<void>>(Promise.resolve());
  const avatarLatest = useRef(0);
  const changeAvatar = useCallback(
    (botId: string, avatar: { shape: AvatarShape; color: AvatarColor }) => {
      const n = ++avatarLatest.current;
      avatarSaves.current = avatarSaves.current.then(async () => {
        try {
          const updated = await call("updateBot", botId, { avatar });
          if (n === avatarLatest.current) replaceBot(updated);
          setBotError(undefined);
        } catch (err) {
          setBotError(`Couldn't change the avatar: ${message(err)}`);
        }
      });
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

  const confirmFresh = useCallback(async () => {
    if (!freshening) return;
    const { bot } = freshening;
    setFreshening({ bot, busy: true });
    try {
      await call("startFresh", bot.id);
      setFreshening(undefined);
      setRefocus({ botId: bot.id });
    } catch (err) {
      setFreshening({ bot, busy: false, error: message(err) });
    }
  }, [freshening]);

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
  const isMac = navigator.platform.startsWith("Mac");
  /** The bots as the sidebar shows them (hidden ones aside): the order of Go to bot and Previous / next bot. */
  const order = useMemo(() => {
    const { top, rest } = sidebarLayout(bots, false);
    return [...top, ...rest];
  }, [bots]);
  const anyDialog = paletteOpen || shortcutsOpen || creating || !!deleting || !!freshening || !!settingsOpen;

  // The app's keyboard shortcuts (#23): one listener, only while no dialog is open (a dialog keeps its keys).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || anyDialog) return;
      const hit = matchShortcut(e, isMac);
      if (!hit) return;
      e.preventDefault();
      switch (hit.action) {
        case "search":
          return setPaletteOpen(true);
        case "new-bot":
          return setCreating(true);
        case "shortcuts":
          return setShortcutsOpen(true);
        case "focus-chat":
          return document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
        case "details":
          return panelOpen ? closePanel() : setPanelOpen(true);
        case "go-to-bot": {
          const target = order[hit.index ?? 0];
          if (target) select(target.id);
          return;
        }
        case "previous-bot":
        case "next-bot": {
          if (order.length === 0) return;
          const at = order.findIndex((b) => b.id === selected);
          const step = hit.action === "next-bot" ? 1 : -1;
          const target = order[(at + step + order.length) % order.length];
          if (target) select(target.id);
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [anyDialog, isMac, order, selected, select, panelOpen, closePanel]);

  const choose = useCallback(
    (choice: PaletteChoice) => {
      setPaletteOpen(false);
      if (choice.kind === "bot") return select(choice.botId);
      if (choice.kind === "message") {
        const { botId, entryId, threadId } = choice.hit;
        select(botId);
        setJump((j) => ({ botId, entryId, ...(threadId ? { threadId } : {}), n: (j?.n ?? 0) + 1 }));
        return;
      }
      switch (choice.id) {
        case "new-bot":
          return setCreating(true);
        case "shortcuts":
          return setShortcutsOpen(true);
        case "settings":
          return setSettingsOpen({ page: "general" });
        case "models":
          return setSettingsOpen({ page: "models", ...(selected ? { botId: selected } : {}) });
        case "usage":
          return setSettingsOpen({ page: "usage" });
        case "start-fresh": {
          const current = bots.find((b) => b.id === selected);
          if (current) setFreshening({ bot: current, busy: false });
          return;
        }
      }
    },
    [select, selected, bots],
  );

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
        onNewBot={() => setCreating(true)}
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
            jump={jump?.botId === bot.id ? jump : undefined}
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
          onAvatar={(avatar) => changeAvatar(bot.id, avatar)}
          onChangeModel={() => setSettingsOpen({ page: "models", botId: bot.id })}
        />
      )}
      {creating && (
        <CreateBotDialog
          defaultColor={freeColor(bots)}
          onCreate={createBot}
          onCancel={() => {
            setCreating(false);
            requestAnimationFrame(() => document.querySelector<HTMLButtonElement>("[aria-label='New bot']")?.focus());
          }}
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
      {paletteOpen && (
        <SearchPalette
          bots={order}
          currentBotName={bot?.name}
          onChoose={choose}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {shortcutsOpen && <ShortcutsDialog isMac={isMac} onClose={() => setShortcutsOpen(false)} />}
      {freshening && (
        <ConfirmDialog
          title="Start a new conversation?"
          text={`${freshening.bot.name} won't remember this conversation. It stays here to read, and ${freshening.bot.name}'s files and settings are kept.`}
          confirmLabel="Start fresh"
          busyLabel="Starting…"
          busy={freshening.busy}
          error={freshening.error}
          onConfirm={() => void confirmFresh()}
          onCancel={() => {
            const id = freshening.bot.id;
            setFreshening(undefined);
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
          ) : settingsOpen.page === "usage" ? (
            <UsagePage bots={bots} />
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
  jump,
}: {
  bot: PublicBot;
  pill: RefObject<HTMLButtonElement | null>;
  panelOpen: boolean;
  onTogglePanel(): void;
  settings: AppSettings;
  /** A message to show: opens its thread if it's in one, scrolls to it and highlights it. */
  jump?: { entryId: string; threadId?: string; n: number };
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
  /** The open thread, by its root message's id; the main chat when undefined. */
  const [thread, setThread] = useState<string>();
  // A jump from the palette opens the message's conversation: its thread, or the main chat.
  useEffect(() => {
    if (jump) setThread(jump.threadId);
  }, [jump]);
  /** The message being rolled back to, while its confirmation is open. */
  const [rolling, setRolling] = useState<{ entry: TranscriptEntry; busy: boolean; error?: string }>();
  /** A rolled-back message's text, for the composer. */
  const [fill, setFill] = useState<{ text: string; n: number }>();

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

  // Any run keeps the bot busy, wherever it is (one run at a time): the main chat can't send during a thread's run.
  const lastRun = entries.findLast((e) => e.body.kind === "run");
  const busy = lastRun?.body.kind === "run" && lastRun.body.state === "running";
  const shown = useMemo(() => conversation(entries, thread), [entries, thread]);
  const replies = useMemo(() => replyCounts(entries), [entries]);
  const waiting = useMemo(() => waitingThreads(entries), [entries]);
  const shownPending = useMemo(() => pending.filter((p) => p.threadId === thread), [pending, thread]);

  // A thread whose root was rolled back (perhaps in another window) has nothing to show: back to the chat. Only a root
  // that's there and hidden counts: while the transcript is still arriving, the root may simply not be in yet.
  useEffect(() => {
    if (thread !== undefined && view.get(thread)?.hidden) setThread(undefined);
  }, [thread, entries, view]);

  const context = useMemo<RowContext>(
    () => ({
      botId: bot.id,
      botName: bot.name,
      botAvatar: bot.avatar,
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
      // The card shows the reason itself, next to what the user filled in.
      answerCard: (entry: TranscriptEntry, answer: CardAnswerIn) => call("answerCard", bot.id, entry.id, answer),
      resumeRun: (entry: TranscriptEntry) =>
        call("resumeRun", bot.id, entry.id, [...RENDERED_CARD_KINDS]).catch((err: unknown) => setProblem(message(err))),
      openThread: (entry: TranscriptEntry) => setThread(entry.id),
      rollBack: (entry: TranscriptEntry) => setRolling({ entry, busy: false }),
      react: (entry: TranscriptEntry, emoji: string, on: boolean) =>
        call("react", bot.id, entry.id, emoji, on).catch((err: unknown) => setProblem(message(err))),
      rate: (entry: TranscriptEntry, vote: "up" | "down" | null) =>
        call("rate", bot.id, entry.id, vote).catch((err: unknown) => setProblem(message(err))),
      copy: (text: string) =>
        navigator.clipboard.writeText(text).catch((err: unknown) => {
          setProblem(`Couldn't copy: ${message(err)}`);
          throw err;
        }),
    }),
    [bot.id, bot.name, bot.avatar],
  );

  const confirmRollBack = useCallback(async () => {
    if (!rolling) return;
    const { entry } = rolling;
    setRolling({ entry, busy: true });
    try {
      const text = await call("rollBack", bot.id, entry.id);
      setRolling(undefined);
      setFill((f) => ({ text, n: (f?.n ?? 0) + 1 }));
    } catch (err) {
      setRolling({ entry, busy: false, error: message(err) });
    }
  }, [rolling, bot.id]);

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
      setPending((list) => [...list, { nonce, text, at: Date.now(), ...(thread ? { threadId: thread } : {}) }]);
      try {
        let entryId = "";
        await report(async () => {
          // Every message says which card kinds this app can show, so the bot knows what it may post.
          entryId = await call("sendMessage", bot.id, text, nonce, thread, [...RENDERED_CARD_KINDS]);
        });
        // The id matches the entry even if this gateway doesn't echo nonces.
        if (entryId) setPending((list) => list.map((p) => (p.nonce === nonce ? { ...p, entryId } : p)));
      } catch (err) {
        setPending((list) => list.filter((p) => p.nonce !== nonce)); // the draft is kept instead
        throw err;
      }
    },
    [bot.id, report, thread],
  );

  const backToChat = useCallback(() => setThread(undefined), []);
  const consumeFill = useCallback(() => setFill(undefined), []);

  return (
    <div className="chat-body" data-bot-color={colorOf(bot)}>
      <header className="chat-header">
        {thread !== undefined && (
          <button type="button" className="back-to-chat" onClick={backToChat}>
            <svg className="icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M10 3.5L5.5 8l4.5 4.5" />
            </svg>
            Back to chat
          </button>
        )}
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
            <Avatar avatar={bot.avatar} size="small" botId={bot.id} />
            <span className="name">{bot.name}</span>
          </button>
          {thread !== undefined && <span className="chat-subtitle">Thread</span>}
        </h2>
      </header>
      <Transcript
        // Keys unique among the siblings (the composer has its own): each view mounts afresh, scrolled to its end.
        key={`transcript:${thread ?? "main"}`}
        entries={shown}
        pending={shownPending}
        context={context}
        thread={thread}
        replies={replies}
        waiting={waiting}
        focus={jump && jump.threadId === thread ? { entryId: jump.entryId, n: jump.n } : undefined}
        label={thread === undefined ? `Conversation with ${bot.name}` : `Thread with ${bot.name}`}
      />
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
        key={`composer:${thread ?? "main"}`}
        draftKey={thread === undefined ? bot.id : `${bot.id}#${thread}`}
        placeholder={thread === undefined ? `Message ${bot.name}` : "Reply in thread"}
        busy={busy}
        onSend={send}
        onStop={() => report(() => call("interrupt", bot.id))}
        onEscape={thread === undefined ? undefined : backToChat}
        fill={fill}
        onFilled={consumeFill}
        sendWithCtrlEnter={settings.sendWithCtrlEnter}
        spellcheck={settings.spellcheck}
      />
      {rolling && (
        <ConfirmDialog
          title="Roll back to this message?"
          text={`This message and everything after it are hidden, and ${bot.name} forgets them. Your message goes back in the message box to change and send again. Files ${bot.name} changed stay changed.`}
          confirmLabel="Roll back"
          busyLabel="Rolling back…"
          busy={rolling.busy}
          error={rolling.error}
          onConfirm={() => void confirmRollBack()}
          onCancel={() => {
            setRolling(undefined);
            document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus();
          }}
        />
      )}
    </div>
  );
}
