// Scripted provider for UI development and tests. Makes no network calls.
//
// Prompt commands:
//   "/tool"   -> one tool call that needs approval (Bash "echo hello")
//   "/slow"   -> streams slowly, so interrupt can be tested
//   "/fail"   -> the run fails
//   "/choice" -> asks the user to pick a color (Red or Blue, or their own)
//   "/history" -> lists the session's earlier prompts, so tests can see what a session remembers
//   "/widget" -> a widget card (Small, Medium, Large); "/form" -> a form card (name, subscribe). Text without cards.
//   "/secret" -> asks for DEMO_TOKEN on a secret card; "/secret-echo" -> prints it with an approved command, redacted
// Anything else gets an echo reply, streamed word by word.
//
// Sessions live in memory: each remembers its prompts, a checkpoint is how many, and resumeAt copies that many into
// a new session.
import { defaultShell, runShell } from "../agent/shell.ts";
import { redact } from "../secrets.ts";
import type { AgentProvider, CardRequest, ProviderInfo, RunCallbacks, RunOutcome, RunRequest } from "../types.ts";

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
  private forks = 0;
  private readonly sessions = new Map<string, string[]>();

  constructor(delayMs = 5) {
    this.delayMs = delayMs;
  }

  /** A session nobody has used: `fake-session-<bot>`, then numbered (after a fresh start, say). */
  private newSession(botId: string): string {
    let id = `fake-session-${botId}`;
    for (let n = 2; this.sessions.has(id); n++) id = `fake-session-${botId}-${n}`;
    return id;
  }

  info(): ProviderInfo {
    return { label: "Fake (testing)", local: true, configured: true };
  }

  async run(req: RunRequest, cb: RunCallbacks): Promise<RunOutcome> {
    let sessionId = req.sessionId ?? this.newSession(req.botId);
    if (req.sessionId && req.resumeAt !== undefined) {
      // Like the loop: a checkpoint this session never reached fails before any session starts.
      const from = this.sessions.get(req.sessionId) ?? [];
      const at = Number(req.resumeAt);
      if (!Number.isInteger(at) || at < 0 || at > from.length) {
        return { status: "failed", error: "Couldn't go back to that point in the conversation." };
      }
      const kept = from.slice(0, at);
      sessionId = `${req.sessionId.replace(/~fork-\d+$/, "")}~fork-${++this.forks}`;
      this.sessions.set(sessionId, kept);
    }
    cb.emit({ type: "session", sessionId });
    const history = this.sessions.get(sessionId) ?? [];
    this.sessions.set(sessionId, history);
    const earlier = [...history];
    history.push(req.prompt);
    cb.emit({ type: "checkpoint", at: String(history.length) });
    const turn = ++this.turn;
    const prompt = req.prompt.trim();
    try {
      if (prompt === "/history") {
        const reply = earlier.length ? `I remember: ${earlier.join(" | ")}` : "I don't remember anything yet.";
        cb.emit({ type: "text", blockId: `msg-${turn}:0`, text: reply });
        return { status: "finished", sessionId, costUsd: 0 };
      }

      if (prompt === "/fail") return { status: "failed", sessionId, error: "Scripted failure." };

      if (prompt === "/secret") {
        const blockId = `msg-${turn}:0`;
        if (!cb.requestCard || !req.cardKinds?.includes("secret")) {
          cb.emit({ type: "text", blockId, text: "I'd need a token, but this app can't ask for one safely." });
          return { status: "finished", sessionId, costUsd: 0 };
        }
        const toolUseId = `tool-${turn}`;
        cb.emit({ type: "tool_start", toolUseId, tool: "request_secret", summary: "Asking for Demo token" });
        const answer = await cb.requestCard(
          { kind: "secret", name: "DEMO_TOKEN", label: "Demo token", reason: "To try out secrets." },
          req.signal,
        );
        cb.emit({ type: "tool_end", toolUseId, ok: answer !== undefined });
        if (req.signal.aborted || answer === undefined) return { status: "interrupted", sessionId };
        const saved = answer.kind === "secret" && answer.saved;
        cb.emit({ type: "text", blockId, text: saved ? "Thanks, I saved DEMO_TOKEN." : "Okay, no token then." });
        return { status: "finished", sessionId, costUsd: 0 };
      }

      if (prompt === "/secret-echo") {
        // Prints the secret through the real path: an approved command with the secrets in its environment, and its
        // output redacted before it reaches the reply.
        const shell = defaultShell();
        const command = shell.name === "PowerShell" ? "Write-Output $env:DEMO_TOKEN" : 'echo "$DEMO_TOKEN"';
        const toolUseId = `tool-${turn}`;
        cb.emit({ type: "tool_start", toolUseId, tool: "shell", summary: `Running ${command}` });
        const decision = await cb.requestApproval(
          { tool: "shell", summary: `Running ${command}`, input: { command } },
          req.signal,
        );
        if (!decision.allow || req.signal.aborted) {
          cb.emit({ type: "tool_end", toolUseId, ok: false });
          return { status: req.signal.aborted ? "interrupted" : "finished", sessionId };
        }
        const secrets = req.secrets?.() ?? {};
        const r = await runShell(
          command,
          {
            cwd: req.workspaceDir,
            signal: req.signal,
            timeoutMs: 20_000,
            maxOutput: 2_000,
            env: secrets,
            redact: (text) => redact(text, secrets),
          },
          shell,
        );
        if (r.aborted || req.signal.aborted) {
          cb.emit({ type: "tool_end", toolUseId, ok: false });
          return { status: "interrupted", sessionId };
        }
        cb.emit({ type: "tool_end", toolUseId, ok: r.exitCode === 0 });
        cb.emit({
          type: "text",
          blockId: `msg-${turn}:0`,
          text: `The command printed: ${redact(r.output.trim(), secrets)}`,
        });
        return { status: "finished", sessionId, costUsd: 0 };
      }

      if (prompt === "/widget" || prompt === "/form") {
        const card: CardRequest =
          prompt === "/widget"
            ? {
                kind: "widget",
                prompt: "Which size?",
                options: ["Small", "Medium", "Large"].map((label) => ({ label, value: label })),
              }
            : {
                kind: "form",
                title: "Sign up",
                fields: [
                  { name: "name", label: "Name", type: "text", required: true },
                  { name: "subscribe", label: "Send me news", type: "checkbox" },
                ],
                submitLabel: "Sign up",
              };
        const blockId = `msg-${turn}:0`;
        // The fallback: an app that can't show this card gets the question in text.
        if (!cb.requestCard || !req.cardKinds?.includes(card.kind)) {
          const text = card.kind === "widget" ? "Which size: Small, Medium or Large?" : "What's your name?";
          cb.emit({ type: "text", blockId, text });
          return { status: "finished", sessionId, costUsd: 0 };
        }
        const toolUseId = `tool-${turn}`;
        cb.emit({ type: "tool_start", toolUseId, tool: "show_card", summary: "Asking: a card" });
        const answer = await cb.requestCard(card, req.signal);
        cb.emit({ type: "tool_end", toolUseId, ok: answer !== undefined });
        if (req.signal.aborted || answer === undefined) return { status: "interrupted", sessionId };
        cb.emit({
          type: "text",
          blockId,
          text: `Got it: ${JSON.stringify(answer.kind === "widget" ? answer.value : answer.kind === "form" ? answer.values : answer.saved)}`,
        });
        return { status: "finished", sessionId, costUsd: 0 };
      }

      if (prompt === "/choice") {
        const toolUseId = `tool-${turn}`;
        cb.emit({ type: "tool_start", toolUseId, tool: "ask_user", summary: "Asking: Pick a color" });
        if (!cb.requestChoice) {
          return { status: "failed", sessionId, error: "This client can't show questions with choices." };
        }
        const answer = await cb.requestChoice(
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
