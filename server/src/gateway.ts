// The gateway: runs a bot's chosen provider and turns its events into transcript entries.
import { ApprovalBroker } from "./approvals.ts";
import type { BotRegistry } from "./bots.ts";
import type { ComputerManager } from "./computer.ts";
import type { ProviderRegistry } from "./providers/index.ts";
import type { TranscriptStore } from "./transcript.ts";
import type { ApprovalDecision, Bot, EntryBody, ProviderEvent, RunOutcome, TranscriptEntry } from "./types.ts";

export class BotNotFoundError extends Error {}
export class BotBusyError extends Error {}

interface ActiveRun {
  controller: AbortController;
  done: Promise<void>;
}

export function botInstructions(bot: Bot): string {
  return [
    `You are ${bot.name}, a personal assistant bot in the GrokBot Clone app.`,
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
  private readonly approvals = new ApprovalBroker();
  private readonly active = new Map<string, ActiveRun>();

  constructor(bots: BotRegistry, store: TranscriptStore, providers: ProviderRegistry, computers: ComputerManager) {
    this.bots = bots;
    this.store = store;
    this.providers = providers;
    this.computers = computers;
  }

  isRunning(botId: string): boolean {
    return this.active.has(botId);
  }

  /** Records the user's message and starts a run. Resolves once the run has started, not finished. */
  async sendMessage(botId: string, text: string): Promise<{ entry: TranscriptEntry; done: Promise<void> }> {
    const bot = this.bots.get(botId);
    if (!bot) throw new BotNotFoundError(`Unknown bot ${botId}`);
    if (this.active.has(botId)) throw new BotBusyError(`${bot.name} is still working on the last message.`);
    const provider = this.providers.get(bot.provider);
    if (!provider) throw new Error(`No provider registered for ${bot.provider}`);

    const controller = new AbortController();
    // Claim the bot before any await, so a second message can't start a parallel run.
    const run: ActiveRun = { controller, done: Promise.resolve() };
    this.active.set(botId, run);

    const entry = this.store.append(botId, { kind: "user_message", text });
    run.done = this.execute(bot, text, controller).finally(() => this.active.delete(botId));
    return { entry, done: run.done };
  }

  /** Stops the bot's current run. Returns false when nothing is running. */
  interrupt(botId: string): boolean {
    const run = this.active.get(botId);
    if (!run) return false;
    run.controller.abort();
    return true;
  }

  /** Answers an approval card. Returns false if the card isn't pending. */
  answerApproval(botId: string, entryId: string, decision: ApprovalDecision): boolean {
    const entry = this.store.get(botId, entryId);
    if (!entry || entry.body.kind !== "approval" || entry.body.state !== "pending") return false;
    return this.approvals.answer(entryId, decision);
  }

  private async execute(bot: Bot, text: string, controller: AbortController): Promise<void> {
    const provider = this.providers.get(bot.provider)!;
    const runEntry = this.store.append(bot.id, { kind: "run", provider: provider.id, state: "running" });
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
            const e = this.store.append(bot.id, { kind: "assistant_text", text: ev.text, streaming: true });
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
            const e = this.store.append(bot.id, { kind: "assistant_text", text: ev.text, streaming: false });
            textEntries.set(ev.blockId, e.id);
          } else {
            set(id, () => ({ kind: "assistant_text", text: ev.text, streaming: false }));
          }
          return;
        }
        case "tool_start": {
          const e = this.store.append(bot.id, { kind: "status", label: ev.summary, tool: ev.tool, state: "running" });
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
            const card = this.store.append(bot.id, { kind: "approval", ...req, state: "pending" });
            const decision = await this.approvals.wait(card.id, anySignal(signal, controller.signal));
            set(card.id, (b) =>
              b.kind === "approval"
                ? {
                    ...b,
                    state: decision.allow ? "approved" : controller.signal.aborted ? "expired" : "denied",
                    ...(decision.allow ? {} : { reason: decision.reason }),
                  }
                : b,
            );
            return decision;
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
      this.store.append(bot.id, { kind: "error", message: outcome.error ?? "Something went wrong." });
    }
    set(runEntry.id, (b) =>
      b.kind === "run" ? { ...b, state: outcome.status, ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}) } : b,
    );
  }
}

function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  return AbortSignal.any([a, b]);
}
