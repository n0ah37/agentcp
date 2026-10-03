#!/usr/bin/env node
// Bundles the engine into one ESM file that `pnpm start` runs and a desktop
// shell can embed. Dependencies are pure JavaScript, so everything is inlined.
import { build } from "esbuild";

await build({
  entryPoints: ["engine/main.ts"],
  outfile: "dist/engine/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
// Session files are read on a worker thread, which loads its own bundle.
await build({
  entryPoints: ["engine/lib/transcripts-worker.ts"],
  outfile: "dist/engine/transcripts-worker.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
console.log("engine → dist/engine/main.js, transcripts-worker.mjs");
