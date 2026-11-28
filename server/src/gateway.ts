// The gateway: runs a bot's chosen provider and turns its events into transcript entries.
import { randomUUID } from "node:crypto";
import { Waiters } from "./approvals.ts";
import type { BotRegistry } from "./bots.ts";
import { checkCardAnswer } from "./cards.ts";
import type { ComputerManager } from "./computer.ts";
import type { ProviderRegistry } from "./providers/index.ts";
import type { TranscriptStore } from "./transcript.ts";
import {
  type AgentProvider,
  type ApprovalDecision,
  type Bot,
  type BotActivity,
  type CardAnswer,
  type CardKind,
  type ConversationSession,
  type EntryBody,
  type Feedback,
  freeColor,
  isReaction,
  MAX_BOT_NAME,
  type NewBot,
  type ProviderEvent,
  type RunOutcome,
  type TranscriptEntry,
} from "./types.ts";

/** What the model is told when the user denies a tool call without giving a reason. */
export const DENIED_WITHOUT_REASON = "The user denied this action.";

/** Longest answer the user may type into a choice card. */
export const MAX_CUSTOM_ANSWER = 500;

/** What starting fresh leaves in the chat, where the new conversation begins. */
export const FRESH_NOTICE = "New conversation. Earlier messages stay above for reference.";

/** How much of a thread's root message its first prompt quotes. */
export const THREAD_QUOTE_CHARS = 500;

/** The first prompt of a thread: which message it's about, then what the user wrote. */
export function threadPrompt(rootText: string, text: string): string {
  // By code points, so an emoji is never cut in half.
  const chars = Array.from(rootText.replace(/\s+/g, " ").trim());
  const quote =
    chars.length > THREAD_QUOTE_CHARS ? `${chars.slice(0, THREAD_QUOTE_CHARS - 1).join("")}…` : chars.join("");
  return `(Replying in a thread to: "${quote}")\n\n${text}`;
}

export class BotNotFoundError extends Error {}
export class BotBusyError extends Error {}
/** A change the bot can't take, like deleting the main bot. */
export class BotRuleError extends Error {}
/** A bot's files couldn't be deleted (one is open in another program, say). The bot is kept. */
export class BotFilesError extends Error {}

interface ActiveRun {
  controller: AbortController;
  done: Promise<void>;
}

export function botInstructions(bot: Bot): string {
  return [
    `You are ${bot.name}, a personal assistant bot in the SmartyPrompts app.`,
    `You have your own computer: your working directory is your home. Keep your files there.`,
    `Reusable skills live in agent-data/workflows/<skill-name>/SKILL.md and are shared with the user's other bots.`,
    `Be warm and concise. Ask before doing anything that sends messages, spends money, or deletes data.`,
  ].join("\n");
}

export class Gateway {
  private readonly bots: BotRegistry;
  private readonly store: TranscriptStore;
  private readonly providers: ProviderRegistry;
  private readonly computers: ComputerManager;
  private readonly approvals = new Waiters<ApprovalDecision>({ allow: false, reason: "The run was stopped." });
  /** A stopped run settles a pending choice with undefined (no answer). */
  private readonly choices = new Waiters<string | undefined>(undefined);
  /** A stopped run settles a pending card with undefined (no answer). */
  private readonly cards = new Waiters<CardAnswer | undefined>(undefined);
  private readonly active = new Map<string, ActiveRun>();
  /** Bots being deleted: no run may start while their files go. */
  private readonly deleting = new Set<string>();
  /** Ids of bots deleted since this gateway started; a new bot doesn't take one. */
  private readonly retiredIds = new Set<string>();
  private readonly activityListeners = new Set<(bots: BotActivity[]) => void>();
  /** How each bot's last run ended, for activity snapshots. */
  private readonly lastRuns = new Map<string, RunOutcome["status"]>();

  constructor(bots: BotRegistry, store: TranscriptStore, providers: ProviderRegistry, computers: ComputerManager) {
    this.bots = bots;
    this.store = store;
    this.providers = providers;
    this.computers = computers;
    this.closeLeftovers();
  }

