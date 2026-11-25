// Model adapter contract for the built-in agent loop: neutral chat messages in, streamed text and tool calls out.
// Each model API (OpenAI-compatible, Gemini, …) implements ModelAdapter and converts these shapes to its own.

/** A JSON Schema object describing a tool's input. */
export type JsonSchema = Record<string, unknown>;

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type ChatMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; output: string; isError: boolean };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ModelRequest {
  model?: string;
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
  | { type: "done"; usage?: ModelUsage };

export interface ModelAdapter {
  /**
   * Streams one model turn. Must stop promptly (and may throw) when `signal` aborts.
   * Throws on API errors; the loop turns the error message into a failed run.
   */
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  /** The models the API offers, when it can list them. */
  listModels?(signal: AbortSignal): Promise<string[]>;
}
