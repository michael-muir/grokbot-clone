// Main-process side of the IPC contract: checks every message from the renderer, runs gateway calls, and relays
// transcript streams to the window that opened them.
import { type IpcMainEvent, type IpcMainInvokeEvent, ipcMain, type WebContents } from "electron";
import { type GatewayClient, GatewayError } from "../../../server/src/client/gateway-client.ts";
import type { StreamState } from "../../../server/src/client/subscribe.ts";
import {
  type CallName,
  type CallResult,
  type Calls,
  CHANNELS,
  type ConnectionInfo,
  checkCall,
  checkStreamOpen,
  type StreamEvent,
} from "../shared/ipc.ts";
import { type AppSettings, checkSettingsPatch } from "../shared/settings.ts";

type Handlers = { [K in CallName]: (client: GatewayClient, args: Calls[K]["args"]) => Promise<Calls[K]["result"]> };

/** A call with no result sends `undefined` back over IPC. */
const done = (p: Promise<void>): Promise<undefined> => p.then(() => undefined);

const HANDLERS: Handlers = {
  listBots: (c) => c.listBots(),
  updateBot: (c, [botId, patch]) => c.updateBot(botId, patch),
  transcript: (c, [botId, since]) => c.transcript(botId, since),
  sendMessage: (c, [botId, text, clientNonce]) => c.sendMessage(botId, text, clientNonce),
  interrupt: (c, [botId]) => done(c.interrupt(botId)),
  answerApproval: (c, [botId, entryId, decision]) => done(c.answerApproval(botId, entryId, decision)),
  answerChoice: (c, [botId, entryId, answer]) => done(c.answerChoice(botId, entryId, answer)),
  listProviders: (c) => c.listProviders(),
  listModels: (c, [provider]) => c.listModels(provider),
  testProvider: (c, [provider, baseUrl]) => c.testProvider(provider, baseUrl),
  setKey: (c, [provider, key]) => done(c.setKey(provider, key)),
  deleteKey: (c, [provider]) => done(c.deleteKey(provider)),
};

// Generic over the name, so TypeScript ties each handler to its own argument types (checkCall paired them).
function dispatch<K extends CallName>(client: GatewayClient, call: { name: K; args: Calls[K]["args"] }) {
  const handler: (client: GatewayClient, args: Calls[K]["args"]) => Promise<Calls[K]["result"]> = HANDLERS[call.name];
  return handler(client, call.args);
}

export interface IpcDeps {
  /** Resolves once the gateway is up; rejects if it couldn't be started. */
  gateway: Promise<GatewayClient>;
  connection(): Promise<ConnectionInfo>;
  /** Only frames showing the app's own page may use the API. */
  isOwnPage(url: string): boolean;
  onReady(botCount: number): void;
  settings: {
    get(): AppSettings;
    /** Saves an already-checked change, applies it, tells every window; returns the full settings. */
    set(patch: Partial<AppSettings>): AppSettings;
  };
}

export function registerIpc(deps: IpcDeps): void {
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) => {
    const url = event.senderFrame?.url;
    return url !== undefined && deps.isOwnPage(url);
  };

  ipcMain.handle(CHANNELS.connection, (event) => {
    if (!trusted(event)) throw new Error("Refused: not the app's page");
    return deps.connection();
  });

  ipcMain.handle(CHANNELS.call, async (event, name: unknown, args: unknown): Promise<CallResult<unknown>> => {
    if (!trusted(event)) return { ok: false, error: { message: "Refused: not the app's page", status: 403 } };
    const call = checkCall(name, args);
    if (typeof call === "string") return { ok: false, error: { message: call, status: 400 } };
    try {
      return { ok: true, value: await dispatch(await deps.gateway, call) };
    } catch (err) {
      const status = err instanceof GatewayError ? err.status : 0;
      return { ok: false, error: { message: err instanceof Error ? err.message : String(err), status } };
    }
  });

  const streams = new Map<string, AbortController>();
  const watched = new Set<number>();
  const key = (sender: WebContents, id: string) => `${sender.id}:${id}`;

  ipcMain.on(CHANNELS.streamOpen, (event, raw: unknown) => {
    if (!trusted(event)) return;
    const open = checkStreamOpen(raw);
    if (!open) return;
    const sender = event.sender;
    const k = key(sender, open.id);
    streams.get(k)?.abort();
    const controller = new AbortController();
    streams.set(k, controller);

    // A reloaded or closed window can't close its streams itself.
    if (!watched.has(sender.id)) {
      watched.add(sender.id);
      const id = sender.id;
      const closeAll = () => {
        for (const [k2, c] of streams) if (k2.startsWith(`${id}:`)) c.abort();
      };
      sender.on("destroyed", () => {
        closeAll();
        watched.delete(id);
      });
      // A reload or new page drops the renderer's listeners. A hash or history change (isInPlace) keeps them.
      sender.on("did-start-navigation", (_e, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) closeAll();
      });
    }

    const send = (e: StreamEvent) => {
      if (!sender.isDestroyed() && !controller.signal.aborted) sender.send(CHANNELS.streamEvent, open.id, e);
    };
    const common = {
      signal: controller.signal,
      onState: (state: StreamState) => send({ kind: "state", state }),
      onError: (err: unknown) => {
        // The renderer shows transcript drops; nobody would see activity drops, so they're logged here.
        if (open.topic === "activity") console.warn("activity stream dropped; reconnecting", err);
        send({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      },
    };
    const what = open.topic === "activity" ? "activity stream" : `transcript stream for ${open.botId}`;
    deps.gateway
      .then((client) =>
        open.topic === "activity"
          ? client.activity({ ...common, onActivity: (bots) => send({ kind: "activity", bots }) })
          : client.subscribe(open.botId, {
              ...common,
              since: open.since,
              onEntry: (entry) => send({ kind: "entry", entry }),
            }),
      )
      .then(
        () => send({ kind: "ended" }),
        (err: unknown) => {
          console.error(`${what} stopped`, err);
          send({ kind: "ended", error: err instanceof Error ? err.message : String(err) });
        },
      )
      .finally(() => {
        if (streams.get(k) === controller) streams.delete(k);
      });
  });

  ipcMain.on(CHANNELS.streamClose, (event, id: unknown) => {
    if (!trusted(event) || typeof id !== "string") return;
    const k = key(event.sender, id);
    streams.get(k)?.abort();
    streams.delete(k);
  });

  ipcMain.on(CHANNELS.ready, (event, botCount: unknown) => {
    if (trusted(event) && Number.isInteger(botCount)) deps.onReady(botCount as number);
  });

  ipcMain.handle(CHANNELS.settingsGet, (event) => {
    if (!trusted(event)) throw new Error("Refused: not the app's page");
    return deps.settings.get();
  });

  ipcMain.handle(CHANNELS.settingsSet, (event, raw: unknown) => {
    if (!trusted(event)) throw new Error("Refused: not the app's page");
    const patch = checkSettingsPatch(raw);
    if (!patch) throw new Error("Not a valid settings change");
    return deps.settings.set(patch);
  });
}
