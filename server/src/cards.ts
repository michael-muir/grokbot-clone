// Card rules in one place: what a tool may ask for (parseCardRequest), what an answer must look like
// (checkCardAnswer), and what the model reads back (describeAnswer). Pure, so every agent and the gateway agree.
import type { CardAnswer, CardKind, CardRequest, FormField } from "./types.ts";

export const CARD_LIMITS = {
  prompt: 300,
  title: 100,
  label: 100,
  placeholder: 100,
  submitLabel: 30,
  widgetOptions: [2, 6],
  formFields: [1, 8],
  selectOptions: [2, 20],
  text: 2_000,
  textarea: 10_000,
} as const;

const FIELD_TYPES = ["text", "textarea", "select", "checkbox"] as const;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** A request the model can fix: the message goes back to it as the tool's error. */
export class CardRequestError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function text(v: unknown, what: string, max: number, required = true): string {
  // Models in strict modes send null for an optional field they leave out.
  if ((v === undefined || v === null) && !required) return "";
  if (typeof v !== "string" || (required && !v.trim()))
    throw new CardRequestError(`"${what}" must be a non-empty string.`);
  return v.trim().slice(0, max);
}

function list(v: unknown, what: string, [min, max]: readonly [number, number]): unknown[] {
  if (!Array.isArray(v) || v.length < min || v.length > max) {
    throw new CardRequestError(`"${what}" must hold ${min} to ${max} items.`);
  }
  return v;
}

/**
 * The card a tool asked for, cleaned up, or a CardRequestError saying what to fix. `kinds` is what the user's app can
 * show: anything else is refused with a nudge to ask in plain text, which is the fallback when cards can't be shown.
 */
export function parseCardRequest(input: unknown, kinds: readonly CardKind[]): CardRequest {
  if (!isRecord(input)) throw new CardRequestError("The card must be an object.");
  const kind = input.kind;
  if (kind !== "widget" && kind !== "form") throw new CardRequestError('"kind" must be "widget" or "form".');
  if (!kinds.includes(kind)) {
    throw new CardRequestError(`This app can't show ${kind} cards. Ask in plain text instead.`);
  }
  if (kind === "widget") {
    const prompt = text(input.prompt, "prompt", CARD_LIMITS.prompt);
    const labels = list(input.options, "options", CARD_LIMITS.widgetOptions).map((o, i) =>
      text(o, `options[${i}]`, CARD_LIMITS.label),
    );
    const unique = [...new Set(labels)];
    if (unique.length !== labels.length) throw new CardRequestError('"options" must all be different.');
    return { kind, prompt, options: unique.map((label) => ({ label, value: label })) };
  }

  const title = text(input.title, "title", CARD_LIMITS.title);
  const names = new Set<string>();
  const fields = list(input.fields, "fields", CARD_LIMITS.formFields).map((raw, i): FormField => {
    if (!isRecord(raw)) throw new CardRequestError(`"fields[${i}]" must be an object.`);
    const name = typeof raw.name === "string" ? raw.name : "";
    if (!FIELD_NAME.test(name)) {
      throw new CardRequestError(`"fields[${i}].name" must start with a letter and hold only letters, digits and _.`);
    }
    if (names.has(name)) throw new CardRequestError(`Two fields are named "${name}".`);
    names.add(name);
    const type = raw.type;
    if (!FIELD_TYPES.includes(type as FormField["type"])) {
      throw new CardRequestError(`"fields[${i}].type" must be one of ${FIELD_TYPES.join(", ")}.`);
    }
    const field: FormField = {
      name,
      label: text(raw.label, `fields[${i}].label`, CARD_LIMITS.label),
      type: type as FormField["type"],
    };
    if (field.type === "select") {
      const options = list(raw.options, `fields[${i}].options`, CARD_LIMITS.selectOptions).map((o, j) =>
        text(o, `fields[${i}].options[${j}]`, CARD_LIMITS.label),
      );
      if (new Set(options).size !== options.length) {
        throw new CardRequestError(`"fields[${i}].options" must all be different.`);
      }
      field.options = options;
    }
    if (raw.required === true && field.type !== "checkbox") field.required = true;
    const placeholder = text(raw.placeholder, `fields[${i}].placeholder`, CARD_LIMITS.placeholder, false);
    if (placeholder && (field.type === "text" || field.type === "textarea")) field.placeholder = placeholder;
    return field;
  });
  const submitLabel = text(input.submit_label, "submit_label", CARD_LIMITS.submitLabel, false);
  return { kind, title, fields, ...(submitLabel ? { submitLabel } : {}) };
}

