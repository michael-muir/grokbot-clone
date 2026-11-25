// The Gemini provider: Google's Gemini models on the built-in agent loop. Key from the keychain or GEMINI_API_KEY.
import { GeminiAdapter } from "../agent/gemini.ts";
import { LoopProvider } from "../agent/loop.ts";
import type { SessionStore } from "../agent/sessions.ts";
import { Credentials, MemoryKeyStore } from "../keys.ts";

export function geminiProvider(
  sessions: SessionStore,
  env: NodeJS.ProcessEnv = process.env,
  credentials: Credentials = new Credentials(new MemoryKeyStore(), env),
): LoopProvider {
  const adapter = new GeminiAdapter({
    baseUrl: env.GEMINI_BASE_URL || undefined,
    apiKey: () => credentials.key("gemini"),
    defaultModel: env.GEMINI_MODEL || undefined,
  });
  return new LoopProvider({
    id: "gemini",
    adapter,
    sessions,
    info: () => ({ label: "Gemini", local: false, configured: adapter.configured }),
  });
}
