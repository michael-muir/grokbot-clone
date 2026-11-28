// Claude's own tools from the app, as an in-process MCP server from the Agent SDK:
// - show_card (#19): widget and form cards, as the built-in loop's show_card;
// - request_secret (#20): asks the user for a secret on a card; Claude gets its name, never its value;
// - run_command (#20): runs a command with the bot's secrets in its environment and the values cut out of the output.
// Claude Code's own Bash never gets secrets: its output goes to the model before the app could redact it.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { defaultShell } from "../agent/shell.ts";
import { shellTool } from "../agent/tools.ts";
import {
  CardRequestError,
  describeAnswer,
  parseCardRequest,
  REQUEST_SECRET_DESCRIPTION,
  showCardDescription,
  showCardKinds,
} from "../cards.ts";
import { redact } from "../secrets.ts";
import type { CardKind, RunCallbacks } from "../types.ts";

export const CARD_SERVER = "smarty";
/** The names Claude Code gives the tools. Showing a card changes nothing, so these two are allowed without asking. */
export const SHOW_CARD_TOOL = `mcp__${CARD_SERVER}__show_card`;
export const REQUEST_SECRET_TOOL = `mcp__${CARD_SERVER}__request_secret`;
/** Runs a command: asks for approval like Bash (it isn't in allowedTools, so canUseTool decides). */
export const RUN_COMMAND_TOOL = `mcp__${CARD_SERVER}__run_command`;
/** A card waits for a person: far longer than an MCP call's default limit. */
const CARD_WAIT_MS = 24 * 60 * 60 * 1000;

type ToolText = { content: { type: "text"; text: string }[]; isError?: boolean };
const reply = (text: string, isError = false): ToolText => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError } : {}),
});

type Ask = NonNullable<RunCallbacks["requestCard"]>;

/** show_card's work: check the card, show it, and give Claude the answer (or what to fix). */
export function showCard(kinds: readonly CardKind[], ask: Ask, signal: AbortSignal) {
  return async (args: Record<string, unknown>): Promise<ToolText> => {
    try {
      if (args.kind === "secret") return reply("Invalid input: ask for secrets with request_secret.", true);
      const card = parseCardRequest(args, showCardKinds(kinds));
      const answer = await ask(card, signal);
      if (answer === undefined) return reply("The run was stopped before the user answered.", true);
      return reply(describeAnswer(card, answer));
    } catch (err) {
      if (err instanceof CardRequestError) return reply(`Invalid input: ${err.message}`, true);
      throw err;
    }
  };
}

/** request_secret's work: the card, then the secret's name (never its value) back to Claude. */
export function requestSecret(kinds: readonly CardKind[], ask: Ask, signal: AbortSignal) {
  return async (args: Record<string, unknown>): Promise<ToolText> => {
    try {
      const card = parseCardRequest({ ...args, kind: "secret" }, kinds);
      const answer = await ask(card, signal);
      if (answer === undefined) return reply("The run was stopped before the user answered.", true);
      return reply(describeAnswer(card, answer, "run_command"));
    } catch (err) {
      if (err instanceof CardRequestError) return reply(`Invalid input: ${err.message}`, true);
      throw err;
    }
  };
}

/** run_command's work: the loop's shell tool, with the bot's secrets, and its output cleared of their values. */
export function runCommand(
  workspaceDir: string,
  secrets: () => Readonly<Record<string, string>>,
  signal: AbortSignal,
  shell = shellTool(),
) {
  return async (args: Record<string, unknown>): Promise<ToolText> => {
    try {
      const r = await shell.run(args, { workspaceDir, signal, secrets });
      return reply(redact(r.output, secrets()), !r.ok);
    } catch (err) {
      return reply(redact(`Invalid input: ${err instanceof Error ? err.message : String(err)}`, secrets()), true);
    }
  };
}

