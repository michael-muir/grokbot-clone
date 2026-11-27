// Claude Code's AskUserQuestion tool, answered with choice cards in the transcript instead of an approval card.
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { ChoiceRequest } from "../types.ts";

export const ASK_USER_QUESTION = "AskUserQuestion";

/** Most choices a card holds, as for ask_user; Claude Code itself sends 2 to 4. */
const MAX_OPTIONS = 6;

type Ask = (request: ChoiceRequest, signal: AbortSignal) => Promise<string | undefined>;

interface Question {
  question: string;
  /** Shown on the card trimmed and cut to fit; `value` is the label exactly as Claude sent it. */
  options: { label: string; value: string }[];
  /** Claude Code told the model several could be picked; the card takes one. */
  multiSelect: boolean;
}

export const SINGLE_PICK_NOTE =
  "This app lets the user pick only one option per question. Ask in chat if you need more than one.";

/**
 * Shows one card per question, in order, and hands Claude Code the answers the way it reads them: the tool's own
 * input with `answers` added, keyed by question text, each the chosen label (or what the user typed).
 * Without a way to show cards, or if the run stops first, the tool is denied with a reason the model can act on.
 */
export async function answerQuestions(
  input: Record<string, unknown>,
  ask: Ask | undefined,
  signal: AbortSignal,
): Promise<PermissionResult> {
  const questions = readQuestions(input);
  if (typeof questions === "string") return { behavior: "deny", message: questions };
  if (!ask)
    return { behavior: "deny", message: "Questions with choices can't be shown here. Ask in plain text instead." };
  const answers: Record<string, string> = {};
  const annotations: Record<string, { notes: string }> = {};
  for (const q of questions) {
    const answer = await ask(
      {
        prompt: q.question.slice(0, 300),
        options: q.options,
        // Claude Code tells the model that an "Other" answer is always offered.
        allowCustom: true,
      },
      signal,
    );
    if (answer === undefined) return { behavior: "deny", message: "The run was stopped before the user answered." };
    answers[q.question] = answer;
    // Without this the model would take the one pick as the whole selection.
    if (q.multiSelect) annotations[q.question] = { notes: SINGLE_PICK_NOTE };
  }
  return {
    behavior: "allow",
    updatedInput: { ...input, answers, ...(Object.keys(annotations).length ? { annotations } : {}) },
  };
}

/** The questions, checked; or what's wrong with them, for the model. */
function readQuestions(input: Record<string, unknown>): Question[] | string {
  const raw = input.questions;
  if (!Array.isArray(raw) || raw.length === 0) return '"questions" must be a list of at least one question.';
  const questions: Question[] = [];
  for (const item of raw) {
    const q = item as { question?: unknown; options?: unknown; multiSelect?: unknown };
    if (typeof q?.question !== "string" || !q.question.trim()) return 'Each question needs its "question" text.';
    const text = q.question;
    // Answers are keyed by question text: a repeated question would lose an answer.
    if (questions.some((other) => other.question === text)) return `"${text.slice(0, 80)}" is asked twice.`;
    const options: Question["options"] = [];
    for (const o of Array.isArray(q.options) ? (q.options as { label?: unknown }[]) : []) {
      if (typeof o?.label !== "string" || !o.label.trim()) continue;
      const label = o.label;
      if (options.some((seen) => seen.value.trim() === label.trim())) continue;
      options.push({ label: label.trim().slice(0, 100), value: label });
    }
    if (options.length < 2) return `"${text.slice(0, 80)}" needs at least 2 different options with labels.`;
    if (options.length > MAX_OPTIONS) return `"${text.slice(0, 80)}" has more than ${MAX_OPTIONS} options.`;
    questions.push({ question: text, options, multiSelect: q.multiSelect === true });
  }
  return questions;
}
