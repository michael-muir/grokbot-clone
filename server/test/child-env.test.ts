// Child process environment: commands a bot runs never see the gateway token, provider API keys, or a host
// Claude Code session.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runShell } from "../src/agent/shell.ts";
import { childEnv } from "../src/child-env.ts";

test("the gateway token and every provider key variable are removed; the rest is kept", () => {
  const env = childEnv({
    PATH: "/bin",
    HOME: "/home/me",
    GATEWAY_TOKEN: "t",
    OPENAI_API_KEY: "k1",
    gemini_api_key: "k2",
    GOOGLE_API_KEY: "k3",
    ANTHROPIC_API_KEY: "k4",
    OLLAMA_API_KEY: "k5",
  });
  assert.deepEqual(env, { PATH: "/bin", HOME: "/home/me" });
});

test("a host Claude Code session's variables and auth token are removed", () => {
  const env = childEnv({
    PATH: "/bin",
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "s",
    CLAUDE_CODE_MESSAGING_TOKEN: "m",
    claude_code_entrypoint: "sdk",
    CLAUDE_AGENT_SDK_VERSION: "1",
    ANTHROPIC_AUTH_TOKEN: "t",
    ANTHROPIC_BASE_URL: "https://proxy.example",
  });
  assert.deepEqual(env, { PATH: "/bin", ANTHROPIC_BASE_URL: "https://proxy.example" });
});

test("a shell command can't read the gateway token", async () => {
  const before = process.env.GATEWAY_TOKEN;
  process.env.GATEWAY_TOKEN = "super-secret-token";
  try {
    const script = process.platform === "win32" ? 'Write-Output "[$env:GATEWAY_TOKEN]"' : 'echo "[$GATEWAY_TOKEN]"';
    const result = await runShell(script, {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      timeoutMs: 20_000,
      maxOutput: 1000,
    });
    assert.match(result.output, /\[\]/);
    assert.doesNotMatch(result.output, /super-secret-token/);
  } finally {
    if (before === undefined) delete process.env.GATEWAY_TOKEN;
    else process.env.GATEWAY_TOKEN = before;
  }
});