  /**
   * A gateway that stopped mid-run (crash, killed process) leaves entries saying "running" or "pending" with
   * nothing behind them: cards nobody can answer, runs that never end. On startup they're closed: runs become
   * interrupted, cards expired, streaming text final, running steps failed.
   */
  private closeLeftovers(): void {
    for (const bot of this.bots.list()) {
      for (const entry of this.store.list(bot.id)) {
        const b = entry.body;
        const closed: EntryBody | undefined =
          b.kind === "run" && b.state === "running"
            ? { ...b, state: "interrupted" }
            : (b.kind === "approval" || b.kind === "choice" || b.kind === "card") && b.state === "pending"
              ? { ...b, state: "expired" }
              : b.kind === "assistant_text" && b.streaming
                ? { ...b, streaming: false }
                : b.kind === "status" && b.state === "running"
                  ? { ...b, state: "failed" }
                  : undefined;
        if (closed) this.store.update(bot.id, entry.id, () => closed);
      }
    }
  }

  isRunning(botId: string): boolean {
    return this.active.has(botId);
  }

  /** Every bot and whether it's running. */
  activity(): BotActivity[] {
    return this.bots.list().map((bot) => {
      const lastRun = this.lastRuns.get(bot.id);
      return { botId: bot.id, running: this.active.has(bot.id), ...(lastRun ? { lastRun } : {}) };
    });
  }

  /** Called with a fresh snapshot whenever a run starts or ends. Returns the unsubscribe function. */
  subscribeActivity(listener: (bots: BotActivity[]) => void): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  private activityChanged(): void {
    const bots = this.activity();
    for (const listener of this.activityListeners) {
      try {
        listener(bots);
      } catch (err) {
        console.error("An activity listener failed:", err);
      }
    }
  }

  /**
   * Records the user's message and starts a run. Resolves once the run has started, not finished. With `threadId`
   * (a main-chat message's id) the message goes in that message's thread.
   */
  async sendMessage(
    botId: string,
    text: string,
    clientNonce?: string,
    threadId?: string,
    cardKinds: readonly CardKind[] = [],
  ): Promise<{ entry: TranscriptEntry; done: Promise<void> }> {
    const bot = this.bots.get(botId);
    if (!bot) throw new BotNotFoundError(`Unknown bot ${botId}`);
    if (this.active.has(botId)) throw new BotBusyError(`${bot.name} is still working on the last message.`);
    if (this.deleting.has(botId)) throw new BotBusyError(`${bot.name} is being deleted.`);
    const provider = this.providers.get(bot.provider);
    if (!provider) throw new Error(`No provider registered for ${bot.provider}`);
    const root = threadId === undefined ? undefined : this.threadRoot(botId, threadId);
    // Until the thread's session holds something (its first run, again after a roll back to it or a failed start),
    // the message says which message the thread is about.
    const stored = root ? bot.threadSessions?.[root.id] : undefined;
    const prompt = root && !stored?.sessionId ? threadPrompt(root.text, text) : text;
    const session = root ? (stored ?? this.threadStart(bot, root.id)) : mainSession(bot);

    const controller = new AbortController();
    // Claim the bot before any await, so a second message can't start a parallel run.
    const run: ActiveRun = { controller, done: Promise.resolve() };
    this.active.set(botId, run);

    const runId = randomUUID();
    let entry: TranscriptEntry;
    try {
      entry = this.store.append(
        botId,
        { kind: "user_message", text, ...(clientNonce ? { clientNonce } : {}) },
        { runId, threadId },
      );
    } catch (err) {
      // Release the claim, or the bot would look busy until the gateway restarts.
      this.active.delete(botId);
      throw err;
    }
    // This run's outcome replaces the last one's; if it throws before saying, it failed.
    this.lastRuns.delete(botId);
    this.activityChanged();
    const kinds = [...cardKinds];
    run.done = this.execute(bot, provider, prompt, controller, { runId, threadId, session, cardKinds: kinds }).finally(
      () => {
        if (!this.lastRuns.has(botId)) this.lastRuns.set(botId, "failed");
        this.active.delete(botId);
        this.activityChanged();
      },
    );
    return { entry, done: run.done };
  }

