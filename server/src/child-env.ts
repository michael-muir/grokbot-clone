// The environment for processes the agent starts (shell commands, provider CLIs): the gateway's own, minus its
// secrets. A command a bot runs must not be able to read the gateway token (and approve its own cards) or API keys.
import { KEY_ENV } from "./keys.ts";

const SECRET_VARS = new Set([
  "GATEWAY_TOKEN",
  // Claude Code prefers this over ANTHROPIC_API_KEY, so a host's token would replace the bot's own key.
  "ANTHROPIC_AUTH_TOKEN",
  ...Object.values(KEY_ENV).flat(),
]);

/**
 * A host Claude Code session (CLAUDECODE, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_MESSAGING_TOKEN, …). When the
 * gateway is started from inside one, these would make the Claude provider act as part of that session, with its
 * account, and hand its messaging token to every command a bot runs.
 */
const HOST_CLAUDE = /^CLAUDE/;

export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    // Windows env names are case-insensitive, so compare in upper case.
    const upper = name.toUpperCase();
    if (!SECRET_VARS.has(upper) && !HOST_CLAUDE.test(upper)) out[name] = value;
  }
  return out;
}
