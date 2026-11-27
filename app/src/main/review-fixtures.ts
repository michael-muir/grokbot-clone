// The core screens the visual review captures, and the fixture data the app renders for them.
import type { ProviderTest } from "../../../server/src/client/gateway-client.ts";
import type { BotActivity, ProviderSummary, PublicBot, TranscriptEntry } from "../../../server/src/types.ts";

/** The reference shots in reference/screens are all this size. */
export const CAPTURE_WIDTH = 1040;
export const CAPTURE_HEIGHT = 760;

export type ReviewStep =
  | { kind: "click"; text: string }
  | { kind: "press"; selector: string }
  | { kind: "wait"; selector: string }
  | { kind: "menu"; selector: string }
  | { kind: "settings" };

export interface ReviewScene {
  id: string;
  title: string;
  /** File name in reference/screens, or null when this screen has no reference shot. */
  reference: string | null;
  note: string;
  onboarded: boolean;
  entries: readonly TranscriptEntry[];
  steps: readonly ReviewStep[];
  /** On screen before the steps, so the page has loaded. */
  start: string;
  /** On screen after the steps. This is the frame that is captured. */
  until: string;
}

const at = 1_700_000_000_000;

export const REVIEW_BOTS: readonly PublicBot[] = [
  { id: "smarty", name: "Smarty", provider: "ollama", model: "llama3.2", avatar: { shape: "face", color: "amber" } },
  { id: "nova", name: "Nova", provider: "claude", avatar: { shape: "face", color: "purple" } },
];

export const REVIEW_PROVIDERS: readonly ProviderSummary[] = [
  { id: "ollama", label: "Ollama", local: true, configured: true, needsKey: false, keySource: null },
  { id: "claude", label: "Claude", local: false, configured: false, needsKey: true, keySource: null },
  { id: "openai", label: "OpenAI", local: false, configured: false, needsKey: true, keySource: null },
];

export const REVIEW_ACTIVITY: readonly BotActivity[] = [];

export const REVIEW_MODELS = ["llama3.2", "llama3.1"];

export const REVIEW_TEST: ProviderTest = { ok: true, models: [...REVIEW_MODELS] };

function entry(id: string, body: TranscriptEntry["body"]): TranscriptEntry {
  const n = Number(id.slice(1));
  return { seq: n, updatedSeq: n, id, botId: "smarty", body, createdAt: at, updatedAt: at };
}

const thread: readonly TranscriptEntry[] = [
  entry("e1", { kind: "user_message", text: "Summarize what you can do." }),
  entry("e2", {
    kind: "assistant_text",
    text: "I can chat, use tools you approve, and remember this conversation.",
    streaming: false,
  }),
  entry("e3", { kind: "run", provider: "ollama", state: "finished" }),
];

const choice: readonly TranscriptEntry[] = [
  entry("e1", { kind: "user_message", text: "Help me choose." }),
  entry("e4", {
    kind: "choice",
    prompt: "Which model should I use?",
    options: [
      { label: "Fast", value: "Fast" },
      { label: "Careful", value: "Careful" },
    ],
    allowCustom: false,
    state: "pending",
  }),
];

const chatStart = ".name-pill";

export const SCENES: readonly ReviewScene[] = [
  {
    id: "welcome",
    title: "Onboarding welcome",
    reference: "03-onb1.png",
    note: "Our welcome takes the place of the reference's first onboarding screen. 01-launch.png is an account sign-in, which this app does not have.",
    onboarded: false,
    entries: [],
    steps: [],
    start: "h1.onboarding-wordmark",
    until: "h1.onboarding-wordmark",
  },
  {
    id: "onboarding-model",
    title: "Onboarding model",
    reference: "04-onb2.png",
    note: "The model step, before the provider has been tested.",
    onboarded: false,
    entries: [],
    steps: [
      { kind: "click", text: "Get started" },
      { kind: "wait", selector: "form.onboarding-form" },
    ],
    start: "h1.onboarding-wordmark",
    until: "form.onboarding-form",
  },
  {
    id: "onboarding-name",
    title: "Onboarding name",
    reference: null,
    note: "The name step has no reference shot. 08-after-name.png is the chat after a name was chosen.",
    onboarded: false,
    entries: [],
    steps: [
      { kind: "click", text: "Get started" },
      { kind: "wait", selector: "form.onboarding-form" },
      { kind: "click", text: "Connect" },
      { kind: "click", text: "Continue" },
      { kind: "wait", selector: "#onboarding-name-note" },
    ],
    start: "h1.onboarding-wordmark",
    until: "#onboarding-name-note",
  },
  {
    id: "chat",
    title: "Empty chat",
    reference: "06-main-welcome.png",
    note: "A new conversation: sidebar, header, empty transcript, composer.",
    onboarded: true,
    entries: [],
    steps: [],
    start: chatStart,
    until: chatStart,
  },
  {
    id: "sidebar",
    title: "Sidebar",
    reference: "07-sidebar.png",
    note: "The same empty chat, compared with the sidebar reference.",
    onboarded: true,
    entries: [],
    steps: [],
    start: chatStart,
    until: ".sidebar",
  },
  {
    id: "thread",
    title: "Conversation",
    reference: "12-main-full.png",
    note: "A finished exchange. Run rows are hidden; the text stays.",
    onboarded: true,
    entries: thread,
    steps: [],
    start: chatStart,
    until: "[role='log']",
  },
  {
    id: "choice",
    title: "Choice card",
    reference: null,
    note: "A pending choice card. The reference app asks this in its own way and has no matching shot.",
    onboarded: true,
    entries: choice,
    steps: [],
    start: chatStart,
    until: "[aria-label^='Question:']",
  },
  {
    id: "panel",
    title: "Bot panel",
    reference: "30-panel-activity.png",
    note: "Opened from the name pill.",
    onboarded: true,
    entries: thread,
    steps: [
      { kind: "press", selector: ".name-pill" },
      { kind: "wait", selector: "#bot-panel" },
    ],
    start: chatStart,
    until: "#bot-panel",
  },
  {
    id: "bot-menu",
    title: "Bot menu",
    reference: "39-sidebar-ctx.png",
    note: "The context menu on a bot that is not the main one.",
    onboarded: true,
    entries: [],
    steps: [
      { kind: "menu", selector: '.bot-tile[data-bot-id="nova"]' },
      { kind: "wait", selector: ".bot-menu" },
    ],
    start: chatStart,
    until: ".bot-menu",
  },
  {
    id: "settings-general",
    title: "Settings, General",
    reference: "23-settings-General.png",
    note: "General only. Account, language and microphone are not in this app.",
    onboarded: true,
    entries: thread,
    steps: [{ kind: "settings" }],
    start: chatStart,
    until: ".settings-dialog",
  },
  {
    id: "settings-models",
    title: "Settings, Models & keys",
    reference: null,
    note: "Our models page. The reference's Computer, Vault and Usage pages are later work.",
    onboarded: true,
    entries: [],
    steps: [
      { kind: "settings" },
      { kind: "wait", selector: ".settings-dialog" },
      { kind: "click", text: "Models & keys" },
    ],
    start: chatStart,
    // The dialog is already open on General. The Refresh button exists only on Models & keys.
    until: "button.secondary.small",
  },
];
