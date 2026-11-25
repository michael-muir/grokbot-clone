// Build config for the three parts of the app: main process, preload bridge, and React renderer.
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {},
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
