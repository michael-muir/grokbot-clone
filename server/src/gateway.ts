// The gateway: runs a bot's chosen provider and turns its events into transcript entries.
import { randomUUID } from "node:crypto";
import { Waiters } from "./approvals.ts";
import type { BotRegistry } from "./bots.ts";
import type { ComputerManager } from "./computer.ts";
import type { ProviderRegistry } from "./providers/index.ts";
import type { TranscriptStore } from "./transcript.ts";
import type {
  AgentProvider,
  ApprovalDecision,
  Bot,
  BotActivity,
  EntryBody,
  ProviderEvent,
  RunOutcome,
  TranscriptEntry,
} from "./types.ts";

/** What the model is told when the user denies a tool call without giving a reason. */
export const DENIED_WITHOUT_REASON = "The user denied this action.";

/** Longest answer the user may type into a choice card. */
export const MAX_CUSTOM_ANSWER = 500;

export class BotNotFoundError extends Error {}
export class BotBusyError extends Error {}
/** A change the bot can't take, like deleting the main bot. */
export class BotRuleError extends Error {}

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
  private readonly active = new Map<string, ActiveRun>();
  private readonly activityListeners = new Set<(bots: BotActivity[]) => void>();

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
            : (b.kind === "approval" || b.kind === "choice") && b.state === "pending"
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
    return this.bots.list().map((bot) => ({ botId: bot.id, running: this.active.has(bot.id) }));
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

  /** Records the user's message and starts a run. Resolves once the run has started, not finished. */
  async sendMessage(
    botId: string,
    text: string,
    clientNonce?: string,
  ): Promise<{ entry: TranscriptEntry; done: Promise<void> }> {
    const bot = this.bots.get(botId);
    if (!bot) throw new BotNotFoundError(`Unknown bot ${botId}`);
    if (this.active.has(botId)) throw new BotBusyError(`${bot.name} is still working on the last message.`);
    const provider = this.providers.get(bot.provider);
    if (!provider) throw new Error(`No provider registered for ${bot.provider}`);

    const controller = new AbortController();
    // Claim the bot before any await, so a second message can't start a parallel run.
    const run: ActiveRun = { controller, done: Promise.resolve() };
    this.active.set(botId, run);

    let entry: TranscriptEntry;
    try {
      entry = this.store.append(botId, { kind: "user_message", text, ...(clientNonce ? { clientNonce } : {}) });
    } catch (err) {
      // Release the claim, or the bot would look busy until the gateway restarts.
      this.active.delete(botId);
      throw err;
    }
    this.activityChanged();
    run.done = this.execute(bot, provider, text, controller).finally(() => {
      this.active.delete(botId);
      this.activityChanged();
    });
    return { entry, done: run.done };
  }

  /**
   * Changes a bot's settings. Switching provider is refused during a run; when it happens, the old session and
   * model are dropped (by the registry) and a notice says so in the transcript.
   */
  updateBot(
    botId: string,
    patch: Partial<Pick<Bot, "name" | "provider" | "model" | "baseUrl" | "pinned" | "hidden">>,
  ): Bot {
    const bot = this.bots.get(botId);
    if (!bot) throw new BotNotFoundError(`Unknown bot ${botId}`);
    if (patch.hidden && botId === this.bots.mainId()) throw new BotRuleError("The main bot is always shown.");
    const switching = patch.provider !== undefined && patch.provider !== bot.provider;
    if (switching && this.active.has(botId)) throw new BotBusyError("Can't change provider during a run.");
    if (patch.provider && !this.providers.has(patch.provider)) throw new Error(`Unknown provider ${patch.provider}`);
    const next = this.bots.update(botId, patch);
    if (switching) {
      const label = this.providers.get(next.provider)?.info?.().label ?? next.provider;
      const model = next.model ? ` (${next.model})` : "";
      this.store.append(botId, {
        kind: "notice",
        text: `Switched to ${label}${model}. The conversation starts fresh for the new model.`,
      });
    }
    return next;
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
    this.bots.remove(botId);
    this.store.forget(botId);
    this.activityChanged();
    await this.computers.remove(botId);
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

  private async execute(bot: Bot, provider: AgentProvider, text: string, controller: AbortController): Promise<void> {
    const runId = randomUUID();
    // Everything written during this run carries its id, the run entry included.
    const append = (body: EntryBody, id?: string) => this.store.append(bot.id, body, id, runId);
    const runEntry = append({ kind: "run", provider: provider.id, state: "running" }, runId);
    const textEntries = new Map<string, string>(); // provider blockId -> entry id
    const toolEntries = new Map<string, string>(); // toolUseId -> entry id

    const set = (id: string, change: (b: EntryBody) => EntryBody) => this.store.update(bot.id, id, change);

    const onEvent = (ev: ProviderEvent) => {
      switch (ev.type) {
        case "session":
          if (bot.sessionId !== ev.sessionId) {
            this.bots.update(bot.id, { sessionId: ev.sessionId, sessionProvider: provider.id });
          }
          return;
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
      const resumable = bot.sessionProvider === provider.id ? bot.sessionId : undefined;
      outcome = await provider.run(
        {
          botId: bot.id,
          botName: bot.name,
          prompt: text,
          sessionId: resumable,
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
    }
    set(runEntry.id, (b) =>
      b.kind === "run"
        ? { ...b, state: outcome.status, ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}) }
        : b,
    );
  }
}

function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  return AbortSignal.any([a, b]);
}
