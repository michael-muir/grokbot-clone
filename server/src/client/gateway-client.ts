// Typed client for the gateway's HTTP API, with token auth. No Node APIs, so any JavaScript runtime can use it;
// the desktop app runs it in its main process, which keeps the token out of the renderer.
import type { ApprovalDecision, ProviderId, ProviderSummary, PublicBot, TranscriptEntry } from "../types.ts";
import { type ActivityOptions, type SubscribeOptions, subscribeActivity, subscribeTranscript } from "./subscribe.ts";

export interface GatewayClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
}

export type BotPatch = Partial<Pick<PublicBot, "name" | "provider" | "model" | "baseUrl">>;

export type ProviderTest = { ok: true; models: string[] } | { ok: false; error: string };

/** The gateway answered with an error status. `message` is the gateway's own explanation. */
export class GatewayError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class GatewayClient {
  readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchFn: typeof fetch;

  constructor(opts: GatewayClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? fetch;
  }

  /** True when the gateway answers and accepts the token; false when it isn't (yet) answering properly. */
  async health(signal?: AbortSignal): Promise<boolean> {
    try {
      await this.request("GET", "/health", undefined, signal);
      return true;
    } catch (err) {
      // A refused token won't fix itself by waiting: say so instead of reporting "not up yet".
      if (err instanceof GatewayError && (err.status === 401 || err.status === 403)) throw err;
      return false;
    }
  }

  listBots(): Promise<PublicBot[]> {
    return this.request("GET", "/bots");
  }

  updateBot(botId: string, patch: BotPatch): Promise<PublicBot> {
    return this.request("PATCH", `/bots/${enc(botId)}`, patch);
  }

  transcript(botId: string, since = -1): Promise<TranscriptEntry[]> {
    return this.request("GET", `/bots/${enc(botId)}/transcript?since=${since}`);
  }

  /**
   * Sends a message and returns the id of the user entry it became. `clientNonce` comes back on that entry, so a
   * pending local copy can be matched to it (the id covers gateways that don't echo nonces).
   */
  async sendMessage(botId: string, text: string, clientNonce?: string): Promise<string> {
    const res = await this.request<{ entryId?: unknown }>(
      "POST",
      `/bots/${enc(botId)}/messages`,
      clientNonce ? { text, clientNonce } : { text },
    );
    return typeof res?.entryId === "string" ? res.entryId : "";
  }

  async interrupt(botId: string): Promise<void> {
    await this.request("POST", `/bots/${enc(botId)}/interrupt`, {});
  }

  async answerApproval(botId: string, entryId: string, decision: ApprovalDecision): Promise<void> {
    await this.request("POST", `/bots/${enc(botId)}/approvals/${enc(entryId)}`, decision);
  }

  async answerChoice(botId: string, entryId: string, answer: string): Promise<void> {
    await this.request("POST", `/bots/${enc(botId)}/choices/${enc(entryId)}`, { answer });
  }

  listProviders(): Promise<ProviderSummary[]> {
    return this.request("GET", "/providers");
  }

  async listModels(provider: ProviderId): Promise<string[]> {
    const { models } = await this.request<{ models: string[] }>("GET", `/providers/${enc(provider)}/models`);
    return models;
  }

  testProvider(provider: ProviderId, baseUrl?: string): Promise<ProviderTest> {
    return this.request("POST", `/providers/${enc(provider)}/test`, baseUrl ? { baseUrl } : {});
  }

  async setKey(provider: ProviderId, key: string): Promise<void> {
    await this.request("PUT", `/providers/${enc(provider)}/key`, { key });
  }

  async deleteKey(provider: ProviderId): Promise<void> {
    await this.request("DELETE", `/providers/${enc(provider)}/key`);
  }

  /** Streams a bot's transcript until the signal aborts. See subscribeTranscript. */
  subscribe(botId: string, opts: Omit<SubscribeOptions, "token" | "fetch">): Promise<void> {
    return subscribeTranscript(this.baseUrl, botId, { ...opts, token: this.token, fetch: this.fetchFn });
  }

  /** Streams every bot's activity (running or not) until the signal aborts. See subscribeActivity. */
  activity(opts: Omit<ActivityOptions, "token" | "fetch">): Promise<void> {
    return subscribeActivity(this.baseUrl, { ...opts, token: this.token, fetch: this.fetchFn });
  }

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await res.text();
    if (!res.ok) throw new GatewayError(res.status, errorMessage(res.status, text));
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

const enc = encodeURIComponent;

function errorMessage(status: number, text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") {
      return parsed.error;
    }
  } catch {
    // Not JSON (a proxy's error page, say): fall through to the status.
  }
  return `The gateway answered ${status}`;
}
