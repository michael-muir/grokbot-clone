// Desktop app entry point: starts or attaches to the gateway, opens the window, wires IPC, and runs the
// `--smoke` check used by CI.
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions, shell } from "electron";
import type { GatewayClient } from "../../../server/src/client/gateway-client.ts";
import type { ConnectionInfo } from "../shared/ipc.ts";
import { type GatewayHandle, startGateway } from "./gateway-process.ts";
import { registerIpc } from "./ipc-main.ts";
import { platformFor } from "./platform/index.ts";

const SMOKE = process.argv.includes("--smoke");
const SMOKE_TIMEOUT_MS = 30_000;
const platform = platformFor();
const rendererUrl = process.env.ELECTRON_RENDERER_URL;
const rendererFile = fileURLToPath(new URL("../renderer/index.html", import.meta.url));
const preloadFile = fileURLToPath(new URL("../preload/index.cjs", import.meta.url));

let handle: GatewayHandle | undefined;
let connection: ConnectionInfo | undefined;
let stoppingGateway = false;

// The repo layout in development: app/ next to server/.
const serverDir = join(app.getAppPath(), "..", "server");
const gateway: Promise<GatewayClient> = startGateway({ serverDir }).then(
  (h) => {
    handle = h;
    connection = { ok: true, url: h.client.baseUrl, spawned: h.spawned };
    void h.exited.then(() => {
      if (stoppingGateway) return;
      connection = { ok: false, error: "The gateway stopped. Restart the app to reconnect." };
      console.error(connection.error);
    });
    return h.client;
  },
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    connection = { ok: false, error: message };
    console.error(`Couldn't connect to the gateway: ${message}`);
    throw err;
  },
);
// Callers see the failure through `connection`; this only stops an unhandled-rejection crash.
gateway.catch(() => {});

/** Stops a gateway this app started, including one still starting up. */
async function stopGateway(): Promise<void> {
  stoppingGateway = true;
  await gateway.catch(() => {});
  if (handle?.spawned) await handle.stop();
}

function isOwnPage(url: string): boolean {
  if (rendererUrl) return url.startsWith(rendererUrl);
  return url === pathToFileURL(rendererFile).href || url.startsWith(`${pathToFileURL(rendererFile).href}#`);
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: "GrokBot Clone",
    webPreferences: { preload: preloadFile, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.once("ready-to-show", () => {
    if (!SMOKE) win.show();
  });
  // The window only ever shows the app. Links open in the user's browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!isOwnPage(url)) event.preventDefault();
  });
  if (rendererUrl) void win.loadURL(rendererUrl);
  else void win.loadFile(rendererFile);
  return win;
}

function buildMenu(): Menu {
  // Roles carry each OS's own shortcuts (CmdOrCtrl+C, Cmd+Q on macOS, and so on).
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : [{ role: "fileMenu" as const }]),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}

let smokeTimer: ReturnType<typeof setTimeout> | undefined;

/** Ends a smoke run. app.exit skips will-quit, so the gateway is stopped here first. */
async function exitSmoke(code: number, line: string) {
  clearTimeout(smokeTimer);
  (code === 0 ? console.log : console.error)(line);
  await stopGateway();
  app.exit(code);
}

registerIpc({
  gateway,
  connection: async () => {
    await gateway.catch(() => {});
    return connection ?? { ok: false, error: "Still starting" };
  },
  isOwnPage,
  onReady: (botCount) => {
    if (SMOKE) void exitSmoke(0, `smoke: ok ${botCount} bots`);
  },
});

app.whenReady().then(
  () => {
    Menu.setApplicationMenu(buildMenu());
    createWindow();
    if (SMOKE) {
      const failed = (fallback: string) =>
        void exitSmoke(1, `smoke: failed: ${connection?.ok === false ? connection.error : fallback}`);
      smokeTimer = setTimeout(() => failed("no ready signal in 30 s"), SMOKE_TIMEOUT_MS);
      gateway.catch(() => failed("the gateway didn't start"));
    }
    app.on("activate", () => {
      if (platform.reopenOnActivate && BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  },
  (err: unknown) => {
    console.error("The app couldn't start", err);
    app.exit(1);
  },
);

app.on("window-all-closed", () => {
  if (platform.quitWhenAllWindowsClosed) app.quit();
});

// Stop the gateway we started before quitting, once.
app.on("will-quit", (event) => {
  if (stoppingGateway) return;
  event.preventDefault();
  void stopGateway().finally(() => app.quit());
});