/** The answer, cleaned up, if it fits the card; otherwise why not, in words the user can see. */
export function checkCardAnswer(
  card: CardRequest,
  answer: unknown,
): { ok: true; answer: CardAnswer } | { ok: false; error: string } {
  const no = (error: string) => ({ ok: false as const, error });
  if (!isRecord(answer) || answer.kind !== card.kind) return no("That answer doesn't fit this card.");
  if (card.kind === "widget") {
    const value = answer.value;
    if (!card.options.some((o) => o.value === value)) return no("Pick one of the options.");
    return { ok: true, answer: { kind: "widget", value: value as string } };
  }
  const given = answer.values;
  if (!isRecord(given)) return no("That answer doesn't fit this card.");
  const names = new Set(card.fields.map((f) => f.name));
  if (Object.keys(given).some((k) => !names.has(k))) return no("That answer has fields the form doesn't.");
  // Exactly the form's fields (own properties only: a field may be named like an Object method).
  if (card.fields.some((f) => !Object.hasOwn(given, f.name))) return no("That answer is missing some of the form.");
  const values: Record<string, string | boolean> = {};
  for (const f of card.fields) {
    const v = given[f.name];
    if (f.type === "checkbox") {
      if (v !== undefined && typeof v !== "boolean") return no(`"${f.label}" must be on or off.`);
      values[f.name] = v === true;
      continue;
    }
    if (v !== undefined && typeof v !== "string") return no(`"${f.label}" must be text.`);
    const s = (v ?? "").trim();
    if (f.required && !s) return no(`"${f.label}" is required.`);
    if (f.type === "select" && s && !f.options?.includes(s)) return no(`Pick one of the choices for "${f.label}".`);
    const max = f.type === "textarea" ? CARD_LIMITS.textarea : CARD_LIMITS.text;
    if (s.length > max) return no(`"${f.label}" is too long (at most ${max} characters).`);
    values[f.name] = s;
  }
  return { ok: true, answer: { kind: "form", values } };
}

/** What the model reads back: the pick, or one line per field. */
export function describeAnswer(card: CardRequest, answer: CardAnswer): string {
  if (card.kind === "widget" || answer.kind === "widget") {
    return `The user picked: ${answer.kind === "widget" ? answer.value : ""}`;
  }
  const lines = card.fields.map((f) => {
    const v = answer.values[f.name];
    const shown = typeof v === "boolean" ? (v ? "yes" : "no") : v ? v : "(left empty)";
    return `- ${f.label} (${f.name}): ${shown}`;
  });
  return ["The user filled in the form:", ...lines].join("\n");
}

const WIDGET_HELP = 'kind "widget": a question with 2 to 6 options to pick one (prompt, options)';
const FORM_HELP =
  'kind "form": a short form (title, fields: each {name, label, type: text | textarea | select | checkbox, options ' +
  "for select, required?, placeholder?}, submit_label?)";

/** The tool's description, naming only the kinds this user's app can show. */
export function showCardDescription(kinds: readonly CardKind[]): string {
  const help = [kinds.includes("widget") ? WIDGET_HELP : "", kinds.includes("form") ? FORM_HELP : ""].filter(Boolean);
  return (
    `Show the user a card in the chat and wait for their answer. ${help.join(". ")}. Returns the answer.` +
    (kinds.includes("form")
      ? " Never ask for passwords, API keys or other secrets in a form: answers are saved in the chat."
      : "")
  );
}

/** The tool's input schema (JSON Schema) for the built-in loop, with only the kinds this app can show. */
export function showCardSchema(kinds: readonly CardKind[]) {
  return {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...kinds] },
      prompt: { type: "string", description: "Widget: the question, one short sentence." },
      options: { type: "array", items: { type: "string" }, description: "Widget: 2 to 6 choices, a few words each." },
      title: { type: "string", description: "Form: what it's for, a few words." },
      fields: {
        type: "array",
        description: "Form: 1 to 8 fields.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            label: { type: "string" },
            type: { type: "string", enum: ["text", "textarea", "select", "checkbox"] },
            options: { type: "array", items: { type: "string" } },
            required: { type: "boolean" },
            placeholder: { type: "string" },
          },
          required: ["name", "label", "type"],
        },
      },
      submit_label: { type: "string", description: 'Form: the button\'s label, like "Save".' },
    },
    required: ["kind"],
  };
}
