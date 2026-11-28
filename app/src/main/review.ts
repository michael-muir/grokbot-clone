// Captures the core screens at the reference size and writes a side-by-side report. Not the app's entry point.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, Menu, nativeTheme } from "electron";
import type { BotPatch } from "../../../server/src/client/gateway-client.ts";
import { CHANNELS, checkCall, checkStreamOpen } from "../shared/ipc.ts";
import { type AppSettings, checkSettingsPatch, DEFAULT_SETTINGS } from "../shared/settings.ts";
import { ownPageCheck } from "./own-page.ts";
import {
  CAPTURE_HEIGHT,
  CAPTURE_WIDTH,
  REVIEW_ACTIVITY,
  REVIEW_BOTS,
  REVIEW_MODELS,
  REVIEW_PROVIDERS,
  REVIEW_TEST,
  type ReviewScene,
  type ReviewStep,
  SCENES,
} from "./review-fixtures.ts";

const here = dirname(fileURLToPath(import.meta.url));
const rendererFile = join(here, "../renderer/index.html");
const preloadFile = join(here, "../preload/index.cjs");
const repoRoot = join(here, "../../..");
const outDir = join(repoRoot, "review", "out");
const captureDir = join(outDir, "captures");

// A retina display would capture at 2× and no longer match the 1040×760 reference shots.
app.commandLine.appendSwitch("force-device-scale-factor", "1");

const isOwnPage = ownPageCheck(undefined, rendererFile);
let scene: ReviewScene = SCENES[0];
let settings: AppSettings = freshSettings();

function freshSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, theme: "dark", onboarded: scene.onboarded };
}

function answer(name: string, args: readonly unknown[]): unknown {
  if (name === "listBots") return REVIEW_BOTS;
  if (name === "listProviders") return REVIEW_PROVIDERS;
  if (name === "listModels") return REVIEW_MODELS;
  if (name === "testProvider") return REVIEW_TEST;
  if (name === "transcript") return scene.entries;
  if (name === "updateBot") {
    const [botId, patch] = args as [string, BotPatch];
    const bot = REVIEW_BOTS.find((b) => b.id === botId);
    if (!bot) throw new Error(`No bot ${botId}`);
    return { ...bot, ...patch };
  }
  if (name === "sendMessage") return "review-entry";
  if (name === "rollBack") return "";
  if (name === "react") return [];
  if (name === "createBot") {
    const [input] = args as [{ name: string; avatar?: { shape: string; color: string } }];
    return { id: "review-new", provider: "fake", avatar: { shape: "circle", color: "green" }, ...input };
  }
  return undefined;
}

function registerFixtures(): void {
  const trusted = (url: string | undefined) => url !== undefined && isOwnPage(url);

  ipcMain.handle(CHANNELS.connection, (event) => {
    if (!trusted(event.senderFrame?.url)) throw new Error("Refused: not the app's page");
    return { ok: true, url: "review://local", spawned: false };
  });

  ipcMain.handle(CHANNELS.call, (event, name: unknown, args: unknown) => {
    if (!trusted(event.senderFrame?.url)) {
      return { ok: false, error: { message: "Refused: not the app's page", status: 403 } };
    }
    const call = checkCall(name, args);
    if (typeof call === "string") return { ok: false, error: { message: call, status: 400 } };
    try {
      return { ok: true, value: answer(call.name, call.args) };
    } catch (err) {
      return { ok: false, error: { message: err instanceof Error ? err.message : String(err), status: 0 } };
    }
  });

  ipcMain.handle(CHANNELS.settingsGet, (event) => {
    if (!trusted(event.senderFrame?.url)) throw new Error("Refused: not the app's page");
    return settings;
  });

  ipcMain.handle(CHANNELS.settingsSet, (event, raw: unknown) => {
    if (!trusted(event.senderFrame?.url)) throw new Error("Refused: not the app's page");
    const patch = checkSettingsPatch(raw);
    if (!patch) throw new Error("Not a valid settings change");
    settings = { ...settings, ...patch };
    return settings;
  });

  ipcMain.on(CHANNELS.streamOpen, (event, raw: unknown) => {
    if (!trusted(event.senderFrame?.url)) return;
    const open = checkStreamOpen(raw);
    if (!open) return;
    const send = (payload: unknown) => event.sender.send(CHANNELS.streamEvent, open.id, payload);
    if (open.topic === "activity") send({ kind: "activity", bots: REVIEW_ACTIVITY });
    else for (const entry of scene.entries) send({ kind: "entry", entry });
    send({ kind: "state", state: "live" });
  });

  ipcMain.on(CHANNELS.ready, () => {});
}

