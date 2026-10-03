import fs from "node:fs/promises";
import path from "node:path";

import type { ScanFolder, ScanState } from "../../shared/types.ts";
import { HEAVY_DIRS } from "./fsx.ts";
import { HOME, expandHome, tilde } from "./paths.ts";
import { getPrefs } from "./prefs.ts";
import { forgetProjects, projectKind, skipper } from "./projects.ts";

/**
 * Setup's search for projects: git repositories and folders with a CLAUDE.md,
 * AGENTS.md or CLAUDE.local.md. It looks through the home folder, never the
 * whole disk, four folders deep (a project folder plus the three levels the
 * project list looks under it), and stops at each repository it finds.
 *
 * It never enters Library, hidden folders or the media folders, which hold no
 * code and some of which macOS guards. macOS also asks the person before an
 * app reads Desktop, Documents or Downloads, so those are searched only when
 * asked for, one at a time, from the main process the prompt is shown for; a
 * refusal is reported as a refusal, never as "nothing there".
 */

export const ASK_FIRST = ["Documents", "Desktop", "Downloads"] as const;
const NEVER = new Set(["Library", "Applications", "Music", "Movies", "Pictures", "Public"]);
const PACKAGES = /\.(app|photoslibrary|musiclibrary|tvlibrary|bundle|framework)$/;
const DEPTH = 4;
const LIMIT = 60_000;
const WORKERS = 12;

type Found = { path: string; folder: string; withInstructions: boolean };

let state: ScanState = blank();
const found = new Map<string, Found>();
let queue: Promise<void> = Promise.resolve();

function blank(): ScanState {
  return {
    running: false,
    startedAt: null,
    finishedAt: null,
    checked: 0,
    current: null,
    folders: [],
    askFirst: ASK_FIRST.map((name) => ({ name, path: path.join(HOME, name), display: `~/${name}`, state: "not-asked" as const })),
    capped: false,
    error: null,
  };
}

/** The folder a project is offered under: the folder in your home folder that holds it. */
function folderFor(p: string, base: string | null): string {
  if (base) return base;
  const rel = path.relative(HOME, p).split(path.sep);
  // Inside Documents and the like, the next level down is the folder people mean (~/Documents/GitHub).
  if ((ASK_FIRST as readonly string[]).includes(rel[0]) && rel.length >= 3) return path.join(HOME, rel[0], rel[1]);
  return path.join(HOME, rel[0]);
}

function folders(): ScanFolder[] {
  const by = new Map<string, Found[]>();
  for (const f of found.values()) by.set(f.folder, [...(by.get(f.folder) ?? []), f]);
  return [...by.entries()]
    .map(([p, list]) => ({
      path: p,
      display: tilde(p),
      projects: list.length,
      withInstructions: list.filter((f) => f.withInstructions).length,
      names: list.map((f) => path.basename(f.path)).sort((a, b) => a.localeCompare(b)).slice(0, 4),
    }))
    .sort((a, b) => b.projects - a.projects || a.display.localeCompare(b.display));
}

/**
 * Walk one folder. `base` is the folder every find is offered under (a folder
 * the person added); null means group by the folder in the home folder.
 * Returns false when the folder itself couldn't be read.
 */
async function walk(root: string, depth: number, base: string | null, skipTop: (name: string) => boolean): Promise<boolean> {
  const skip = skipper((await getPrefs()).skipFolders);
  const todo: { dir: string; depth: number }[] = [];
  let rootOk = true;
  const step = async (dir: string, d: number) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      if (dir === root) rootOk = false;
      return;
    }
    state.checked++;
    state.current = tilde(dir);
    const kind = projectKind(new Set(entries.map((e) => e.name)));
    // The home folder can be a git repository of its own (dotfiles); it is never a project here.
    const isHome = dir === HOME;
    const folder = folderFor(dir, base);
    // A folder offered as a project folder counts itself only when it's a repository, as the project list does.
    if (kind.project && !isHome && (folder !== dir || kind.repo)) {
      found.set(dir, { path: dir, folder, withInstructions: kind.withInstructions });
    }
    if ((kind.repo && !isHome) || d >= depth) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || HEAVY_DIRS.has(e.name) || PACKAGES.test(e.name)) continue;
      if (d === 0 && skipTop(e.name)) continue;
      const full = path.join(dir, e.name);
      if (!skip(full)) todo.push({ dir: full, depth: d + 1 });
    }
  };
  // The first read runs alone, so a refusal on the folder itself is seen before anything else.
  await step(root, 0);
  if (!rootOk) return false;
  // A small pool: a worker never quits while another may still queue subfolders.
  let active = 0;
  await new Promise<void>((resolve) => {
    const pump = () => {
      while (active < WORKERS && todo.length && state.checked < LIMIT) {
        const next = todo.shift()!;
        active++;
        void step(next.dir, next.depth).finally(() => {
          active--;
          pump();
        });
      }
      if (active === 0) resolve();
    };
    pump();
  });
  if (todo.length) state.capped = true;
  return true;
}

function run(job: () => Promise<void>): ScanState {
  queue = queue.then(async () => {
    state.running = true;
    state.error = null;
    state.startedAt = new Date().toISOString();
    state.finishedAt = null;
    try {
      await job();
    } catch (e) {
      state.error = (e as Error).message;
    } finally {
      state.running = false;
      state.current = null;
      state.finishedAt = new Date().toISOString();
      state.folders = folders();
      forgetProjects();
    }
  });
  state.running = true;
  return scanState();
}

/** Search the home folder, leaving out what macOS asks about first. Starts over. */
export function scanHome(): ScanState {
  return run(async () => {
    found.clear();
    const askFirst = state.askFirst;
    state = { ...blank(), running: true, askFirst };
    await walk(HOME, DEPTH, null, (n) => NEVER.has(n) || (ASK_FIRST as readonly string[]).includes(n));
  });
}

/** Search one of Documents, Desktop or Downloads; macOS may ask the person first. */
export function scanAskFirst(name: string): ScanState {
  const slot = state.askFirst.find((a) => a.name === name);
  if (!slot) throw new Error(`${name} isn't one of the folders macOS asks about.`);
  return run(async () => {
    try {
      await fs.stat(slot.path);
    } catch {
      slot.state = "missing";
      return;
    }
    // One level deeper than elsewhere, because ~/Documents/GitHub is the folder people mean.
    slot.state = (await walk(slot.path, DEPTH, null, () => false)) ? "searched" : "refused";
  });
}

/** Search a folder the person chose, anywhere; everything found is offered under it. */
export function scanFolder(folder: string): ScanState {
  const abs = path.resolve(expandHome(folder));
  return run(async () => {
    if (!(await walk(abs, DEPTH - 1, abs, () => false))) throw new Error(`${tilde(abs)} couldn't be read.`);
  });
}

export function scanState(): ScanState {
  return { ...state, folders: state.running ? folders() : state.folders };
}

/** Wait for every queued search; for tests. */
export async function scanSettled(): Promise<ScanState> {
  await queue;
  return scanState();
}

export function forgetScan(): void {
  found.clear();
  state = blank();
}
