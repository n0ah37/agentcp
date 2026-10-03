import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the engine runs on its own port (scripts/dev.mjs starts both)
// and Vite forwards the API to it, adding the per-launch token the engine
// requires. In production the engine serves the built app itself and writes
// the token into index.html.
const engine = `http://127.0.0.1:${process.env.ACP_ENGINE_PORT ?? "3101"}`;
const token = process.env.ACP_TOKEN ?? "";

export default defineConfig({
  root: "app",
  plugins: [react()],
  // One bundle is fine for an app loaded from disk over loopback; splitting buys nothing here.
  // Hidden source maps: scripts/licenses.mjs reads them to list the packages built in; they aren't packaged.
  build: { outDir: "../dist/app", emptyOutDir: true, chunkSizeWarningLimit: 1500, sourcemap: "hidden" },
  server: {
    host: "127.0.0.1",
    port: Number(process.env.ACP_PORT ?? 3100),
    strictPort: true,
    proxy: {
      // Anchored with a slash: a bare "/api" prefix also captures the UI's own /api.ts module.
      "^/api/": {
        target: engine,
        headers: { "x-acp-token": token },
      },
    },
  },
});
