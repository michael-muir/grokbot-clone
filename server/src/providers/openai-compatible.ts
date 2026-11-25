// Presets for OpenAI-compatible model servers, each a provider on the built-in agent loop.
// Keys and base URLs come from environment variables for now (#5 moves keys to the OS keychain).
import { LoopProvider } from "../agent/loop.ts";
import { OpenAICompatibleAdapter } from "../agent/openai-compatible.ts";
import type { SessionStore } from "../agent/sessions.ts";
import { Credentials, MemoryKeyStore } from "../keys.ts";
import type { ProviderId } from "../types.ts";

export interface OpenAIPreset {
  id: Extract<ProviderId, "openai" | "xai" | "openrouter" | "ollama" | "lmstudio">;
  label: string;
  baseUrl: string;
  /** Environment variable prefix: <PREFIX>_API_KEY, <PREFIX>_BASE_URL, <PREFIX>_MODEL. */
  env: string;
  local: boolean;
}

export const OPENAI_PRESETS: OpenAIPreset[] = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", env: "OPENAI", local: false },
  { id: "xai", label: "xAI Grok", baseUrl: "https://api.x.ai/v1", env: "XAI", local: false },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", env: "OPENROUTER", local: false },
  { id: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1", env: "OLLAMA", local: true },
  { id: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1", env: "LMSTUDIO", local: true },
];

/**
 * A preset as a provider. Its key is read from `credentials` on every request (keychain, then env), so a key
 * saved in Settings is used by the next message. Base URL and default model come from env.
 */
export function openAICompatibleProvider(
  preset: OpenAIPreset,
  sessions: SessionStore,
  env: NodeJS.ProcessEnv = process.env,
  credentials: Credentials = new Credentials(new MemoryKeyStore(), env),
): LoopProvider {
  const adapter = new OpenAICompatibleAdapter({
    baseUrl: env[`${preset.env}_BASE_URL`] || preset.baseUrl,
    apiKey: () => credentials.key(preset.id),
    keyEnv: `${preset.env}_API_KEY`,
    local: preset.local,
    defaultModel: env[`${preset.env}_MODEL`] || undefined,
    streamUsage: !preset.local,
  });
  return new LoopProvider({
    id: preset.id,
    adapter,
    sessions,
    info: () => ({ label: preset.label, local: preset.local, configured: adapter.configured }),
  });
}
