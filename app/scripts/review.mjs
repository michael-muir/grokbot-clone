// Launches the visual-review entry as Electron. A parent that set ELECTRON_RUN_AS_NODE would
// otherwise make the Electron binary run as plain Node, which cannot open a window.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");
const dir = dirname(fileURLToPath(import.meta.url));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [join(dir, "../out/main/review.js")], { stdio: "inherit", env, windowsHide: false });
child.on("error", (err) => {
  console.error(`review: could not start Electron: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
