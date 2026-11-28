// The contract between the renderer and the main process: call names with their argument and result types,
// stream events, and the checks main runs on everything the renderer sends.
import type { BotPatch, ProviderTest, UsageReport } from "../../../server/src/client/gateway-client.ts";
import type { StreamState } from "../../../server/src/client/subscribe.ts";
import type { SearchResult } from "../../../server/src/search.ts";
import {
  type ApprovalDecision,
  type BotActivity,
  type CardAnswerIn,
  type CardKind,
  type Feedback,
  isAvatarColor,
  isAvatarShape,
  isCardKind,
  isProviderId,
  type NewBot,
  type ProviderId,
  type ProviderSummary,
  type PublicBot,
  type TranscriptEntry,
} from "../../../server/src/types.ts";
import type { AppSettings } from "./settings.ts";

export type { AppSettings } from "./settings.ts";

export const CHANNELS = {
  call: "gateway:call",
  connection: "gateway:connection",
  streamOpen: "stream:open",
  streamClose: "stream:close",
  streamEvent: "stream:event",
  ready: "app:ready",
  settingsGet: "settings:get",
  settingsSet: "settings:set",
  /** main → renderer: the settings changed (in any window). */
  settingsChanged: "settings:changed",
  /** main → renderer: the menu asked to open Settings. */
  settingsOpen: "settings:open",
} as const;

/** Every gateway call the renderer may make, by name. */
export interface Calls {
  listBots: { args: []; result: PublicBot[] };
  /** Creates a bot on the main bot's model. */
  createBot: { args: [input: NewBot]; result: PublicBot };
  updateBot: { args: [botId: string, patch: BotPatch]; result: PublicBot };
  /** Deletes the bot, its transcript and its computer. */
  deleteBot: { args: [botId: string]; result: undefined };
  transcript: { args: [botId: string, since: number]; result: TranscriptEntry[] };
  /** Returns the id of the user entry the message became. With `threadId`, the message goes in that thread. */
  sendMessage: {
    args: [botId: string, text: string, clientNonce?: string, threadId?: string, cardKinds?: CardKind[]];
    result: string;
  };
  /** Answers a widget or form card. */
  answerCard: { args: [botId: string, entryId: string, answer: CardAnswerIn]; result: undefined };
  interrupt: { args: [botId: string]; result: undefined };
  /** Starts the bot's conversation over; the old one stays readable. */
  startFresh: { args: [botId: string]; result: undefined };
  /** Resumes a reply the app cut off, in the same conversation (#22). */
  resumeRun: { args: [botId: string, runId: string, cardKinds?: CardKind[]]; result: undefined };
  /** Rolls back to before one of the user's messages; returns its text. */
  rollBack: { args: [botId: string, entryId: string]; result: string };
  /** Adds or removes a reaction on a message; returns its reactions now. */
  react: { args: [botId: string, entryId: string, emoji: string, on: boolean]; result: string[] };
  /** Rates a bot message; null clears the rating. */
  rate: { args: [botId: string, entryId: string, vote: Feedback | null]; result: undefined };
  answerApproval: { args: [botId: string, entryId: string, decision: ApprovalDecision]; result: undefined };
  answerChoice: { args: [botId: string, entryId: string, answer: string]; result: undefined };
  listProviders: { args: []; result: ProviderSummary[] };
  /** Each bot's latest message, and the messages that contain the query (#23). */
  search: { args: [query: string]; result: SearchResult };
  /** Token and cost totals for the last 7, 30 or 90 days. */
  usage: { args: [days: number]; result: UsageReport };
  listModels: { args: [provider: ProviderId]; result: string[] };
  testProvider: { args: [provider: ProviderId, baseUrl?: string]; result: ProviderTest };
  setKey: { args: [provider: ProviderId, key: string]; result: undefined };
  deleteKey: { args: [provider: ProviderId]; result: undefined };
}

export type CallName = keyof Calls;

/** One checked call, with the name and arguments tied together. */
export type Call = { [K in CallName]: { name: K; args: Calls[K]["args"] } }[CallName];

/** Errors cross IPC as data: Electron would otherwise flatten them into "Error invoking remote method…". */
export type CallResult<T> = { ok: true; value: T } | { ok: false; error: { message: string; status: number } };