  /**
   * Changes a bot's settings. Switching provider is refused during a run; when it happens, the old session and
   * model are dropped (by the registry) and a notice says so in the transcript.
   */
  updateBot(botId: string, change: BotChange): Bot {
    const bot = this.bots.get(botId);
    if (!bot) throw new BotNotFoundError(`Unknown bot ${botId}`);
    const { main, ...patch } = change;
    if (main && patch.hidden) throw new BotRuleError("The main bot is always shown.");
    if (patch.hidden && botId === this.bots.mainId()) throw new BotRuleError("The main bot is always shown.");
    const switching = patch.provider !== undefined && patch.provider !== bot.provider;
    if (switching && this.active.has(botId)) throw new BotBusyError("Can't change provider during a run.");
    if (patch.provider && !this.providers.has(patch.provider)) throw new Error(`Unknown provider ${patch.provider}`);
    // Every check is above: a refused change must not have moved the main bot.
    // The main bot can't be hidden, so a hidden bot made main is shown again.
    if (main && bot.hidden) patch.hidden = false;
    let next = this.bots.update(botId, patch);
    if (main) {
      this.bots.makeMain(botId);
      next = this.bots.get(botId) ?? next;
      this.activityChanged();
    }
    if (switching) {
      const label = this.providers.get(next.provider)?.info?.().label ?? next.provider;
      const model = next.model ? ` (${next.model})` : "";
      this.store.append(botId, {
        kind: "notice",
        text: `Switched to ${label}${model}. The conversation starts fresh for the new model.`,
        reset: true,
      });
    }
    return next;
  }

  /**
   * Creates a bot. It starts on the main bot's provider, model and server, so it works at once with what's set
   * up; its id comes from its name.
   */
  createBot(input: NewBot): Bot {
    const name = input.name.trim();
    if (!name) throw new BotRuleError("A bot needs a name.");
    if (Array.from(name).length > MAX_BOT_NAME) throw new BotRuleError(`Names are at most ${MAX_BOT_NAME} characters.`);
    const all = this.bots.list();
    const main = all[0];
    const bot: Bot = {
      // Not the id of a bot deleted while this gateway runs: a client may still hold a stream cursor for it, and
      // the new bot's transcript counts from zero again.
      id: uniqueId(name, new Set([...all.map((b) => b.id), ...this.retiredIds])),
      name,
      provider: main?.provider ?? "claude",
      ...(main?.model ? { model: main.model } : {}),
      ...(main?.baseUrl ? { baseUrl: main.baseUrl } : {}),
      avatar: input.avatar ?? { shape: "circle", color: freeColor(all) },
    };
    this.bots.add(bot);
    this.activityChanged();
    return bot;
  }

  /**
   * Deletes a bot: its entry, its transcript and its computer (workspace files). Not the main bot, and not while
   * it's running (stop it first, so nothing writes into what's being deleted).
   */
  async deleteBot(botId: string): Promise<void> {
    const bot = this.bots.get(botId);
    if (!bot) throw new BotNotFoundError(`Unknown bot ${botId}`);
    if (botId === this.bots.mainId()) throw new BotRuleError("The main bot can't be deleted.");
    if (this.active.has(botId)) throw new BotBusyError(`${bot.name} is working. Stop it first.`);
    if (this.deleting.has(botId)) throw new BotBusyError(`${bot.name} is already being deleted.`);
    this.deleting.add(botId);
    try {
      // Files first, the registry last: if a file can't go, the bot stays and the delete can be tried again.
      try {
        await this.computers.remove(botId);
        this.store.forget(botId);
      } catch (err) {
        console.error(`Couldn't delete ${bot.name}'s files`, err);
        throw new BotFilesError(
          `Couldn't delete ${bot.name}'s files: ${err instanceof Error ? err.message : String(err)}. ` +
            "Close any program using them, then try again.",
        );
      }
      this.bots.remove(botId);
      this.retiredIds.add(botId);
      this.lastRuns.delete(botId);
      this.activityChanged();
    } finally {
      this.deleting.delete(botId);
    }
  }

  /**
   * Starts the main conversation over: the bot forgets it, and a notice marks where the new one begins. Every entry
   * stays to read. Threads keep their own sessions.
   */
  startFresh(botId: string): void {
    this.idleBot(botId);
    this.saveSession(botId, undefined, {});
    this.store.append(botId, { kind: "notice", text: FRESH_NOTICE, reset: true });
  }

