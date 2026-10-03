import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type * as O from "./opencode-sessions.ts";
import type * as T from "./transcripts.ts";

/**
 * The engine's side of transcripts-worker.ts: the same functions, run on the
 * worker. In development the worker is the .ts file beside this one (tsx's
 * loader comes with the inherited flags); in a build it's the bundle beside
 * the engine's, unpacked from the app's archive so a worker can load it.
 */

let worker: Worker | null = null;
let next = 0;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function workerFile(): string | URL {
  const here = import.meta.url;
  if (here.endsWith(".ts")) return new URL("./transcripts-worker.ts", here);
  return path.join(path.dirname(fileURLToPath(here)), "transcripts-worker.mjs").replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

function call<R>(fn: string, args: unknown[]): Promise<R> {
  if (!worker) {
    worker = new Worker(workerFile());
    worker.unref();
    worker.on("message", (m: { id: number; result?: unknown; error?: string }) => {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error !== undefined) w?.reject(new Error(m.error));
      else w?.resolve(m.result);
    });
    worker.on("error", (e: Error) => {
      for (const w of waiting.values()) w.reject(e);
      waiting.clear();
      worker = null;
    });
  }
  const id = ++next;
  return new Promise<R>((resolve, reject) => {
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker!.postMessage({ id, fn, args });
  });
}

export const fileSessions = (...a: Parameters<typeof T.fileSessions>) => call<Awaited<ReturnType<typeof T.fileSessions>>>("fileSessions", a);
export const fileSession = (...a: Parameters<typeof T.fileSession>) => call<ReturnType<typeof T.fileSession>>("fileSession", a);
export const usageView = (...a: Parameters<typeof T.usageView>) => call<Awaited<ReturnType<typeof T.usageView>>>("usageView", a);
export const warmTranscripts = (...a: Parameters<typeof T.warmTranscripts>) => void call("warmTranscripts", a).catch(() => {});
/** Where OpenCode's sessions are read from, and why they aren't shown when they aren't; asked of the worker, which holds what it read. */
export const openCodeStore = () => call<ReturnType<typeof O.openCodeStore>>("openCodeStore", []);
