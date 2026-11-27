// Build config for the three parts of the app: main process, preload bridge, and React renderer.
// Main has two entries. index is the app; review captures screens and is not the package main.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const dir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  main: {
    build: {
      rolldownOptions: {
        input: {
          index: resolve(dir, "src/main/index.ts"),
          review: resolve(dir, "src/main/review.ts"),
        },
      },
    },
  },
  preload: {
    build: {
      // A sandboxed preload can't be an ES module, whatever the package type says.
      rolldownOptions: { output: { format: "cjs", entryFileNames: "[name].cjs" } },
    },
  },
  renderer: {
    plugins: [react()],
    // The renderer imports shared types and the transcript view from ../server.
    server: { fs: { allow: [".."] } },
  },
});
