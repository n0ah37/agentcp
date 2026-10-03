import fs from "node:fs/promises";
import path from "node:path";

import type { ProjectRef } from "../../shared/types.ts";
import { HEAVY_DIRS, exists, readHead } from "./fsx.ts";
import { CLAUDE_DIR, HOME, expandHome, tilde } from "./paths.ts";
import { getPrefs } from "./prefs.ts";

/**
 * A project is a directory a Claude Code session can start in. The app finds
 * them in two places: the folders Claude Code has already run in (each
 * ~/.claude/projects/<encoded> folder, whose transcripts record the real
 * working directory), and the git repositories and folders with instruction
 * files under the project folders setup's search chose (see scan.ts).
 */

const cwdCache = new Map<string, { mtime: number; cwd: string | null }>();

async function cwdOf(folder: string): Promise<{ cwd: string | null; lastActive: string | null }> {
  let files: { name: string; mtime: number }[];
  try {
    const names = (await fs.readdir(folder)).filter((n) => n.endsWith(".jsonl"));
    files = await Promise.all(
      names.map(async (name) => ({ name, mtime: (await fs.stat(path.join(folder, name))).mtimeMs })),
    );
  } catch {
    return { cwd: null, lastActive: null };
  }
  if (!files.length) return { cwd: null, lastActive: null };
  files.sort((a, b) => b.mtime - a.mtime);
  const newest = files[0];
  const lastActive = new Date(newest.mtime).toISOString();
  const hit = cwdCache.get(folder);
  if (hit && hit.mtime === newest.mtime) return { cwd: hit.cwd, lastActive };
  let cwd: string | null = null;
  for (const f of files.slice(0, 3)) {
    try {
      const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec((await readHead(path.join(folder, f.name), 256 * 1024)).toString("utf8"));
      if (m) {
        cwd = JSON.parse(`"${m[1]}"`) as string;
        break;
      }
    } catch {
      /* unreadable transcript; try the next */
    }
  }
  cwdCache.set(folder, { mtime: newest.mtime, cwd });
  return { cwd, lastActive };
}

/** Files that make a folder a project even when it isn't a git repository. */
const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md", "CLAUDE.local.md"];

/** What a folder's entries say about it: a project, and whether it has instructions yet. */
export function projectKind(names: Set<string>): { project: boolean; repo: boolean; withInstructions: boolean } {
  const repo = names.has(".git");
  const withInstructions = INSTRUCTION_FILES.some((m) => names.has(m));
  return { project: repo || withInstructions, repo, withInstructions };
}

/** A folder the person asked to leave out, or one inside it. */
export function skipper(skipFolders: string[]): (full: string) => boolean {
  const skip = skipFolders.map((s) => path.resolve(expandHome(s)));
  return (full) => skip.some((s) => full === s || full.startsWith(s + path.sep));
}

async function reposUnder(root: string, maxDepth: number, skip: (full: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  const go = async (dir: string, depth: number) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const kind = projectKind(new Set(entries.map((e) => e.name)));
    // A project folder is itself a project only when it is a repository; a
    // folder of repositories with a CLAUDE.md of its own is shown through them.
    if (kind.project && (depth > 0 || kind.repo)) out.push(dir);
    if (kind.repo) return; // don't descend into a repository's own folders
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || HEAVY_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (!skip(full)) await go(full, depth + 1);
    }
  };
  await go(root, 0);
  return out;
}

let cache: { at: number; key: string; list: ProjectRef[] } | null = null;

export function forgetProjects(): void {
  cache = null;
}

function isWorktree(p: string): boolean {
  return p.includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`) || p.includes(`${path.sep}.worktrees${path.sep}`);
}

function groupFor(p: string, roots: string[]): string {
  for (const r of roots) {
    if (p.startsWith(r + path.sep)) {
      const rel = path.relative(r, path.dirname(p));
      return rel ? rel.split(path.sep)[0] : path.basename(r);
    }
  }
  return tilde(path.dirname(p));
}

export async function listProjects(): Promise<ProjectRef[]> {
  const prefs = await getPrefs();
  const key = JSON.stringify([prefs.projectRoots, prefs.skipFolders, prefs.showWorktrees]);
  if (cache && cache.key === key && Date.now() - cache.at < 30_000) return cache.list;

  const roots = prefs.projectRoots.map((r) => path.resolve(expandHome(r)));
  const skip = skipper(prefs.skipFolders);
  const byPath = new Map<string, ProjectRef>();

  const folders = await fs.readdir(path.join(CLAUDE_DIR, "projects")).catch(() => [] as string[]);
  await Promise.all(
    folders.map(async (name) => {
      const { cwd, lastActive } = await cwdOf(path.join(CLAUDE_DIR, "projects", name));
      if (!cwd || cwd === HOME || !path.isAbsolute(cwd)) return;
      const prev = byPath.get(cwd);
      if (!prev || (lastActive && (!prev.lastActive || lastActive > prev.lastActive))) {
        byPath.set(cwd, { path: cwd, display: tilde(cwd), name: path.basename(cwd), group: "", lastActive, isWorktree: isWorktree(cwd), exists: true });
      }
    }),
  );

  for (const root of roots) {
    if (skip(root)) continue;
    for (const p of await reposUnder(root, 3, skip)) {
      if (!byPath.has(p)) byPath.set(p, { path: p, display: tilde(p), name: path.basename(p), group: "", lastActive: null, isWorktree: false, exists: true });
    }
  }

  let list = await Promise.all(
    [...byPath.values()].map(async (p) => ({ ...p, exists: await exists(p.path), group: groupFor(p.path, roots) })),
  );
  // Scratch folders the desktop app and other tools create are not projects.
  // Inside the home folder only Library is scratch, wherever the home folder itself lives.
  const scratch = [path.join(HOME, "Library"), "/private/var", "/var/folders", "/tmp", "/private/tmp"];
  const under = (p: string, s: string) => p === s || p.startsWith(s + path.sep);
  list = list.filter((p) => p.exists && (under(p.path, HOME) ? !under(p.path, scratch[0]) : !scratch.some((s) => under(p.path, s))));
  list = list.filter((p) => !skip(p.path));
  if (!prefs.showWorktrees) list = list.filter((p) => !p.isWorktree);
  list.sort((a, b) => (b.lastActive ?? "").localeCompare(a.lastActive ?? "") || a.name.localeCompare(b.name));
  cache = { at: Date.now(), key, list };
  return list;
}

export async function projectRef(p: string | null): Promise<ProjectRef | null> {
  if (!p) return null;
  const abs = path.resolve(expandHome(p));
  const known = (await listProjects()).find((x) => x.path === abs);
  if (known) return known;
  const prefs = await getPrefs();
  return {
    path: abs,
    display: tilde(abs),
    name: path.basename(abs),
    group: groupFor(abs, prefs.projectRoots.map((r) => path.resolve(expandHome(r)))),
    lastActive: null,
    isWorktree: isWorktree(abs),
    exists: await exists(abs),
  };
}