  /**
   * Takes a conversation (the main one, or the message's thread) back to before one of the user's messages: it and
   * everything after it are hidden, and the bot's session goes back to where it stood then. Returns the message's
   * text, to edit and send again. Files the bot changed stay changed.
   */
  rollBack(botId: string, entryId: string): { text: string } {
    const bot = this.idleBot(botId);
    const target = this.store.get(botId, entryId);
    if (target?.body.kind !== "user_message" || target.hidden) {
      throw new BotRuleError("Only a message you sent can be rolled back to.");
    }
    const { threadId } = target;
    const all = this.store.list(botId);
    const here = (e: TranscriptEntry) => !e.hidden && e.threadId === threadId;
    const hide = all.filter((e) => here(e) && e.seq >= target.seq).map((e) => e.id);
    const threadSessions = { ...bot.threadSessions };
    if (threadId === undefined) {
      // A thread whose root goes goes with it.
      const gone = new Set(hide);
      for (const e of all) if (!e.hidden && e.threadId !== undefined && gone.has(e.threadId)) hide.push(e.id);
      for (const root of gone) delete threadSessions[root];
    }

    // Back from the message: the first earlier run that left a checkpoint is where the session stood (runs without
    // one never changed it). Nothing from before a fresh start, or from another provider, is kept.
    let point: ConversationSession = {};
    for (let i = all.findIndex((e) => e.id === target.id) - 1; i >= 0; i--) {
      const e = all[i];
      if (!e || !here(e)) continue;
      const b = e.body;
      if (b.kind === "notice" && b.reset) break;
      if (b.kind !== "run") continue;
      if (b.provider !== bot.provider) break;
      if (b.checkpoint) {
        point = { sessionId: b.checkpoint.sessionId, sessionProvider: b.provider, sessionAt: b.checkpoint.at };
        break;
      }
    }

    this.store.hide(botId, hide);
    if (threadId === undefined) {
      this.bots.update(botId, { threadSessions });
      this.saveSession(botId, undefined, point);
    } else {
      // A thread with nothing left to keep forks from its root again, as on its first message.
      if (point.sessionId) threadSessions[threadId] = point;
      else delete threadSessions[threadId];
      this.bots.update(botId, { threadSessions });
    }
    return { text: target.body.text };
  }

  /** The bot, if it exists and isn't running or being deleted: conversation controls only act on a still bot. */
  private idleBot(botId: string): Bot {
    const bot = this.bots.get(botId);
    if (!bot) throw new BotNotFoundError(`Unknown bot ${botId}`);
    if (this.active.has(botId)) throw new BotBusyError(`${bot.name} is working. Stop it first.`);
    if (this.deleting.has(botId)) throw new BotBusyError(`${bot.name} is being deleted.`);
    return bot;
  }

  /** A thread's root: a visible message of the main conversation, yours or the bot's. */
  private threadRoot(botId: string, threadId: string): { id: string; text: string } {
    const root = this.store.get(botId, threadId);
    const b = root?.body;
    if (!root || root.hidden || root.threadId !== undefined)
      throw new BotRuleError("That message can't start a thread.");
    if (b?.kind !== "user_message" && b?.kind !== "assistant_text") {
      throw new BotRuleError("That message can't start a thread.");
    }
    return { id: root.id, text: b.text };
  }

  /**
   * Where a new thread's session starts: a fork from the end of the run that holds its root, so the bot remembers
   * the conversation up to there. None when that run left no checkpoint or ran on another provider.
   */
  private threadStart(bot: Bot, rootId: string): ConversationSession {
    const root = this.store.get(bot.id, rootId);
    if (!root) return {};
    // User messages from before threads didn't carry their run's id: their run is the first one after them.
    const run = root.runId
      ? this.store.get(bot.id, root.runId)
      : this.store.list(bot.id).find((e) => e.seq > root.seq && e.threadId === undefined && e.body.kind === "run");
    const b = run?.body;
    if (b?.kind !== "run" || !b.checkpoint || b.provider !== bot.provider) return {};
    return { sessionId: b.checkpoint.sessionId, sessionProvider: b.provider, sessionAt: b.checkpoint.at };
  }

  /** Saves where a conversation's session stands, the main one's or a thread's. Fields left out are cleared. */
  private saveSession(botId: string, threadId: string | undefined, session: ConversationSession): void {
    const bot = this.bots.get(botId);
    if (!bot) return;
    if (threadId === undefined) {
      this.bots.update(botId, {
        sessionId: session.sessionId,
        sessionProvider: session.sessionProvider,
        sessionAt: session.sessionAt,
      });
    } else {
      this.bots.update(botId, { threadSessions: { ...bot.threadSessions, [threadId]: session } });
    }
  }

