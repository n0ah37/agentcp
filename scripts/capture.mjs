#!/usr/bin/env node
// Screenshots of the built desktop app, taken inside Electron itself (an
// offscreen window per shot), in light and dark. Used to check the design
// without anyone at the screen.
//
//   node scripts/capture.mjs <out dir> [shots.json]
//
// shots.json: [{ "name": "instructions", "hash": "/instructions?project=…", "theme": "dark", "width": 1440, "height": 900, "wait": 2000, "script": "…" }]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const out = path.resolve(process.argv[2] ?? "capture");
const shots = process.argv[3]
  ? JSON.parse(fs.readFileSync(process.argv[3], "utf8"))
  : ["light", "dark"].map((theme) => ({ name: `instructions-${theme}`, hash: "/instructions", theme }));
const electron = path.resolve("node_modules/.bin/electron");
const r = spawnSync(electron, ["."], { stdio: "inherit", env: { ...process.env, ACP_CAPTURE: JSON.stringify({ dir: out, shots }) }, timeout: 10 * 60_000 });
process.exit(r.status ?? 1);
