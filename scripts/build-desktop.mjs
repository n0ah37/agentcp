#!/usr/bin/env node
// Bundles the desktop app's main process (with the engine inside it) and its
// preload script. The UI is built by Vite into dist/app, which the engine serves.
import { build } from "esbuild";

const common = { bundle: true, platform: "node", target: "node24", sourcemap: true, external: ["electron"] };

await build({
  ...common,
  entryPoints: ["desktop/main.ts"],
  outfile: "dist/desktop/main.mjs",
  format: "esm",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
// The engine reads session files on a worker thread, from a bundle of its own beside main.mjs.
await build({
  ...common,
  entryPoints: ["engine/lib/transcripts-worker.ts"],
  outfile: "dist/desktop/transcripts-worker.mjs",
  format: "esm",
  sourcemap: false,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
// Sandboxed preload scripts must be CommonJS.
await build({ ...common, entryPoints: ["desktop/preload.ts"], outfile: "dist/desktop/preload.cjs", format: "cjs" });
console.log("desktop → dist/desktop/main.mjs, transcripts-worker.mjs, preload.cjs");
