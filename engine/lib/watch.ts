import fs from "node:fs";
import path from "node:path";

import { forget as forgetGit } from "./git.ts";
import { CLAUDE_DIR } from "./paths.ts";
import { forgetProjects } from "./projects.ts";

/**
 * Keeps the app's view current with the disk. Every folder the app has shown
 * a file from is watched; a change is broadcast to connected clients within a
 * few hundred milliseconds, so an edit Claude makes mid-session (a new memory,
 * a rewritten CLAUDE.md) appears without a reload.
 */

type Listener = (paths: string[]) => void;

const listeners = new Set<Listener>();
const watchers = new Map<string, fs.FSWatcher>();
const MAX_WATCHERS = 256;
let pending = new Set<string>();
let timer: NodeJS.Timeout | null = null;

const RELEVANT = /\.(md|json|toml)$|^\.gitignore$/;

function emit(file: string) {
  if (!RELEVANT.test(path.basename(file))) return;
  // Transcripts and caches churn constantly and are never shown as files.
  if (file.includes(`${path.sep}projects${path.sep}`) && !file.includes(`${path.sep}memory${path.sep}`)) return;
  pending.add(file);
  if (timer) return;
  timer = setTimeout(() => {
    const paths = [...pending];
    pending = new Set();
    timer = null;
    forgetGit();
    if (paths.some((p) => p.endsWith(".gitignore") || path.basename(p).startsWith("settings"))) forgetProjects();
    for (const l of listeners) l(paths);
  }, 200);
}

export function watchDir(dir: string, recursive = false): void {
  const key = `${recursive ? "r" : "f"}:${dir}`;
  if (watchers.has(key) || watchers.size >= MAX_WATCHERS) return;
  try {
    if (!fs.statSync(dir).isDirectory()) return;
    const w = fs.watch(dir, { recursive, persistent: false }, (_event, name) => {
      if (name) emit(path.join(dir, name.toString()));
    });
    w.on("error", () => {
      w.close();
      watchers.delete(key);
    });
    watchers.set(key, w);
  } catch {
    /* the folder doesn't exist yet; it is watched once something is created in it */
  }
}

export function watchFile(file: string): void {
  watchDir(path.dirname(file));
}

export function watchBase(): void {
  watchDir(CLAUDE_DIR);
  for (const d of ["rules", "agents", "output-styles", "skills"]) watchDir(path.join(CLAUDE_DIR, d), true);
}

export function watchProject(project: string, memoryDir: string | null): void {
  watchDir(project);
  watchDir(path.join(project, ".claude"), true);
  if (memoryDir) watchDir(memoryDir);
}

export function watchCount(): number {
  return watchers.size;
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Tell clients about a write the engine made itself, without waiting on fs events. */
export function announce(paths: string[]): void {
  for (const p of paths) emit(p);
}
