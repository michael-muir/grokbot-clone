// Claude Code's AskUserQuestion tool, answered with choice cards in the transcript instead of an approval card.
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { ChoiceRequest } from "../types.ts";

export const ASK_USER_QUESTION = "AskUserQuestion";

/** Most choices a card shows; Claude Code itself sends 2 to 4. */
const MAX_OPTIONS = 6;

type Ask = (request: ChoiceRequest, signal: AbortSignal) => Promise<string | undefined>;

interface Question {
  question: string;
  labels: string[];
}

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
  for (const q of questions) {
    const answer = await ask(
      {
        prompt: q.question.slice(0, 300),
        options: q.labels.map((label) => ({ label, value: label })),
        // Claude Code tells the model that an "Other" answer is always offered.
        allowCustom: true,
      },
      signal,
    );
    if (answer === undefined) return { behavior: "deny", message: "The run was stopped before the user answered." };
    answers[q.question] = answer;
  }
  return { behavior: "allow", updatedInput: { ...input, answers } };
}

/** The questions, checked; or what's wrong with them, for the model. */
function readQuestions(input: Record<string, unknown>): Question[] | string {
  const raw = input.questions;
  if (!Array.isArray(raw) || raw.length === 0) return '"questions" must be a list of at least one question.';
  const questions: Question[] = [];
  for (const item of raw) {
    const q = item as { question?: unknown; options?: unknown };
    if (typeof q?.question !== "string" || !q.question.trim()) return 'Each question needs its "question" text.';
    const labels = Array.isArray(q.options)
      ? [
          ...new Set(
            q.options.flatMap((o: { label?: unknown }) =>
              typeof o?.label === "string" && o.label.trim() ? [o.label.trim().slice(0, 100)] : [],
            ),
          ),
        ]
      : [];
    if (labels.length < 2) return `"${q.question.slice(0, 80)}" needs at least 2 different options with labels.`;
    questions.push({ question: q.question, labels: labels.slice(0, MAX_OPTIONS) });
  }
  return questions;
}
