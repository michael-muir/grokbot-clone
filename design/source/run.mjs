// Render screens.html in headless Chrome, export each screen to SVG + a PNG preview.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out"); mkdirSync(out, { recursive: true });
const PORT = 9444;
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(here, "chrome-profile")}`,
  "--window-size=1100,900", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let targets; for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (targets.find(t => t.type === "page")) break; } catch {} await sleep(200); }
const page = targets.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(r => (ws.onopen = r));
let id = 0; const pend = new Map();
ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 800)); return r.result.value; };
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: pathToFileURL(join(here, "screens.html")).href });
await sleep(1500);
await ev("document.fonts.ready.then(()=>document.fonts.size)");
await ev(readFileSync(join(here, "dom2svg.js"), "utf8") + ";1");
const screens = await ev("window.SCREENS");
const only = process.argv[2] ? process.argv[2].split(",").map(Number) : null;
const manifest = [];
for (let i = 0; i < screens.length; i++) {
  if (only && !only.includes(i)) continue;
  const svg = await ev(`exportSVG(${i})`);
  const file = join(out, `s${String(i).padStart(2, "0")}.svg`); writeFileSync(file, svg);
  const box = await ev(`(()=>{const r=document.getElementById('s${i}').getBoundingClientRect();return {x:r.left+scrollX,y:r.top+scrollY}})()`);
  const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: box.x, y: box.y, width: 1040, height: 760, scale: 1 }, captureBeyondViewport: true });
  writeFileSync(join(out, `s${String(i).padStart(2, "0")}.png`), Buffer.from(shot.data, "base64"));
  manifest.push({ i, ...screens[i], svg: file, bytes: svg.length });
}
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 1));
console.log(manifest.map(m => `${m.i}\t${m.page}\t${m.title}\t${m.bytes}`).join("\n"));
ws.close(); chrome.kill(); process.exit(0);
