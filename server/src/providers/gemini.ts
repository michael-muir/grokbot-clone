// The Gemini provider: Google's Gemini models on the built-in agent loop. Key from GEMINI_API_KEY for now (#5).
import { GeminiAdapter } from "../agent/gemini.ts";
import { LoopProvider } from "../agent/loop.ts";
import type { SessionStore } from "../agent/sessions.ts";

export function geminiProvider(sessions: SessionStore, env: NodeJS.ProcessEnv = process.env): LoopProvider {
  const adapter = new GeminiAdapter({
    baseUrl: env.GEMINI_BASE_URL || undefined,
    apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || undefined,
    defaultModel: env.GEMINI_MODEL || undefined,
  });
  return new LoopProvider({
    id: "gemini",
    adapter,
    sessions,
    info: { label: "Gemini", local: false, configured: adapter.configured },
  });
}
