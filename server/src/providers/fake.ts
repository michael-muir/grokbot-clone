// Scripted provider for UI development and tests. Makes no network calls.
//
// Prompt commands:
//   "/tool"   -> one tool call that needs approval (Bash "echo hello")
//   "/slow"   -> streams slowly, so interrupt can be tested
//   "/fail"   -> the run fails
//   "/choice" -> asks the user to pick a color (Red or Blue, or their own)
// Anything else gets an echo reply, streamed word by word.
import type { AgentProvider, ProviderInfo, RunCallbacks, RunOutcome, RunRequest } from "../types.ts";

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });

export class FakeProvider implements AgentProvider {
  readonly id = "fake" as const;
  private readonly delayMs: number;
  private turn = 0;

  constructor(delayMs = 5) {
    this.delayMs = delayMs;
  }

  info(): ProviderInfo {
    return { label: "Fake (testing)", local: true, configured: true };
  }

  async run(req: RunRequest, cb: RunCallbacks): Promise<RunOutcome> {
    const sessionId = req.sessionId ?? `fake-session-${req.botId}`;
    cb.emit({ type: "session", sessionId });
    const turn = ++this.turn;
    const prompt = req.prompt.trim();
    try {
      if (prompt === "/fail") return { status: "failed", sessionId, error: "Scripted failure." };

      if (prompt === "/choice") {
        const toolUseId = `tool-${turn}`;
        cb.emit({ type: "tool_start", toolUseId, tool: "ask_user", summary: "Asking: Pick a color" });
        const answer = await cb.requestChoice?.(
          {
            prompt: "Pick a color",
            options: [
              { label: "Red", value: "red" },
              { label: "Blue", value: "blue" },
            ],
            allowCustom: true,
          },
          req.signal,
        );
        cb.emit({ type: "tool_end", toolUseId, ok: answer !== undefined });
        if (req.signal.aborted || answer === undefined) return { status: "interrupted", sessionId };
        cb.emit({ type: "text", blockId: `msg-${turn}:0`, text: `You picked ${answer}.` });
        return { status: "finished", sessionId, costUsd: 0 };
      }

      if (prompt === "/tool") {
        const toolUseId = `tool-${turn}`;
        const input = { command: "echo hello" };
        cb.emit({ type: "tool_start", toolUseId, tool: "Bash", summary: "Running echo hello" });
        const decision = await cb.requestApproval({ tool: "Bash", summary: "Running echo hello", input }, req.signal);
        cb.emit({ type: "tool_end", toolUseId, ok: decision.allow });
        if (req.signal.aborted) return { status: "interrupted", sessionId };
        const reply = decision.allow
          ? "Done. The command printed hello."
          : `Okay, I won't run it (${decision.reason}).`;
        cb.emit({ type: "text", blockId: `msg-${turn}:0`, text: reply });
        return { status: "finished", sessionId, costUsd: 0 };
      }

      const reply = `${req.botName} here. You said: ${prompt}`;
      const blockId = `msg-${turn}:0`;
      const delay = prompt === "/slow" ? 200 : this.delayMs;
      const words = reply.split(" ");
      for (let i = 0; i < words.length; i++) {
        await sleep(delay, req.signal);
        cb.emit({ type: "text_delta", blockId, text: (i ? " " : "") + words[i] });
      }
      cb.emit({ type: "text", blockId, text: reply });
      return { status: "finished", sessionId, costUsd: 0 };
    } catch (err) {
      if (req.signal.aborted) return { status: "interrupted", sessionId };
      throw err;
    }
  }
}
