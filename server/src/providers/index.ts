import type { AgentProvider, ProviderId, RunOutcome } from "../types.ts";
import { ClaudeProvider } from "./claude.ts";
import { FakeProvider } from "./fake.ts";

/** Placeholder until the Codex and Cursor adapters are written. */
class NotYetAvailable implements AgentProvider {
  readonly id: ProviderId;
  private readonly hint: string;

  constructor(id: ProviderId, hint: string) {
    this.id = id;
    this.hint = hint;
  }

  async run(): Promise<RunOutcome> {
    return { status: "failed", error: `The ${this.id} provider isn't available yet. ${this.hint}` };
  }
}

export type ProviderRegistry = Map<ProviderId, AgentProvider>;

export function defaultProviders(): ProviderRegistry {
  return new Map<ProviderId, AgentProvider>([
    ["claude", new ClaudeProvider()],
    ["codex", new NotYetAvailable("codex", "Planned: Codex SDK or `codex app-server`.")],
    ["cursor", new NotYetAvailable("cursor", "Planned: Cursor CLI in print mode with JSON streaming.")],
    ["fake", new FakeProvider(40)],
  ]);
}