export type StreamEvent =
  | { kind: "entry"; entry: TranscriptEntry }
  /** Every bot's activity (activity streams only). */
  | { kind: "activity"; bots: BotActivity[] }
  | { kind: "state"; state: StreamState }
  /** The connection dropped and will be retried. */
  | { kind: "error"; message: string }
  /** The stream stopped for good (closed, or refused by the gateway). */
  | { kind: "ended"; error?: string };

/** A stream to open: one bot's transcript, or every bot's activity. */
export type StreamOpen = { id: string } & (
  | { topic: "transcript"; botId: string; since: number }
  | { topic: "activity" }
);

export type ConnectionInfo = { ok: true; url: string; spawned: boolean } | { ok: false; error: string };

/** What the preload puts on `window.desktop`. */
export interface DesktopApi {
  call<K extends CallName>(name: K, ...args: Calls[K]["args"]): Promise<CallResult<Calls[K]["result"]>>;
  connection(): Promise<ConnectionInfo>;
  /** Streams a bot's transcript from after `since`. Returns a function that stops it. */
  subscribe(botId: string, since: number, onEvent: (event: StreamEvent) => void): () => void;
  /** Streams which bots are running: a snapshot now and on every change. Returns a function that stops it. */
  activity(onEvent: (event: StreamEvent) => void): () => void;
  /** The renderer is up and listed the bots; the smoke test waits for this. */
  ready(botCount: number): void;
  settings: {
    get(): Promise<AppSettings>;
    /** Saves a change and returns the full settings; rejects if the change isn't valid. */
    set(patch: Partial<AppSettings>): Promise<AppSettings>;
    onChange(listener: (settings: AppSettings) => void): () => void;
    /** The menu's Settings… item. */
    onOpen(listener: () => void): () => void;
  };
}

const isString = (v: unknown): v is string => typeof v === "string";
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const isId = (v: unknown): v is string => isString(v) && v.length > 0 && v.length <= 200;
/** Same limits as the gateway's: 1 to 100 characters. */
const isNonce = (v: unknown): v is string => isString(v) && v.length > 0 && v.length <= 100;
const isCursor = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= -1;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optional =
  <T>(check: (v: unknown) => v is T) =>
  (v: unknown): v is T | undefined =>
    v === undefined || check(v);

const isAvatar = (v: unknown): v is NonNullable<NewBot["avatar"]> =>
  isRecord(v) &&
  Object.keys(v).every((k) => k === "shape" || k === "color") &&
  isAvatarShape(v.shape) &&
  isAvatarColor(v.color);

function isNewBot(v: unknown): v is NewBot {
  if (!isRecord(v)) return false;
  return (
    Object.keys(v).every((k) => k === "name" || k === "avatar") &&
    isString(v.name) &&
    v.name.trim() !== "" &&
    v.name.length <= 200 &&
    optional(isAvatar)(v.avatar)
  );
}

function isPatch(v: unknown): v is BotPatch {
  if (!isRecord(v)) return false;
  const known = new Set(["name", "provider", "model", "baseUrl", "pinned", "hidden", "avatar", "main"]);
  return (
    Object.keys(v).every((k) => known.has(k)) &&
    optional(isAvatar)(v.avatar) &&
    (v.main === undefined || v.main === true) &&
    optional(isString)(v.name) &&
    optional(isProviderId)(v.provider) &&
    optional(isString)(v.model) &&
    optional(isString)(v.baseUrl) &&
    optional(isBoolean)(v.pinned) &&
    optional(isBoolean)(v.hidden)
  );
}

const isCardKinds = (v: unknown): v is CardKind[] => Array.isArray(v) && v.length <= 10 && v.every(isCardKind);

/** A card answer's shape and size; the gateway checks it against its card. A secret's value passes through unlogged. */
function isCardAnswer(v: unknown): v is CardAnswerIn {
  if (!isRecord(v)) return false;
  if (v.kind === "widget") return isString(v.value) && v.value.length <= 200;
  if (v.kind === "secret") return v.declined === true || (isString(v.value) && v.value.length <= 10_000);
  if (v.kind !== "form" || !isRecord(v.values)) return false;
  const entries = Object.entries(v.values);
  return (
    entries.length <= 20 &&
    entries.every(([k, x]) => k.length <= 40 && (isBoolean(x) || (isString(x) && x.length <= 10_000)))
  );
}

