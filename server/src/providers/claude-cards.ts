// Claude's show_card tool (#19): an in-process MCP server from the Agent SDK, so Claude can post widget and form cards
// the way the built-in loop's show_card does. Offered only when the user's app can show cards.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { CardRequestError, describeAnswer, parseCardRequest, SHOW_CARD_DESCRIPTION } from "../cards.ts";
import type { CardKind, RunCallbacks } from "../types.ts";

export const CARD_SERVER = "smarty";
/** The name Claude Code gives the tool: allowed without asking, since showing a card changes nothing. */
export const SHOW_CARD_TOOL = `mcp__${CARD_SERVER}__show_card`;
/** A card waits for a person: far longer than an MCP call's default limit. */
const CARD_WAIT_MS = 24 * 60 * 60 * 1000;

type ToolText = { content: { type: "text"; text: string }[]; isError?: boolean };
const reply = (text: string, isError = false): ToolText => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError } : {}),
});

/** The tool's work: check the card, show it, and give Claude the answer (or what to fix). */
export function showCard(
  kinds: readonly CardKind[],
  ask: NonNullable<RunCallbacks["requestCard"]>,
  signal: AbortSignal,
): (args: Record<string, unknown>) => Promise<ToolText> {
  return async (args) => {
    try {
      const card = parseCardRequest(args, kinds);
      const answer = await ask(card, signal);
      if (answer === undefined) return reply("The run was stopped before the user answered.", true);
      return reply(describeAnswer(card, answer));
    } catch (err) {
      if (err instanceof CardRequestError) return reply(`Invalid input: ${err.message}`, true);
      throw err;
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

/** The MCP server holding show_card, for `options.mcpServers`. */
export function cardServer(
  kinds: readonly CardKind[],
  ask: NonNullable<RunCallbacks["requestCard"]>,
  signal: AbortSignal,
) {
  return createSdkMcpServer({
    name: CARD_SERVER,
    version: "1.0.0",
    timeout: CARD_WAIT_MS,
    alwaysLoad: true,
    tools: [
      tool(
        "show_card",
        SHOW_CARD_DESCRIPTION,
        {
          kind: z.enum(["widget", "form"]),
          prompt: z.string().optional(),
          options: z.array(z.string()).optional(),
          title: z.string().optional(),
          fields: z.array(field).optional(),
          submit_label: z.string().optional(),
        },
        showCard(kinds, ask, signal),
      ),
    ],
  });
}
