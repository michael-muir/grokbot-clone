// The contract between the renderer and the main process: call names with their argument and result types,
// stream events, and the checks main runs on everything the renderer sends.
import type { BotPatch, ProviderTest } from "../../../server/src/client/gateway-client.ts";
import type { StreamState } from "../../../server/src/client/subscribe.ts";
import {
  type ApprovalDecision,
  isProviderId,
  type ProviderId,
  type ProviderSummary,
  type PublicBot,
  type TranscriptEntry,
} from "../../../server/src/types.ts";

export const CHANNELS = {
  call: "gateway:call",
  connection: "gateway:connection",
  streamOpen: "stream:open",
  streamClose: "stream:close",
  streamEvent: "stream:event",
  ready: "app:ready",
} as const;

/** Every gateway call the renderer may make, by name. */
export interface Calls {
  listBots: { args: []; result: PublicBot[] };
  updateBot: { args: [botId: string, patch: BotPatch]; result: PublicBot };
  transcript: { args: [botId: string, since: number]; result: TranscriptEntry[] };
  sendMessage: { args: [botId: string, text: string]; result: undefined };
  interrupt: { args: [botId: string]; result: undefined };
  answerApproval: { args: [botId: string, entryId: string, decision: ApprovalDecision]; result: undefined };
  listProviders: { args: []; result: ProviderSummary[] };
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
  | { kind: "state"; state: StreamState }
  /** The connection dropped and will be retried. */
  | { kind: "error"; message: string }
  /** The stream stopped for good (closed, or refused by the gateway). */
  | { kind: "ended"; error?: string };

export interface StreamOpen {
  id: string;
  botId: string;
  since: number;
}

export type ConnectionInfo = { ok: true; url: string; spawned: boolean } | { ok: false; error: string };

/** What the preload puts on `window.desktop`. */
export interface DesktopApi {
  call<K extends CallName>(name: K, ...args: Calls[K]["args"]): Promise<CallResult<Calls[K]["result"]>>;
  connection(): Promise<ConnectionInfo>;
  /** Streams a bot's transcript from after `since`. Returns a function that stops it. */
  subscribe(botId: string, since: number, onEvent: (event: StreamEvent) => void): () => void;
  /** The renderer is up and listed the bots; the smoke test waits for this. */
  ready(botCount: number): void;
}

const isString = (v: unknown): v is string => typeof v === "string";
const isId = (v: unknown): v is string => isString(v) && v.length > 0 && v.length <= 200;
const isCursor = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= -1;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optional =
  <T>(check: (v: unknown) => v is T) =>
  (v: unknown): v is T | undefined =>
    v === undefined || check(v);

function isPatch(v: unknown): v is BotPatch {
  if (!isRecord(v)) return false;
  const known = new Set(["name", "provider", "model", "baseUrl"]);
  return (
    Object.keys(v).every((k) => known.has(k)) &&
    optional(isString)(v.name) &&
    optional(isProviderId)(v.provider) &&
    optional(isString)(v.model) &&
    optional(isString)(v.baseUrl)
  );
}

function isDecision(v: unknown): v is ApprovalDecision {
  if (!isRecord(v)) return false;
  return v.allow === true || (v.allow === false && isString(v.reason));
}

/** Argument checks per call. Arity is exact, so extra arguments are refused too. */
const ARGS: { [K in CallName]: (a: unknown[]) => a is Calls[K]["args"] } = {
  listBots: (a): a is [] => a.length === 0,
  updateBot: (a): a is [string, BotPatch] => a.length === 2 && isId(a[0]) && isPatch(a[1]),
  transcript: (a): a is [string, number] => a.length === 2 && isId(a[0]) && isCursor(a[1]),
  sendMessage: (a): a is [string, string] => a.length === 2 && isId(a[0]) && isString(a[1]) && a[1].trim() !== "",
  interrupt: (a): a is [string] => a.length === 1 && isId(a[0]),
  answerApproval: (a): a is [string, string, ApprovalDecision] =>
    a.length === 3 && isId(a[0]) && isId(a[1]) && isDecision(a[2]),
  listProviders: (a): a is [] => a.length === 0,
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
  if (!isRecord(v) || !isId(v.id) || !isId(v.botId) || !isCursor(v.since)) return undefined;
  return { id: v.id, botId: v.botId, since: v.since };
}