function isDecision(v: unknown): v is ApprovalDecision {
  if (!isRecord(v)) return false;
  return v.allow === true || (v.allow === false && isString(v.reason));
}

/** Argument checks per call. Arity is exact, so extra arguments are refused too. */
const ARGS: { [K in CallName]: (a: unknown[]) => a is Calls[K]["args"] } = {
  listBots: (a): a is [] => a.length === 0,
  createBot: (a): a is [NewBot] => a.length === 1 && isNewBot(a[0]),
  updateBot: (a): a is [string, BotPatch] => a.length === 2 && isId(a[0]) && isPatch(a[1]),
  deleteBot: (a): a is [string] => a.length === 1 && isId(a[0]),
  transcript: (a): a is [string, number] => a.length === 2 && isId(a[0]) && isCursor(a[1]),
  sendMessage: (a): a is [string, string, string?, string?, CardKind[]?] =>
    a.length >= 2 &&
    a.length <= 5 &&
    isId(a[0]) &&
    isString(a[1]) &&
    a[1].trim() !== "" &&
    optional(isNonce)(a[2]) &&
    optional(isId)(a[3]) &&
    optional(isCardKinds)(a[4]),
  // The gateway checks the answer against its card; here only its shape and size.
  answerCard: (a): a is [string, string, CardAnswerIn] =>
    a.length === 3 && isId(a[0]) && isId(a[1]) && isCardAnswer(a[2]),
  interrupt: (a): a is [string] => a.length === 1 && isId(a[0]),
  startFresh: (a): a is [string] => a.length === 1 && isId(a[0]),
  rollBack: (a): a is [string, string] => a.length === 2 && isId(a[0]) && isId(a[1]),
  resumeRun: (a): a is [string, string, CardKind[]?] =>
    (a.length === 2 || a.length === 3) && isId(a[0]) && isId(a[1]) && optional(isCardKinds)(a[2]),
  react: (a): a is [string, string, string, boolean] =>
    a.length === 4 && isId(a[0]) && isId(a[1]) && isString(a[2]) && a[2].length <= 16 && isBoolean(a[3]),
  rate: (a): a is [string, string, Feedback | null] =>
    a.length === 3 && isId(a[0]) && isId(a[1]) && (a[2] === "up" || a[2] === "down" || a[2] === null),
  answerApproval: (a): a is [string, string, ApprovalDecision] =>
    a.length === 3 && isId(a[0]) && isId(a[1]) && isDecision(a[2]),
  answerChoice: (a): a is [string, string, string] =>
    a.length === 3 && isId(a[0]) && isId(a[1]) && isString(a[2]) && a[2].length <= 1000,
  listProviders: (a): a is [] => a.length === 0,
  search: (a): a is [string] => a.length === 1 && isString(a[0]) && a[0].length <= 200,
  usage: (a): a is [number] => a.length === 1 && (a[0] === 7 || a[0] === 30 || a[0] === 90),
  listModels: (a): a is [ProviderId] => a.length === 1 && isProviderId(a[0]),
  testProvider: (a): a is [ProviderId, string?] =>
    (a.length === 1 || a.length === 2) && isProviderId(a[0]) && optional(isString)(a[1]),
  setKey: (a): a is [ProviderId, string] => a.length === 2 && isProviderId(a[0]) && isString(a[1]) && a[1] !== "",
  deleteKey: (a): a is [ProviderId] => a.length === 1 && isProviderId(a[0]),
};

const isCallName = (v: unknown): v is CallName => isString(v) && Object.hasOwn(ARGS, v);

/** Checks a call from the renderer. Returns the call, or why it was refused. */
export function checkCall(name: unknown, args: unknown): Call | string {
  if (!isCallName(name)) return `Unknown call: ${String(name).slice(0, 50)}`;
  if (!Array.isArray(args) || !ARGS[name](args)) return `Bad arguments for ${name}`;
  return { name, args } as Call;
}

export function checkStreamOpen(v: unknown): StreamOpen | undefined {
  if (!isRecord(v) || !isId(v.id)) return undefined;
  if (v.topic === "activity") return { id: v.id, topic: "activity" };
  if (v.topic !== "transcript" || !isId(v.botId) || !isCursor(v.since)) return undefined;
  return { id: v.id, topic: "transcript", botId: v.botId, since: v.since };
}
