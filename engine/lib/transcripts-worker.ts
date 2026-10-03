import { parentPort } from "node:worker_threads";

import { openCodeStore } from "./opencode-sessions.ts";
import { fileSession, fileSessions, usageView, warmTranscripts } from "./transcripts.ts";

/**
 * Reads the agents' session files on a thread of its own. The first read of a
 * big ~/.claude is gigabytes of JSON lines; done on the engine's own thread it
 * holds up every other screen until it finishes.
 */
const fns = { fileSession, fileSessions, usageView, warmTranscripts, openCodeStore } as Record<string, (...a: unknown[]) => unknown>;

parentPort?.on("message", async (m: { id: number; fn: string; args: unknown[] }) => {
  try {
    parentPort!.postMessage({ id: m.id, result: await fns[m.fn](...m.args) });
  } catch (e) {
    parentPort!.postMessage({ id: m.id, error: (e as Error).message });
  }
});
