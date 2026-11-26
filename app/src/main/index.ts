// Desktop app entry point: starts or attaches to the gateway, opens the window, wires IPC, and runs the
// `--smoke` check used by CI.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions, nativeTheme, session, shell } from "electron";
import type { GatewayClient } from "../../../server/src/client/gateway-client.ts";
import { CHANNELS, type ConnectionInfo } from "../shared/ipc.ts";
import { type GatewayHandle, startGateway } from "./gateway-process.ts";
import { registerIpc } from "./ipc-main.ts";
import { ownPageCheck } from "./own-page.ts";
import { platformFor } from "./platform/index.ts";
import { SettingsStore } from "./settings.ts";

const SMOKE = process.argv.includes("--smoke");
const SMOKE_TIMEOUT_MS = 30_000;
const platform = platformFor();
const rendererUrl = process.env.ELECTRON_RENDERER_URL;
const rendererFile = fileURLToPath(new URL("../renderer/index.html", import.meta.url));
const preloadFile = fileURLToPath(new URL("../preload/index.cjs", import.meta.url));

// Read before the app is ready: hardware acceleration can only be turned off this early.
const settings = new SettingsStore(join(app.getPath("userData"), "settings.json"));
if (!settings.get().hardwareAcceleration) app.disableHardwareAcceleration();

/** Applies the settings that take effect at once (the theme flows into prefers-color-scheme). */
function applySettings(): void {
  const s = settings.get();
  nativeTheme.themeSource = s.theme;
  session.defaultSession.setSpellCheckerEnabled(s.spellcheck);
}

let handle: GatewayHandle | undefined;
let connection: ConnectionInfo | undefined;
let stoppingGateway = false;
const startup = new AbortController();

// The repo layout in development: app/ next to server/.
const serverDir = join(app.getAppPath(), "..", "server");
const gateway: Promise<GatewayClient> = startGateway({ serverDir, signal: startup.signal }).then(
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
    if (!stoppingGateway) console.error(`Couldn't connect to the gateway: ${message}`);
    throw err;
  },
);
// Callers see the failure through `connection`; this only stops an unhandled-rejection crash.
gateway.catch(() => {});

/** Stops a gateway this app started. One still starting up is abandoned at once (and stopped by the launcher). */
async function stopGateway(): Promise<void> {
  stoppingGateway = true;
  startup.abort();
  await gateway.catch(() => {});
  if (handle?.spawned) await handle.stop();
}

const isOwnPage = ownPageCheck(rendererUrl, rendererFile);

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
  const openSettings: MenuItemConstructorOptions = {
    label: "Settings…",
    accelerator: "CmdOrCtrl+,",
    click: () => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      win?.webContents.send(CHANNELS.settingsOpen);
    },
  };
  // Roles carry each OS's own shortcuts (CmdOrCtrl+C, Cmd+Q on macOS, and so on).
  const first: MenuItemConstructorOptions =
    process.platform === "darwin"
      ? {
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            openSettings,
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        }
      : { label: "File", submenu: [openSettings, { type: "separator" }, { role: "quit" }] };
  const template: MenuItemConstructorOptions[] = [
    first,
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}

let smokeTimer: ReturnType<typeof setTimeout> | undefined;
let smokeDone = false;

/** Ends a smoke run, once. app.exit skips will-quit, so the gateway is stopped here first. */
async function exitSmoke(code: number, line: string) {
  if (smokeDone) return;
  smokeDone = true;
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
  settings: {
    get: () => settings.get(),
    set: (patch) => {
      const next = settings.set(patch);
      applySettings();
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send(CHANNELS.settingsChanged, next);
      return next;
    },
  },
});

app.whenReady().then(
  () => {
    applySettings();
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