const STILL = "*, *::before, *::after { animation: none !important; transition: none !important; }";

async function evalIn(win: BrowserWindow, source: string): Promise<unknown> {
  return win.webContents.executeJavaScript(source, true);
}

async function until(win: BrowserWindow, source: string, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const ok = await evalIn(win, source);
    if (ok === true) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const present = (selector: string) =>
  `document.querySelector(${JSON.stringify(selector)}) !== null && document.fonts.status === "loaded"`;

/** Clicks the enabled button whose label is exactly `text`. A renamed button fails the scene. */
function clickScript(text: string): string {
  const label = JSON.stringify(text);
  return `(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${label} && !b.disabled);
    if (!btn) return false;
    btn.click();
    return true;
  })()`;
}

function pressScript(selector: string): string {
  const target = JSON.stringify(selector);
  return `(() => {
    const el = document.querySelector(${target});
    if (!el) return false;
    el.click();
    return true;
  })()`;
}

function menuScript(selector: string): string {
  const target = JSON.stringify(selector);
  return `(() => {
    const el = document.querySelector(${target});
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    return true;
  })()`;
}

async function runStep(win: BrowserWindow, step: ReviewStep): Promise<void> {
  if (step.kind === "settings") {
    win.webContents.send(CHANNELS.settingsOpen);
    return;
  }
  if (step.kind === "wait") {
    await until(win, present(step.selector), step.selector);
    return;
  }
  const attempt =
    step.kind === "click"
      ? clickScript(step.text)
      : step.kind === "press"
        ? pressScript(step.selector)
        : menuScript(step.selector);
  const label = step.kind === "click" ? step.text : step.selector;
  await until(win, attempt, label);
}

async function captureScene(
  win: BrowserWindow,
  current: ReviewScene,
): Promise<{ file: string; width: number; height: number }> {
  scene = current;
  settings = freshSettings();
  await win.loadFile(rendererFile);
  await win.webContents.insertCSS(STILL);
  await until(win, present(current.start), current.start);
  for (const step of current.steps) await runStep(win, step);
  await until(win, present(current.until), current.until);
  await evalIn(win, "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT });
  const size = image.getSize();
  const file = join(captureDir, `${current.id}.png`);
  writeFileSync(file, image.toPNG());
  return { file: `${current.id}.png`, width: size.width, height: size.height };
}

interface Shot {
  scene: ReviewScene;
  image: string | null;
  width: number;
  height: number;
  error: string | null;
}

function esc(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
}

function report(shots: readonly Shot[]): string {
  const cards = shots
    .map((shot) => {
      const ref = shot.scene.reference
        ? `<figure><figcaption>Reference</figcaption><img src="../../reference/screens/${esc(shot.scene.reference)}" alt=""></figure>`
        : `<figure><figcaption>Reference</figcaption><p class="missing">No reference shot.</p></figure>`;
      const appShot = shot.image
        ? `<figure><figcaption>This app${shot.width === CAPTURE_WIDTH && shot.height === CAPTURE_HEIGHT ? "" : ` (${shot.width}×${shot.height})`}</figcaption><img src="captures/${esc(shot.image)}" alt=""></figure>`
        : `<figure><figcaption>This app</figcaption><p class="missing">${esc(shot.error ?? "Not captured")}</p></figure>`;
      const overlay =
        shot.image && shot.scene.reference
          ? `<div class="overlay"><img src="captures/${esc(shot.image)}" alt=""><img src="../../reference/screens/${esc(shot.scene.reference)}" alt=""></div>`
          : "";
      return `<article id="${esc(shot.scene.id)}"><h2>${esc(shot.scene.title)}</h2><p>${esc(shot.scene.note)}</p><div class="pair">${ref}${appShot}</div>${overlay}</article>`;
    })
    .join("\n");
  const list = shots
    .map((shot) => {
      const state = shot.error ? "failed" : "captured";
      const ref = shot.scene.reference ?? "no reference shot";
      return `<li><a href="#${esc(shot.scene.id)}">${esc(shot.scene.title)}</a> <span class="${state}">${state}</span> <span class="ref">${esc(ref)}</span></li>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Visual review</title>
<style>
  body { margin: 0; font: 15px/1.4 system-ui, sans-serif; background: #111; color: #f5f5f5; }
  header, article { padding: 24px; max-width: 2200px; }
  a { color: #9ec1ff; } ol { padding-left: 20px; } li { margin: 4px 0; }
  .failed { color: #ff8d8d; } .captured { color: #9ddeaf; } .ref { color: #aaa; }
  .pair { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
  figure { margin: 0; } figcaption { margin-bottom: 6px; color: #aaa; }
  img { width: 520px; height: auto; background: #000; }
  .missing { width: 520px; min-height: 80px; margin: 0; padding: 12px; background: #2a2a2a; }
  .overlay { position: relative; width: 520px; margin-top: 12px; }
  .overlay img { position: absolute; inset: 0; width: 100%; }
  .overlay img:last-child { opacity: 0.45; }
  .overlay { height: 380px; }
</style></head><body>
<header><h1>Visual review</h1><p>Core screens at ${CAPTURE_WIDTH}×${CAPTURE_HEIGHT}, beside the reference. The overlay lays the reference on the capture.</p><ol>${list}</ol></header>
${cards}
</body></html>`;
}

async function main(): Promise<number> {
  nativeTheme.themeSource = "dark";
  Menu.setApplicationMenu(null);
  registerFixtures();
  const win = new BrowserWindow({
    width: CAPTURE_WIDTH,
    height: CAPTURE_HEIGHT,
    useContentSize: true,
    show: false,
    backgroundColor: "#121212",
    autoHideMenuBar: true,
    webPreferences: { preload: preloadFile, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.once("ready-to-show", () => win.showInactive());

  mkdirSync(captureDir, { recursive: true });
  const shots: Shot[] = [];
  for (const current of SCENES) {
    try {
      const captured = await captureScene(win, current);
      const sizeOk = captured.width === CAPTURE_WIDTH && captured.height === CAPTURE_HEIGHT;
      shots.push({
        scene: current,
        image: captured.file,
        width: captured.width,
        height: captured.height,
        error: sizeOk
          ? null
          : `Captured ${captured.width}×${captured.height}, expected ${CAPTURE_WIDTH}×${CAPTURE_HEIGHT}`,
      });
      console.log(`review: ${current.id} ${captured.width}×${captured.height}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      shots.push({ scene: current, image: null, width: 0, height: 0, error: message });
      console.error(`review: ${current.id} failed: ${message}`);
    }
  }
  writeFileSync(join(outDir, "index.html"), report(shots));
  console.log(`review: wrote ${join(outDir, "index.html")}`);
  const failed = shots.filter((shot) => shot.error).length;
  return failed === 0 ? 0 : 1;
}

app.whenReady().then(
  () =>
    main().then(
      (code) => app.exit(code),
      (err: unknown) => {
        console.error(err);
        app.exit(1);
      },
    ),
  (err: unknown) => {
    console.error(err);
    app.exit(1);
  },
);