  /**
   * Adds (`on`) or removes one of the user's reactions on a message, yours or the bot's. Returns the message's
   * reactions now. They stay on this machine: the model never sees them.
   */
  react(botId: string, entryId: string, emoji: string, on: boolean): string[] {
    const entry = this.visibleMessage(botId, entryId, "Only messages can have reactions.");
    if (!isReaction(emoji)) throw new BotRuleError("That reaction isn't one of the choices.");
    const now = entry.reactions ?? [];
    const next = on ? (now.includes(emoji) ? now : [...now, emoji]) : now.filter((r) => r !== emoji);
    if (next.length === now.length && next.every((r, i) => r === now[i])) return now;
    this.store.mark(botId, entryId, { reactions: next.length ? next : undefined });
    return next;
  }

  /** Sets (or with null clears) the user's rating of a bot message. Kept on this machine, never sent anywhere. */
  rate(botId: string, entryId: string, vote: Feedback | null): Feedback | null {
    const entry = this.visibleMessage(botId, entryId, "Only the bot's replies can be rated.");
    if (entry.body.kind !== "assistant_text") throw new BotRuleError("Only the bot's replies can be rated.");
    if ((entry.feedback ?? null) !== vote) this.store.mark(botId, entryId, { feedback: vote ?? undefined });
    return vote;
  }

  /** A message the user can see: theirs or the bot's, not rolled back. `notOne` is what to say about anything else. */
  private visibleMessage(botId: string, entryId: string, notOne: string): TranscriptEntry {
    if (!this.bots.get(botId)) throw new BotNotFoundError(`Unknown bot ${botId}`);
    const entry = this.store.get(botId, entryId);
    if (!entry || entry.hidden) throw new BotRuleError("That message isn't in the conversation anymore.");
    const kind = entry.body.kind;
    if (kind !== "user_message" && kind !== "assistant_text") throw new BotRuleError(notOne);
    return entry;
  }

  /** Stops the bot's current run. Returns false when nothing is running. */
  interrupt(botId: string): boolean {
    const run = this.active.get(botId);
    if (!run) return false;
    run.controller.abort();
    return true;
  }

  /** Interrupts every run and waits for each to record how it ended, so nothing is cut off mid-write. */
  async shutdown(): Promise<void> {
    const runs = [...this.active.values()];
    for (const run of runs) run.controller.abort();
    await Promise.allSettled(runs.map((run) => run.done));
  }

  /** Answers an approval card. Returns false if the card isn't pending. */
  answerApproval(botId: string, entryId: string, decision: ApprovalDecision): boolean {
    const entry = this.store.get(botId, entryId);
    if (entry?.body.kind !== "approval" || entry.body.state !== "pending") return false;
    return this.approvals.answer(entryId, decision);
  }

  /**
   * Answers a choice card. The answer must be one of its options' values, or (when the card allows it) the user's
   * own text. Returns "not-pending" when the card isn't waiting, "invalid" when the answer doesn't fit.
   */
  answerChoice(botId: string, entryId: string, answer: string): "ok" | "not-pending" | "invalid" {
    const entry = this.store.get(botId, entryId);
    if (entry?.body.kind !== "choice" || entry.body.state !== "pending") return "not-pending";
    const card = entry.body;
    const text = answer.trim();
    const listed = card.options.some((o) => o.value === answer);
    if (!listed && !(card.allowCustom && text.length > 0 && text.length <= MAX_CUSTOM_ANSWER)) return "invalid";
    return this.choices.answer(entryId, listed ? answer : text) ? "ok" : "not-pending";
  }

  /**
   * Answers a card (#19). The answer must fit the card (checkCardAnswer); it then reaches the run waiting on it, and
   * the card locks with it. "not-pending" when the card isn't waiting.
   */
  answerCard(
    botId: string,
    entryId: string,
    answer: unknown,
  ): { result: "ok" } | { result: "not-pending" } | { result: "invalid"; error: string } {
    const entry = this.store.get(botId, entryId);
    if (entry?.body.kind !== "card" || entry.body.state !== "pending") return { result: "not-pending" };
    const checked = checkCardAnswer(entry.body.card, answer);
    if (!checked.ok) return { result: "invalid", error: checked.error };
    return this.cards.answer(entryId, checked.answer) ? { result: "ok" } : { result: "not-pending" };
  }