/** Every string in a tool's output (any shape) with the secrets cut out; the same object when nothing changed. */
export function redactDeep(value: unknown, secrets: Readonly<Record<string, string>>): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) {
    const out = value.map((v) => redactDeep(v, secrets));
    return out.some((v, i) => v !== value[i]) ? out : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactDeep(v, secrets);
      if (out[k] !== v) changed = true;
    }
    return changed ? out : value;
  }
  return value;
}

/**
 * A PostToolUse hook for Claude Code: every tool's output (Read, Grep, Bash, ours) has the bot's secrets cut out
 * before the model sees it. It never fails open: output it can't check is replaced.
 */
export function redactingHook(secrets: () => Readonly<Record<string, string>>) {
  return async (input: { hook_event_name: string; tool_response?: unknown }) => {
    if (input.hook_event_name !== "PostToolUse") return {};
    try {
      const values = secrets();
      if (Object.keys(values).length === 0) return {};
      const cleaned = redactDeep(input.tool_response, values);
      if (cleaned === input.tool_response) return {};
      return { hookSpecificOutput: { hookEventName: "PostToolUse" as const, updatedToolOutput: cleaned } };
    } catch {
      return {
        hookSpecificOutput: {
          hookEventName: "PostToolUse" as const,
          updatedToolOutput: "[output hidden: it couldn't be checked for secrets]",
        },
      };
    }
  };
}

const field = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(["text", "textarea", "select", "checkbox"]),
  options: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
});

export interface AppToolsOptions {
  kinds: readonly CardKind[];
  ask: Ask | undefined;
  signal: AbortSignal;
  workspaceDir: string;
  secrets: () => Readonly<Record<string, string>>;
}

/**
 * The MCP server for `options.mcpServers`, or undefined when this run has none of its tools to offer: show_card when
 * the app shows widgets or forms, request_secret when it shows secret cards, run_command when the bot has secrets
 * or may get one this run.
 */
export function appTools({ kinds, ask, signal, workspaceDir, secrets }: AppToolsOptions) {
  const cardKinds = ask ? showCardKinds(kinds) : [];
  const askSecrets = ask !== undefined && kinds.includes("secret");
  const runs = askSecrets || Object.keys(secrets()).length > 0;
  const tools = [];
  if (ask && cardKinds.length) {
    tools.push(
      tool(
        "show_card",
        showCardDescription(cardKinds),
        {
          kind: z.enum(cardKinds as [CardKind, ...CardKind[]]),
          prompt: z.string().optional(),
          options: z.array(z.string()).optional(),
          title: z.string().optional(),
          fields: z.array(field).optional(),
          submit_label: z.string().optional(),
        },
        showCard(kinds, ask, signal),
      ),
    );
  }
  if (ask && askSecrets) {
    tools.push(
      tool(
        "request_secret",
        REQUEST_SECRET_DESCRIPTION.replace("commands you run get it", "commands you run with run_command get it"),
        { name: z.string(), label: z.string(), reason: z.string().optional() },
        requestSecret(kinds, ask, signal),
      ),
    );
  }
  if (runs) {
    const shell = defaultShell();
    const example = shell.name === "PowerShell" ? "$env:GITHUB_TOKEN" : "$GITHUB_TOKEN";
    tools.push(
      tool(
        "run_command",
        `Run a ${shell.name} command in your workspace with the user's saved secrets as environment variables ` +
          `(write them as ${example}). Use it, not Bash, for any command that needs a secret, and never write a ` +
          "secret to a file. Output that contains a secret's value shows [secret NAME]. The user approves each command.",
        { command: z.string(), timeout_seconds: z.number().int().min(1).max(600).optional() },
        runCommand(workspaceDir, secrets, signal),
      ),
    );
  }
  if (tools.length === 0) return undefined;
  return {
    server: createSdkMcpServer({ name: CARD_SERVER, version: "1.0.0", timeout: CARD_WAIT_MS, alwaysLoad: true, tools }),
    allowed: [...(cardKinds.length ? [SHOW_CARD_TOOL] : []), ...(askSecrets ? [REQUEST_SECRET_TOOL] : [])],
  };
}
