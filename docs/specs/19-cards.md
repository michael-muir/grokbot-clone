# #19 Card entries: widget and user form

Issue: #19 · Milestone: Phase 3 · Bots, cards and polish · Requirements: CD-2, CD-4, TR-3 · Stories: US-15

## Goal

A bot can post an interactive card in the chat and wait for the answer in the same run. Two kinds come first:

- **widget:** pick one of a few options;
- **form:** fill in a few fields.

The app says which kinds it can show. A bot talking to a client that can't show a kind asks in plain text instead.

## Scope

- **In:**
  - A generic `card` transcript entry.
  - `requestCard` in the provider callbacks.
  - `POST /bots/:id/cards/:entryId`.
  - The `show_card` tool, for the built-in loop and for Claude (as an in-process MCP tool).
  - Card kinds declared per message.
  - Widget and form cards in the app, locked once answered.
  - The fake provider's `/widget` and `/form`.
- **Out:**
  - **Other reference kinds** (connector, secret request, drafts, approvals of payments…). The secret request is #20;
    the rest come with their features.
  - **Moving `ask_user` / `choice` onto cards.** Choice cards keep working as they are (#64, #69): choices with "type
    your own" stay there, and a widget is the plain pick.
  - **Secrets in forms.** A form's answer is saved in the transcript and shown to the model, so the tool tells the
    model never to ask for passwords or keys in one. #20 is the safe way.

## Reference

- **The renderer** declares `rendered_card_kinds`, and answers go back through `RespondGrokBotWidget{entry_id,
  value}` and `SubmitGrokBotUserForm` (reference/BEHAVIOR.md §5).
- **The onboarding question** ("What would you like to call me?" with "C Grok Bot") is a widget (08-after-name).
- **Our version:** the words, layout and form fields are our own.

## Design

### Types (`server/src/types.ts`)

```ts
export const CARD_KINDS = ["widget", "form"] as const;
export type CardKind = (typeof CARD_KINDS)[number];

export interface WidgetCard { kind: "widget"; prompt: string; options: ChoiceOption[] }
export interface FormField {
  name: string;          // the key in the answer
  label: string;
  type: "text" | "textarea" | "select" | "checkbox";
  options?: string[];    // select only
  required?: boolean;
  placeholder?: string;
}
export interface FormCard { kind: "form"; title: string; fields: FormField[]; submitLabel?: string }
export type CardRequest = WidgetCard | FormCard;

export type CardAnswer =
  | { kind: "widget"; value: string }
  | { kind: "form"; values: Record<string, string | boolean> };

// EntryBody
| { kind: "card"; card: CardRequest; state: "pending" | "answered" | "expired"; answer?: CardAnswer }

RunRequest.cardKinds?: CardKind[]              // what the client that sent the message can show
RunCallbacks.requestCard?(card, signal): Promise<CardAnswer | undefined>   // undefined: stopped
```

The issue asks for a card entry "with kind, payload and state". Here `card.kind` is the kind, the rest of `card`
is the payload, and `state` and `answer` are the state.

### Rules in one place (`server/src/cards.ts`, pure)

- **`parseCardRequest(input, kinds)`** turns a tool's input into a `CardRequest`, or throws a message the model can
  act on. A kind the client can't show gets "This app can't show <kind> cards. Ask in plain text instead.":
  that's the fallback to text. Limits:
  - **Widget:** 2 to 6 options of up to 100 characters each, and a prompt of up to 300.
  - **Form:** 1 to 8 fields, each with a unique `name` (letters, digits, `_`), and a label of up to 100
    characters. A select has 2 to 20 options.
- **`checkCardAnswer(card, answer)`** returns a clean `CardAnswer`, or why it doesn't fit:
  - a widget value must be one of the options;
  - a form's values must be exactly its fields;
  - a required field can't be empty;
  - a checkbox is a boolean;
  - a select's value must be one of its options;
  - text is at most 2,000 characters, and a textarea at most 10,000.
- **`describeAnswer(card, answer)`** is what the model reads: "The user picked: …", or one line per field.

### Gateway

- **`requestCard`:** posts the entry and waits, as choices do (`Waiters`, a pending card, then answered or expired
  when the run stops). It refuses a kind the run's client didn't declare, as a second line of defense behind the
  tools.
- **`answerCard(botId, entryId, answer)`:** returns `ok`, `not-pending` or `invalid` (with the reason). A valid
  answer resolves the waiter, so the answer reaches the waiting run, and the entry becomes `answered` with the
  answer, locked.
- **`sendMessage(botId, text, nonce?, threadId?, cardKinds?)`:** the kinds are passed on as `RunRequest.cardKinds`.
- **On startup:** a pending card left behind by a crash becomes `expired`, like a choice card.

HTTP:

- `POST /bots/:id/messages` takes `cardKinds?: string[]`. Unknown names are dropped.
- `POST /bots/:id/cards/:entryId {answer}` answers 200, 400 with the reason, or 404 when the card isn't waiting.

### Agents

- **Built-in loop:**
  - A `show_card` tool (read-only, so it needs no approval) takes `{kind:"widget", prompt, options}` or
    `{kind:"form", title, fields, submit_label?}`.
  - A tool can now say whether a run offers it (`Tool.available(req)`). `show_card` is offered only when the run
    has card kinds. Its prompt note names the kinds this client can show.
- **Claude:**
  - The same tool, as an in-process MCP server from the SDK (`createSdkMcpServer` + `tool`), named
    `mcp__smarty__show_card` and allowed without asking.
  - It's added only when the run has card kinds. The handler calls the same parse, ask and describe.
  - This needs `zod`: the SDK's `tool()` takes a zod schema. It's added to the server's dependencies, pinned to
    4.6.7, the version the SDK already installs. This is the one new dependency.
- **Fake:** `/widget` asks for a size (Small, Medium, Large); `/form` asks for a name and a "subscribe" checkbox.
  Each replies with the answer.

### App

- **Message kinds:** the app sends `cardKinds: ["widget", "form"]` with each message (`RENDERED_CARD_KINDS`).
- **Card component:** a new `chat/Card.tsx`.
  - **Widget:** the prompt and a lettered button per option, styled like the choice card.
  - **Form:** a title, labeled fields (input, textarea, select, checkbox) and a submit button. Required fields are
    marked, and submit stays disabled until they're filled.
- **States:**
  - **Answered:** the card locks. It shows the answer, with its controls disabled.
  - **Expired:** it says it's no longer waiting.
  - **Failed answer:** the error shows on the card, and the user's input stays.
- **Rows:** a card stands alone on the bot's side, like other cards. A pending card stops the Thinking row, and
  counts as "Needs you" on a thread's replies button.

## Interfaces

Above, plus:

- `GatewayClient.answerCard(botId, entryId, answer)`; `sendMessage(…, threadId?, cardKinds?)`.
- IPC: `answerCard`, and `sendMessage`'s fifth argument.
- `Tool.available?(req: { cardKinds?: CardKind[] }): boolean`; `ToolContext.card?`.

## Test plan

| Acceptance criterion / task | Shown by |
| --- | --- |
| `card` entry kind with kind, payload and state | `cards: a widget card is posted pending, answered, and locked with its answer`; `cards: a run stopped while a card waits leaves it expired`; `cards: a card left pending by a crash is expired on startup` |
| `POST /bots/:id/cards/:entryId` returns the answer to the waiting run | `cards: the answer reaches the same run` (the fake replies with it in that run); `http: cards answer 200, 400 with the reason, 404 when not waiting` |
| App declares card kinds; agent falls back to text otherwise | `cards: a run without card kinds offers no card tool, and a kind the client can't show is refused with "ask in plain text"` (loop); `claude: show_card is offered only with card kinds, and answers through requestCard` |
| Widget and form cards in the UI | `card rules: …` (parse and answer checks); `rows: a card stands alone, and a pending card stops Thinking and marks its thread`; manual check |
| An answered card locks | `cards: … locked with its answer` (a second answer is `not-pending`); manual check: controls disabled after answering |
| The answer reaches the same run | `cards: the answer reaches the same run` |

**Manual check, 2026-11-27.** In the app, on the fake provider, in an isolated profile on port 9411:

- **Widget:**
  - `/widget` showed "Which size?" with lettered Small, Medium and Large.
  - Picking Medium locked the card: every option disabled, Medium highlighted, and "Answered: Medium".
  - The reply "Got it: "Medium"" came in the same run.
- **Form:**
  - `/form` showed "Sign up" with a required Name, marked *, and a checkbox.
  - "Sign up" (the submit label) stayed disabled until the name was filled.
  - After filling "Ada", ticking the box and submitting, the reply listed both values.
  - The form locked (inputs disabled, "Sent"), and focus moved to the result line.

## Risks and open questions

- **What the transcript keeps.** Form answers are saved there and given to the model. That's why secrets belong in
  #20's card, not a form, and the tool description says so.
- **Two ways to ask a question.** The widget overlaps the choice card. A later change could fold `choice` into
  cards; kept apart now so #64 and #69 keep working untouched.

**Code review:** it found six issues, all fixed. Each has a test, except the two UI changes, which were checked by
reading the code.

- **Locking:** a card's controls stay locked after a successful answer until the gateway's copy arrives. A second
  click used to be refused with a 404 that then showed under the locked card.
- **Focus:** a card takes focus only when it locks while shown. Before, an old answered card grabbed focus and
  scrolled into view when a chat opened. `ChoiceCard` had the same bug and has the same fix.
- **Only the kinds the app can show:** `show_card`'s schema enum and description name only the kinds the client
  declared (`Tool.specFor` for the loop, and the same for Claude's zod schema).
- **Null fields:** an optional field sent as `null`, as strict-mode models do, counts as left out.
- **Exact answers:** a form answer must hold exactly the form's fields, read as own properties (a field may be named
  `constructor`).
- **Comments:** two stale ones updated.
