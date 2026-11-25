// Shared types for the agent gateway.
//
// The UI only ever sees TranscriptEntry objects, modeled on Grok Bot's
// GrokBotTranscriptEntry (seq + updated_seq, appended or updated in place).
// Providers only ever emit ProviderEvent objects. The gateway translates
// between the two, so the UI never knows which backend a bot runs on.

/** Every provider the gateway knows. One list for the type and for validating input. */
export const PROVIDER_IDS = [
  "claude",
  "codex",
  "cursor",
  "openai",
  "xai",
  "openrouter",
  "ollama",
  "lmstudio",
  "gemini",
  "fake",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export const isProviderId = (v: unknown): v is ProviderId => PROVIDER_IDS.includes(v as ProviderId);

export type EntryBody =
  | { kind: "user_message"; text: string }
  | { kind: "assistant_text"; text: string; streaming: boolean }
  | { kind: "status"; label: string; tool: string; state: "running" | "done" | "failed" }
  | {
      kind: "approval";
      tool: string;
      summary: string;
      input: Record<string, unknown>;
      state: "pending" | "approved" | "denied" | "expired";
      reason?: string;
    }
  | { kind: "error"; message: string }
  | {
      kind: "run";
      provider: ProviderId;
      state: "running" | "finished" | "interrupted" | "failed";
      costUsd?: number;
    };

export type EntryKind = EntryBody["kind"];

export interface TranscriptEntry {
  /** Position of the entry in the conversation. Never changes. */
  seq: number;
  /** Bumped every time the entry changes. Clients resume with `since=<last updatedSeq>`. */
  updatedSeq: number;
  id: string;
  botId: string;
  body: EntryBody;
  createdAt: number;
  updatedAt: number;
}

export interface Bot {
  id: string;
  name: string;
  provider: ProviderId;
  model?: string;
  avatar: { shape: string; color: string };
  /** Provider session to resume, so each bot keeps one long-running conversation. */
  sessionId?: string;
  /** Provider the stored session belongs to. A session is dropped when the provider changes. */
  sessionProvider?: ProviderId;
}

// ---------- provider contract ----------

export interface RunRequest {
  botId: string;
  botName: string;
  prompt: string;
  sessionId?: string;
  model?: string;
  /** The bot's computer: the directory the agent works in. */
  workspaceDir: string;
  /** Persona and product instructions appended to the provider's own system prompt. */
  instructions: string;
  signal: AbortSignal;
}

export type ProviderEvent =
  | { type: "session"; sessionId: string }
  /** A piece of streamed text for one text block. */
  | { type: "text_delta"; blockId: string; text: string }
  /** The complete text of one block (replaces anything streamed so far). */
  | { type: "text"; blockId: string; text: string }
  | { type: "tool_start"; toolUseId: string; tool: string; summary: string }
  | { type: "tool_end"; toolUseId: string; ok: boolean };

export interface ApprovalRequest {
  tool: string;
  summary: string;
  input: Record<string, unknown>;
}

export type ApprovalDecision = { allow: true } | { allow: false; reason: string };

export interface RunCallbacks {
  emit(event: ProviderEvent): void;
  /** Ask the user to approve a tool call. Resolves when they answer, or denies if the run is aborted. */
  requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
}

export interface RunOutcome {
  status: "finished" | "interrupted" | "failed";
  sessionId?: string;
  costUsd?: number;
  error?: string;
}

export interface ProviderInfo {
  label: string;
  /** Runs on this machine (no account or key needed). */
  local: boolean;
  /** Has what it needs to run: a key, or nothing needed. */
  configured: boolean;
}

export interface AgentProvider {
  readonly id: ProviderId;
  run(request: RunRequest, callbacks: RunCallbacks): Promise<RunOutcome>;
  /** For the provider list in Settings. */
  info?(): ProviderInfo;
  /** The models this provider can run, when it can list them. */
  listModels?(signal: AbortSignal): Promise<string[]>;
}
