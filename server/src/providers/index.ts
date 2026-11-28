// Provider registry: every backend a bot can run on, keyed by ProviderId.
import { join } from "node:path";
import { SessionStore } from "../agent/sessions.ts";
import type { Credentials } from "../keys.ts";
import type { AgentProvider, ProviderId } from "../types.ts";
import { ClaudeProvider } from "./claude.ts";
import { CodexProvider } from "./codex.ts";
import { CursorProvider } from "./cursor.ts";
import { FakeProvider } from "./fake.ts";
import { geminiProvider } from "./gemini.ts";
import { OPENAI_PRESETS, openAICompatibleProvider } from "./openai-compatible.ts";

export type ProviderRegistry = Map<ProviderId, AgentProvider>;

export function defaultProviders(dataDir: string, credentials: Credentials): ProviderRegistry {
  const sessions = new SessionStore(dataDir);
  const providers: AgentProvider[] = [
    new ClaudeProvider(undefined, () => credentials.key("claude")),
    ...OPENAI_PRESETS.map((preset) => openAICompatibleProvider(preset, sessions, process.env, credentials)),
    geminiProvider(sessions, process.env, credentials),
    new CodexProvider(),
    new CursorProvider({ homeDir: join(dataDir, "cursor-home") }),
    new FakeProvider(40),
  ];
  return new Map(providers.map((p) => [p.id, p]));
}
