// Model adapter contract for the built-in agent loop: neutral chat messages in, streamed text and tool calls out.
// Each model API (OpenAI-compatible, Gemini, …) implements ModelAdapter and converts these shapes to its own.

/** A JSON Schema object describing a tool's input. */
export type JsonSchema = Record<string, unknown>;

/**
 * Set on a tool call's input by an adapter when the model's arguments couldn't be parsed. The loop reports it to
 * the model as invalid input instead of running the tool.
 */
export const INVALID_ARGUMENTS = "_invalid_arguments";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Adapter-specific data that must travel with the call in the history (e.g. Gemini's thought signature). */
  meta?: Record<string, unknown>;
}

export type ChatMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[]; meta?: Record<string, unknown> }
  | { role: "tool"; toolCallId: string; name: string; output: string; isError: boolean };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ModelRequest {
  model?: string;
  /** Overrides the adapter's base URL for this request (a bot's own server). */
  baseUrl?: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; call: ToolCall }
  /** Adapter-specific data about the whole turn, kept on the assistant message in the history. */
  | { type: "turn_meta"; meta: Record<string, unknown> }
  | { type: "done"; usage?: ModelUsage };

export interface ModelAdapter {
  /**
   * Streams one model turn. Must stop promptly (and may throw) when `signal` aborts.
   * Throws on API errors; the loop turns the error message into a failed run.
   */
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  /** The models the API offers, when it can list them. */
  listModels?(signal: AbortSignal, baseUrl?: string): Promise<string[]>;
}

/** An API key given directly, or read each time it's needed (so a key saved in Settings works at once). */
export type KeySource = string | (() => string | undefined) | undefined;
export const readKey = (k: KeySource): string | undefined => (typeof k === "function" ? k() : k) || undefined;
