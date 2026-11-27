# #69 Claude: ask questions with choice cards (AskUserQuestion)

Issue: #69 · Milestone: Phase 2 · Desktop app core · Requirements: none · Stories: none

## Goal

When a Claude bot calls Claude Code's own `AskUserQuestion` tool, the user gets the same choice cards the built-in
loop's `ask_user` shows (#64), not an approval card, and Claude gets their answer.

## Scope

- In: routing `AskUserQuestion` from `canUseTool` to `cb.requestChoice`; the answer shape; its status row;
  offline tests on the scripted SDK; a live check that runs on request.
- Out: picking several options at once (`multiSelect`; a later card change: one label is still a valid answer,
  and the model is told so),
  option descriptions and previews on the card (the card shows labels only), and the "unanswered" annotation
  newer Claude Code versions accept.

## Design

New module `server/src/providers/claude-questions.ts`, `answerQuestions(input, ask, signal)`:

- Reads `input.questions`: each needs its question text (no question twice, since answers are keyed by it) and 2
  to 6 different option labels. A malformed call is denied with a message the model can fix. The card shows each
  label trimmed and cut to 100 characters; its value, and so the answer, is the label exactly as Claude sent it.
- A `multiSelect` question still gets a one-pick card, and the answer carries
  `annotations[question].notes` saying only one option could be picked, so the model doesn't take it as the
  whole selection.
- Asks one card per question, in order: prompt = the question, options = the labels (value = label),
  `allowCustom: true` (Claude Code tells the model "Other" is always offered).
- Returns `{behavior: "allow", updatedInput: {...input, answers}}`, `answers` keyed by question text, each the
  chosen label or what the user typed. This is the SDK's documented way to answer `AskUserQuestion` (the
  `answers` field of `AskUserQuestionInput` in `sdk-tools.d.ts`); the live check confirms Claude Code reads it.
- Stopped before an answer: denied ("The run was stopped before the user answered."); later questions aren't
  asked. No `requestChoice` (a host without cards): denied, "Ask in plain text instead."

`ClaudeProvider`'s `canUseTool` sends `AskUserQuestion` there before the approval path. `summarizeTool` labels it
`Asking: <first question>`, like `ask_user`.

## Interfaces

- `answerQuestions(input: Record<string, unknown>, ask: RunCallbacks["requestChoice"], signal): Promise<PermissionResult>`
- `ASK_USER_QUESTION = "AskUserQuestion"`

## Test plan

| Task (from the issue) | Shown by |
| --- | --- |
| Route `AskUserQuestion` to `cb.requestChoice`, one card per question, options from labels | `claude: AskUserQuestion shows a card per question and returns the answers keyed by question` |
| Answer in the form the SDK expects | Same test (`updatedInput.answers`); live: `live: claude reads the answer to AskUserQuestion from a choice card` |
| Contract test with the scripted SDK | `server/test/claude-questions.test.ts` (scripted `QueryFn` through `ClaudeProvider.run`) |
| Live check with a Claude key | `LIVE_PROVIDER=claude npm run test:live` (needs the owner's key; costs a few cents) |

Other tests: stopped mid-question, no card support, malformed input, the status row.

## Risks and open questions

- Answer shape: confirmed live on 2026-11-27 (Claude Code 0.3.331, default model). The card showed Red, Green,
  Blue; answering Green, Claude replied "You picked Green." and the run finished ($0.14). Cleanup of the temp
  folder failed once with EPERM while Claude Code was still exiting; the live tests now retry the delete.
