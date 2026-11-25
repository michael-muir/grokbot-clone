// The environment for processes the agent starts (shell commands, provider CLIs): the gateway's own, minus its
// secrets. A command a bot runs must not be able to read the gateway token (and approve its own cards) or API keys.
import { KEY_ENV } from "./keys.ts";

const SECRET_VARS = new Set(["GATEWAY_TOKEN", ...Object.values(KEY_ENV).flat()]);

export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    // Windows env names are case-insensitive, so compare in upper case.
    if (!SECRET_VARS.has(name.toUpperCase())) out[name] = value;
  }
  return out;
}