  private async execute(
    bot: Bot,
    provider: AgentProvider,
    text: string,
    controller: AbortController,
    {
      runId,
      threadId,
      session,
      cardKinds,
    }: { runId: string; threadId: string | undefined; session: ConversationSession; cardKinds: CardKind[] },
  ): Promise<void> {
    // Everything written during this run carries its id (the run entry included) and its thread.
    const append = (body: EntryBody, id?: string) => this.store.append(bot.id, body, { id, runId, threadId });
    const runEntry = append({ kind: "run", provider: provider.id, state: "running" }, runId);
    /** The session this run is on, once the provider says, and the last point it reached. */
    let sessionNow: string | undefined;
    let checkpoint: { sessionId: string; at: string } | undefined;
    const textEntries = new Map<string, string>(); // provider blockId -> entry id
    const toolEntries = new Map<string, string>(); // toolUseId -> entry id

    const set = (id: string, change: (b: EntryBody) => EntryBody) => this.store.update(bot.id, id, change);

    const onEvent = (ev: ProviderEvent) => {
      switch (ev.type) {
        case "session":
          sessionNow = ev.sessionId;
          return;
        case "checkpoint": {
          if (!sessionNow) return;
          checkpoint = { sessionId: sessionNow, at: ev.at };
          // Kept on the run as it goes, so a crash mid-run still leaves where the session got to.
          const at = checkpoint;
          set(runEntry.id, (b) =>
            b.kind === "run" && (b.checkpoint?.sessionId !== at.sessionId || b.checkpoint.at !== at.at)
              ? { ...b, checkpoint: at }
              : b,
          );
          // The session now holds something (a fork has been written): it becomes the conversation's, and a pending
          // fork point is used up. Not on the session event: a forked session may not be saved yet then.
          const stored = this.bots.get(bot.id);
          const now = stored && (threadId === undefined ? mainSession(stored) : stored.threadSessions?.[threadId]);
          if (now?.sessionId !== sessionNow || now.sessionProvider !== provider.id || now.sessionAt !== undefined) {
            this.saveSession(bot.id, threadId, { sessionId: sessionNow, sessionProvider: provider.id });
          }
          return;
        }
        case "text_delta": {
          const id = textEntries.get(ev.blockId);
          if (!id) {
            const e = append({ kind: "assistant_text", text: ev.text, streaming: true });
            textEntries.set(ev.blockId, e.id);
          } else {
            set(id, (b) => (b.kind === "assistant_text" ? { ...b, text: b.text + ev.text } : b));
          }
          return;
        }
        case "text": {
          if (!ev.text.trim()) return;
          const id = textEntries.get(ev.blockId);
          if (!id) {
            const e = append({ kind: "assistant_text", text: ev.text, streaming: false });
            textEntries.set(ev.blockId, e.id);
          } else {
            set(id, () => ({ kind: "assistant_text", text: ev.text, streaming: false }));
          }
          return;
        }
        case "tool_start": {
          const e = append({ kind: "status", label: ev.summary, tool: ev.tool, state: "running" });
          toolEntries.set(ev.toolUseId, e.id);
          return;
        }
        case "tool_end": {
          const id = toolEntries.get(ev.toolUseId);
          if (id) set(id, (b) => (b.kind === "status" ? { ...b, state: ev.ok ? "done" : "failed" } : b));
          return;
        }
      }
    };

    let outcome: RunOutcome;
    try {
      const computer = await this.computers.ensure(bot.id);
      const resumable = session.sessionProvider === provider.id ? session.sessionId : undefined;
      outcome = await provider.run(
        {
          botId: bot.id,
          botName: bot.name,
          prompt: text,
          sessionId: resumable,
          ...(resumable && session.sessionAt !== undefined ? { resumeAt: session.sessionAt } : {}),
          cardKinds,
          model: bot.model,
          baseUrl: bot.baseUrl,
          workspaceDir: computer.workspaceDir,
          instructions: botInstructions(bot),
          signal: controller.signal,
        },
        {
          emit: (ev) => {
            try {
              onEvent(ev);
            } catch (err) {
              console.error("failed to record provider event", ev.type, err);
            }
          },
          requestApproval: async (req, signal) => {
            // Start waiting before the card is posted: a listener may answer it the moment it appears.
            const cardId = randomUUID();
            const cancelled = anySignal(signal, controller.signal);
            const answer = this.approvals.wait(cardId, cancelled);
            let card: TranscriptEntry;
            try {
              card = append({ kind: "approval", ...req, state: "pending" }, cardId);
            } catch (err) {
              this.approvals.answer(cardId, { allow: false, reason: "The card couldn't be shown." }); // drop the waiter
              throw err;
            }
            const decision = await answer;
            // A denial without a reason shows as plain "Denied"; the model still gets a sentence to act on.
            const reason = decision.allow ? "" : decision.reason.trim();
            set(card.id, (b) =>
              b.kind === "approval"
                ? {
                    ...b,
                    state: decision.allow ? "approved" : cancelled.aborted ? "expired" : "denied",
                    ...(reason ? { reason } : {}),
                  }
                : b,
            );
            return decision.allow ? decision : { allow: false, reason: reason || DENIED_WITHOUT_REASON };
          },
          requestChoice: async (req, signal) => {
            const cardId = randomUUID();
            const cancelled = anySignal(signal, controller.signal);
            const answer = this.choices.wait(cardId, cancelled);
            try {
              append({ kind: "choice", ...req, state: "pending" }, cardId);
            } catch (err) {
              this.choices.answer(cardId, undefined); // drop the waiter
              throw err;
            }
            const chosen = await answer;
            set(cardId, (b) =>
              b.kind === "choice"
                ? chosen === undefined
                  ? { ...b, state: "expired" }
                  : { ...b, state: "answered", answer: chosen }
                : b,
            );
            return chosen;
          },
          requestCard: async (card, signal) => {
            // Behind the tools' own check: a card the user's app can't show would wait forever.
            if (!cardKinds.includes(card.kind)) throw new Error(`This app can't show ${card.kind} cards.`);
            const cardId = randomUUID();
            const cancelled = anySignal(signal, controller.signal);
            const answer = this.cards.wait(cardId, cancelled);
            try {
              append({ kind: "card", card, state: "pending" }, cardId);
            } catch (err) {
              this.cards.answer(cardId, undefined); // drop the waiter
              throw err;
            }
            const got = await answer;
            set(cardId, (b) =>
              b.kind === "card"
                ? got === undefined
                  ? { ...b, state: "expired" }
                  : { ...b, state: "answered", answer: got }
                : b,
            );
            return got;
          },
        },
      );
    } catch (err) {
      outcome = controller.signal.aborted
        ? { status: "interrupted" }
        : { status: "failed", error: err instanceof Error ? err.message : String(err) };
    }

    // Close anything still marked as in progress.
    for (const id of textEntries.values()) {
      set(id, (b) => (b.kind === "assistant_text" && b.streaming ? { ...b, streaming: false } : b));
    }
    for (const id of toolEntries.values()) {
      set(id, (b) => (b.kind === "status" && b.state === "running" ? { ...b, state: "failed" } : b));
    }
    if (outcome.status === "failed") {
      append({ kind: "error", message: outcome.error ?? "Something went wrong." });
      // A fork that failed before any session started would fail the same way every time: drop it, so the next
      // message starts this conversation over (a thread then quotes its root again) instead of failing forever.
      if (session.sessionAt !== undefined && sessionNow === undefined) this.saveSession(bot.id, threadId, {});
    }
    this.lastRuns.set(bot.id, outcome.status);
    set(runEntry.id, (b) =>
      b.kind === "run"
        ? {
            ...b,
            state: outcome.status,
            ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
            ...(checkpoint ? { checkpoint } : {}),
          }
        : b,
    );
  }
}

/** The main conversation's session, as stored on the bot. */
function mainSession(bot: Bot): ConversationSession {
  return { sessionId: bot.sessionId, sessionProvider: bot.sessionProvider, sessionAt: bot.sessionAt };
}

function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  return AbortSignal.any([a, b]);
}

/** A bot change: its settings, or `main: true` to make it the main bot. */
export type BotChange = Partial<
  Pick<Bot, "name" | "provider" | "model" | "baseUrl" | "pinned" | "hidden" | "avatar">
> & {
  main?: true;
};

const WINDOWS_DEVICE_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/** A path-safe id from a name ("Nova Two" -> "nova-two"), numbered when taken ("nova-2"). */
export function uniqueId(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30)
      .replace(/-+$/, "") || "bot";
  // The id becomes a folder name, and Windows reserves these names for devices ("con" can't be a folder).
  const usable = (id: string) => !taken.has(id) && !WINDOWS_DEVICE_NAMES.test(id);
  if (usable(base)) return base;
  for (let n = 2; ; n++) if (usable(`${base}-${n}`)) return `${base}-${n}`;
}
