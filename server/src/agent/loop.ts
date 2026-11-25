// LoopProvider: our own agent loop, so any chat model with function calling can act as an agent.
// The model streams text and asks for tools; the loop runs the tools (asking the user for anything that isn't
// read-only), feeds the results back, and repeats until the model answers without tools.
import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import type { AgentProvider, ProviderId, ProviderInfo, RunCallbacks, RunOutcome, RunRequest } from "../types.ts";
import type { ChatMessage, ModelAdapter, ToolCall } from "./model.ts";
import type { SessionStore } from "./sessions.ts";
import { defaultTools, type Tool, ToolInputError } from "./tools.ts";

export const DEFAULT_MAX_STEPS = 25;
const STOPPED_BEFORE_RUNNING = "The run was stopped before this tool ran.";

export interface LoopProviderOptions {
  id: ProviderId;
  info?: ProviderInfo;
  adapter: ModelAdapter;
  sessions: SessionStore;
  tools?: Tool[];
  maxSteps?: number;
}

export class LoopProvider implements AgentProvider {
  readonly id: ProviderId;
  private readonly adapter: ModelAdapter;
  private readonly sessions: SessionStore;
  private readonly tools: Map<string, Tool>;
  private readonly maxSteps: number;
  private readonly providerInfo?: ProviderInfo;
  private turn = 0;

  constructor(opts: LoopProviderOptions) {
    this.id = opts.id;
    this.adapter = opts.adapter;
    this.sessions = opts.sessions;
    this.tools = new Map((opts.tools ?? defaultTools()).map((t) => [t.spec.name, t]));
    this.maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
    this.providerInfo = opts.info;
    const adapter = opts.adapter;
    if (adapter.listModels) this.listModels = (signal) => adapter.listModels?.(signal) ?? Promise.resolve([]);
  }

  listModels?: (signal: AbortSignal) => Promise<string[]>;

  info(): ProviderInfo {
    return this.providerInfo ?? { label: this.id, local: false, configured: true };
  }

  async run(req: RunRequest, cb: RunCallbacks): Promise<RunOutcome> {
    let sessionId: string;
    let messages: ChatMessage[];
    try {
      sessionId = req.sessionId ?? this.sessions.newId();
      messages = this.sessions.load(sessionId);
    } catch (err) {
      return { status: "failed", error: `Couldn't load the conversation: ${message(err)}` };
    }
    cb.emit({ type: "session", sessionId });

    const turn = ++this.turn;
    messages.push({ role: "user", text: req.prompt });
    // Tool call ids must be unique across the whole session, not just one step: APIs match results by id.
    const usedIds = new Set(messages.flatMap((m) => (m.role === "assistant" ? m.toolCalls.map((c) => c.id) : [])));
    const save = () => this.sessions.save(sessionId, closeUnansweredCalls(messages));
    const system = systemPrompt(req.instructions, [...this.tools.values()]);
    const specs = [...this.tools.values()].map((t) => t.spec);
    // The model turn in progress, kept so an interrupt mid-stream still saves what the model said.
    let partial: { blockId: string; text: string; calls: ToolCall[] } | undefined;
    /** Ends the turn in progress: closes its streamed text and keeps it in the history. */
    const keepPartial = () => {
      if (partial?.text) cb.emit({ type: "text", blockId: partial.blockId, text: partial.text });
      if (partial && (partial.text || partial.calls.length)) {
        messages.push({ role: "assistant", text: partial.text, toolCalls: partial.calls });
      }
      partial = undefined;
    };

    try {
      for (let step = 0; step < this.maxSteps; step++) {
        if (req.signal.aborted) return interrupted(save, sessionId);

        // One model turn: stream text, collect tool calls.
        const blockId = `${turn}:${step}`;
        partial = { blockId, text: "", calls: [] };
        const current = partial;
        for await (const ev of this.adapter.stream({ model: req.model, system, messages, tools: specs }, req.signal)) {
          if (req.signal.aborted) break;
          if (ev.type === "text_delta" && ev.text) {
            current.text += ev.text;
            cb.emit({ type: "text_delta", blockId, text: ev.text });
          } else if (ev.type === "tool_call") {
            // Some models (often local ones) send blank or repeated call ids; the history needs unique ones.
            let id = ev.call.id;
            if (!id || usedIds.has(id)) id = `call-${randomUUID()}`;
            usedIds.add(id);
            current.calls.push({ ...ev.call, id });
          }
        }
        keepPartial();
        if (req.signal.aborted) return interrupted(save, sessionId);
        const calls = current.calls;
        if (!calls.length) {
          save();
          return { status: "finished", sessionId };
        }

        // Run each tool call in order and give the results back to the model.
        for (const call of calls) {
          if (req.signal.aborted) return interrupted(save, sessionId);
          messages.push(await this.runTool(call, req, cb));
        }
        save();
      }
      save();
      return { status: "failed", sessionId, error: `Stopped after ${this.maxSteps} steps without finishing.` };
    } catch (err) {
      keepPartial();
      if (req.signal.aborted) return interrupted(save, sessionId);
      try {
        save();
      } catch (saveErr) {
        console.error("failed to save the conversation after an error", saveErr);
      }
      return { status: "failed", sessionId, error: message(err) };
    }
  }

