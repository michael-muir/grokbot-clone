// Provider registry: every backend a bot can run on, keyed by ProviderId.
import { SessionStore } from "../agent/sessions.ts";
import type { Credentials } from "../keys.ts";
import type { AgentProvider, ProviderId, ProviderInfo, RunOutcome } from "../types.ts";
import { ClaudeProvider } from "./claude.ts";
import { CodexProvider } from "./codex.ts";
import { FakeProvider } from "./fake.ts";
import { geminiProvider } from "./gemini.ts";
import { OPENAI_PRESETS, openAICompatibleProvider } from "./openai-compatible.ts";

/** Placeholder until the Cursor adapter is written. */
class NotYetAvailable implements AgentProvider {
  readonly id: ProviderId;
  private readonly label: string;
  private readonly hint: string;

  constructor(id: ProviderId, label: string, hint: string) {
    this.id = id;
    this.label = label;
    this.hint = hint;
  }

  info(): ProviderInfo {
    return { label: this.label, local: false, configured: false };
  }

  async run(): Promise<RunOutcome> {
    return { status: "failed", error: `The ${this.id} provider isn't available yet. ${this.hint}` };
  }
}

export type ProviderRegistry = Map<ProviderId, AgentProvider>;

export function defaultProviders(dataDir: string, credentials: Credentials): ProviderRegistry {
  const sessions = new SessionStore(dataDir);
  const providers: AgentProvider[] = [
    new ClaudeProvider(undefined, () => credentials.key("claude")),
    ...OPENAI_PRESETS.map((preset) => openAICompatibleProvider(preset, sessions, process.env, credentials)),
    geminiProvider(sessions, process.env, credentials),
    new CodexProvider(),
    new NotYetAvailable("cursor", "Cursor", "Planned: Cursor CLI in print mode with JSON streaming."),
    new FakeProvider(40),
  ];
  return new Map(providers.map((p) => [p.id, p]));
}
