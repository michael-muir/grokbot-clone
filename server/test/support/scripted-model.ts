// A scripted ModelAdapter for tests: each call to stream() plays the next scripted turn and records the request.
import type { ModelAdapter, ModelEvent, ModelRequest, ToolCall } from "../../src/agent/model.ts";

export type Turn = (req: ModelRequest, signal: AbortSignal) => AsyncIterable<ModelEvent>;

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });

/** A turn that streams `text` word by word, then finishes. */
export const says = (text: string, delayMs = 0): Turn =>
  async function* (_req, signal) {
    for (const [i, word] of text.split(" ").entries()) {
      if (delayMs) await sleep(delayMs, signal);
      yield { type: "text_delta", text: (i ? " " : "") + word };
    }
    yield { type: "done" };
  };

/** A turn that asks for tool calls, optionally with some text first. */
export const calls = (toolCalls: ToolCall[], text = ""): Turn =>
  async function* () {
    if (text) yield { type: "text_delta", text };
    for (const call of toolCalls) yield { type: "tool_call", call };
    yield { type: "done" };
  };

/** A turn that fails like an API error. */
export const fails = (message: string): Turn =>
  // biome-ignore lint/correctness/useYield: a turn that throws before producing anything
  async function* () {
    throw new Error(message);
  };

export class ScriptedModel implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  private readonly turns: Turn[];
  private readonly fallback?: Turn;

  /** Plays `turns` in order; after they run out, plays `fallback` (or fails). */
  constructor(turns: Turn[], fallback?: Turn) {
    this.turns = [...turns];
    this.fallback = fallback;
  }

  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    // Copy, because the loop keeps appending to the same array.
    this.requests.push({ ...req, messages: structuredClone(req.messages) });
    const turn = this.turns.shift() ?? this.fallback ?? fails("The script ran out of turns.");
    return turn(req, signal);
  }
}
