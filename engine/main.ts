import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { routes } from "./api.ts";
import { sessionSources } from "./lib/agents.ts";
import { warmDocs } from "./lib/docs.ts";
import { warmTranscripts } from "./lib/transcripts-client.ts";
import { REPO_ROOT, moveOldAppDir } from "./lib/paths.ts";
import { createServer } from "./server.ts";

/**
 * Starts the engine.
 *
 *   pnpm start            → the built app on http://127.0.0.1:3100
 *   pnpm dev              → the engine on 3101 behind Vite on 3100
 *
 * The desktop app (desktop/main.ts) imports `start` with port 0 and loads the returned URL.
 */
export async function start(opts: { port?: number; token?: string } = {}) {
  moveOldAppDir();
  const dev = !!process.env.ACP_DEV;
  const port = opts.port ?? Number(dev ? (process.env.ACP_ENGINE_PORT ?? 3101) : (process.env.ACP_PORT ?? 3100));
  const token = opts.token ?? process.env.ACP_TOKEN ?? randomBytes(24).toString("hex");
  const staticDir = path.join(REPO_ROOT, "dist", "app");
  const server = createServer({ port, token, routes, staticDir: dev || !fs.existsSync(staticDir) ? null : staticDir });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  warmDocs();
  // Only the agents that are on; their session files can run to gigabytes.
  void sessionSources(null).then(warmTranscripts);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  console.log(dev ? `engine on ${url}` : `AgentCP on ${url}`);
  return { url, token, server };
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry.endsWith(`${path.sep}main.ts`) || entry.endsWith(`${path.sep}main.js`)) {
  start().catch((e) => {
    console.error(e.code === "EADDRINUSE" ? `Port in use: ${e.message}` : e);
    process.exit(1);
  });
}
