#!/usr/bin/env node
// Starts the engine and the Vite dev server together with one shared token.
//
//   pnpm dev      → UI on http://127.0.0.1:3100, engine on 127.0.0.1:3101
//
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const token = randomBytes(24).toString("hex");
const env = {
  ...process.env,
  ACP_TOKEN: token,
  ACP_ENGINE_PORT: process.env.ACP_ENGINE_PORT ?? "3101",
  ACP_PORT: process.env.ACP_PORT ?? "3100",
  ACP_DEV: "1",
};

const children = [
  spawn("pnpm", ["exec", "tsx", "watch", "--clear-screen=false", "engine/main.ts"], { env, stdio: "inherit" }),
  spawn("pnpm", ["exec", "vite"], { env, stdio: "inherit" }),
];

const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const c of children) c.on("exit", (code) => code && stop());