  private async runTool(call: ToolCall, req: RunRequest, cb: RunCallbacks): Promise<ChatMessage> {
    const tool = this.tools.get(call.name);
    const result = (output: string, isError: boolean): ChatMessage => ({
      role: "tool",
      toolCallId: call.id,
      name: call.name,
      output,
      isError,
    });
    const summary = tool ? safeSummary(tool, call.input) : `Using ${call.name}`;
    cb.emit({ type: "tool_start", toolUseId: call.id, tool: call.name, summary });

    if (!tool) {
      cb.emit({ type: "tool_end", toolUseId: call.id, ok: false });
      return result(
        `There is no tool named ${call.name}. Available tools: ${[...this.tools.keys()].join(", ")}.`,
        true,
      );
    }

    if (!tool.readOnly) {
      const decision = await cb.requestApproval({ tool: call.name, summary, input: call.input }, req.signal);
      if (req.signal.aborted) {
        cb.emit({ type: "tool_end", toolUseId: call.id, ok: false });
        return result(STOPPED_BEFORE_RUNNING, true);
      }
      if (!decision.allow) {
        cb.emit({ type: "tool_end", toolUseId: call.id, ok: false });
        return result(`The user denied this: ${decision.reason}`, true);
      }
    }

    try {
      const r = await tool.run(call.input, { workspaceDir: req.workspaceDir, signal: req.signal });
      cb.emit({ type: "tool_end", toolUseId: call.id, ok: r.ok });
      return result(r.output, !r.ok);
    } catch (err) {
      cb.emit({ type: "tool_end", toolUseId: call.id, ok: false });
      const prefix = err instanceof ToolInputError ? "Invalid input" : "Error";
      return result(`${prefix}: ${message(err)}`, true);
    }
  }
}

function systemPrompt(instructions: string, tools: Tool[]): string {
  const os = { win32: "Windows", darwin: "macOS", linux: "Linux" }[platform() as string] ?? platform();
  return [
    instructions,
    "",
    "You can use tools to work in your workspace. File paths are relative to it.",
    `The computer runs ${os}.`,
    ...tools.flatMap((t) => (t.promptNote ? [t.promptNote] : [])),
    "Some tools need the user's approval. If the user denies one, don't retry it; explain or pick another way.",
    "When the task is done, reply with a short summary and no tool calls.",
  ].join("\n");
}

/** Gives every tool call without a result a "stopped" result, so the history stays valid for every model API. */
export function closeUnansweredCalls(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    out.push(m);
    if (m.role !== "assistant" || !m.toolCalls.length) continue;
    // A call counts as answered only by the results right after its own message; add the missing ones after them.
    const answered = new Set<string>();
    while (messages[i + 1]?.role === "tool") {
      const next = messages[++i];
      if (next?.role !== "tool") break;
      answered.add(next.toolCallId);
      out.push(next);
    }
    for (const call of m.toolCalls) {
      if (!answered.has(call.id)) {
        out.push({ role: "tool", toolCallId: call.id, name: call.name, output: STOPPED_BEFORE_RUNNING, isError: true });
      }
    }
  }
  return out;
}

function interrupted(save: () => void, sessionId: string): RunOutcome {
  try {
    save();
  } catch (err) {
    console.error("failed to save the conversation after an interrupt", err);
  }
  return { status: "interrupted", sessionId };
}

function safeSummary(tool: Tool, input: Record<string, unknown>): string {
  try {
    return tool.summarize(input);
  } catch (err) {
    console.warn(`${tool.spec.name}: couldn't summarize the call`, err);
    return `Using ${tool.spec.name}`;
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
