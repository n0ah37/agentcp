import fs from "node:fs/promises";
import path from "node:path";

import type { MemoryFolder, MemoryItem, MemoryView, ProjectRef } from "../../shared/types.ts";
import { LIMITS, checkMemoryFile, checkMemoryIndex, checkMemoryLinks } from "./checks.ts";
import { fileInfo, readHead, readText } from "./fsx.ts";
import { splitFrontmatter } from "./frontmatter.ts";
import { mainRepoRoot } from "./git.ts";
import { lockFor } from "./locks.ts";
import { CLAUDE_DIR, HOME, encodeProjectDir, expandHome, tilde } from "./paths.ts";
import { getPath, readScopes } from "./settings.ts";

/**
 * Auto memory, as the memory documentation describes it: one folder per
 * repository at ~/.claude/projects/<project>/memory/, shared by every worktree
 * of that repository, holding a MEMORY.md index and one file per memory. The
 * first 200 lines or 25 KB of the index load at the start of every session;
 * the memory files are read when Claude needs them.
 */

export async function memoryDir(project: string): Promise<{ dir: string; setBy: string | null }> {
  for (const s of await readScopes(project)) {
    const v = getPath(s.data, ["autoMemoryDirectory"]);
    if (typeof v === "string" && (v.startsWith("/") || v.startsWith("~/"))) {
      return { dir: path.resolve(expandHome(v)), setBy: tilde(s.path) };
    }
  }
  const root = (await mainRepoRoot(project)) ?? project;
  return { dir: path.join(CLAUDE_DIR, "projects", encodeProjectDir(root), "memory"), setBy: null };
}

export async function memoryEnabled(project: string | null): Promise<{ enabled: boolean; setBy: string }> {
  if (process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === "1") return { enabled: false, setBy: "CLAUDE_CODE_DISABLE_AUTO_MEMORY in the environment" };
  const scopes = await readScopes(project);
  for (const s of scopes) {
    const env = getPath(s.data, ["env", "CLAUDE_CODE_DISABLE_AUTO_MEMORY"]);
    if (env === "1" || env === 1) return { enabled: false, setBy: `CLAUDE_CODE_DISABLE_AUTO_MEMORY in ${tilde(s.path)}` };
  }
  for (const s of scopes) {
    const v = getPath(s.data, ["autoMemoryEnabled"]);
    if (typeof v === "boolean") return { enabled: v, setBy: tilde(s.path) };
  }
  return { enabled: true, setBy: "Claude Code's default" };
}

export async function memoryIndexPath(project: string): Promise<{ path: string; enabled: boolean } | null> {
  const { dir } = await memoryDir(project);
  return { path: path.join(dir, "MEMORY.md"), enabled: (await memoryEnabled(project)).enabled };
}

/** The line after which the index stops loading, or null if it all loads. */
export function cutLine(text: string): number | null {
  const lines = text.split("\n");
  let bytes = 0;
  for (let i = 0; i < lines.length; i++) {
    bytes += Buffer.byteLength(lines[i]) + 1;
    if (i + 1 > LIMITS.memoryLines || bytes > LIMITS.memoryBytes) return i;
  }
  return null;
}

type IndexLink = { line: number; title: string; target: string; hook: string };

export function parseIndex(text: string): IndexLink[] {
  const out: IndexLink[] = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/\[([^\]]+)\]\(([^)\s]+\.md)\)/g)) {
      const hook = line.slice((m.index ?? 0) + m[0].length).replace(/^\s*[—–:-]\s*/, "").trim();
      out.push({ line: i + 1, title: m[1], target: m[2], hook });
    }
  });
  return out;
}

export async function memoryView(project: ProjectRef): Promise<MemoryView> {
  const { dir, setBy } = await memoryDir(project.path);
  const { enabled, setBy: enabledSetBy } = await memoryEnabled(project.path);
  const indexPath = path.join(dir, "MEMORY.md");
  const index = await readText(indexPath);
  const links = index ? parseIndex(index.text) : [];
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".md") && n !== "MEMORY.md").sort();
  const lock = (p: string) => lockFor(p, [dir]);

  const items: MemoryItem[] = [];
  for (const n of names) {
    const p = path.join(dir, n);
    const t = await readText(p);
    const fm = t ? splitFrontmatter(t.text) : null;
    const link = links.find((l) => path.basename(l.target) === n);
    const meta = (fm?.data.metadata ?? {}) as Record<string, unknown>;
    items.push({
      file: await fileInfo(p, "memory", lock(p)),
      title: String(fm?.data.name ?? link?.title ?? n.replace(/\.md$/, "")),
      description: String(fm?.data.description ?? link?.hook ?? ""),
      type: (fm?.data.type ?? meta.type ?? null) as string | null,
      indexed: !!link,
      indexLine: link?.line ?? null,
    });
  }
  const broken = links
    .filter((l) => !names.includes(path.basename(l.target)))
    .map((l) => ({ line: l.line, target: l.target, title: l.title }));
  const cut = index ? cutLine(index.text) : null;
  const findings = [
    ...(index ? checkMemoryIndex(index.lines, index.bytes, cut) : []),
    ...checkMemoryLinks(broken, items.filter((i) => !i.indexed).map((i) => i.file.name)),
  ];
  for (const i of items) {
    const t = await readText(i.file.path);
    const fm = t ? splitFrontmatter(t.text) : null;
    const meta = (fm?.data.metadata ?? {}) as Record<string, unknown>;
    findings.push(...checkMemoryFile(fm?.data.type ?? meta.type).map((f) => ({ ...f, id: `${f.id}:${i.file.name}`, title: `${i.file.name}: ${f.title}` })));
  }
  return {
    project,
    dir,
    dirDisplay: tilde(dir),
    dirSetBy: setBy,
    enabled,
    enabledSetBy,
    index: index ? await fileInfo(indexPath, "memory-index", lock(indexPath)) : null,
    limits: { lines: LIMITS.memoryLines, bytes: LIMITS.memoryBytes },
    used: { lines: index?.lines ?? 0, bytes: index?.bytes ?? 0 },
    cutAfterLine: cut,
    items,
    broken,
    findings,
  };
}

/** Every memory folder on this Mac, for the view with no project chosen. */
export async function memoryFolders(): Promise<MemoryFolder[]> {
  const root = path.join(CLAUDE_DIR, "projects");
  const out: MemoryFolder[] = [];
  for (const name of await fs.readdir(root).catch(() => [] as string[])) {
    const dir = path.join(root, name, "memory");
    const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".md") && n !== "MEMORY.md");
    if (!files.length) continue;
    let modified: string | null = null;
    for (const f of files) {
      try {
        const m = (await fs.stat(path.join(dir, f))).mtime.toISOString();
        if (!modified || m > modified) modified = m;
      } catch {
        /* raced with a delete */
      }
    }
    const where = await folderOf(path.join(root, name));
    out.push({ dir, project: where.path, memories: files.length, modified, display: tilde(where.path), name: where.path === HOME ? "Home folder" : path.basename(where.path), exists: where.exists });
  }
  return out.sort((a, b) => (b.modified ?? "").localeCompare(a.modified ?? ""));
}

/**
 * The folder a ~/.claude/projects entry belongs to. Claude Code names the
 * entry after the path with every character that isn't a letter or digit
 * made "-", which can't be read back directly. So the path is taken from a
 * session there that ran in it (its `cwd`, checked against the name), or
 * else found by walking the disk for a path that encodes to the name. A
 * folder that's gone gets the name read back with "/" for "-", which still
 * leads to its memory.
 */
async function folderOf(entry: string): Promise<{ path: string; exists: boolean }> {
  const name = path.basename(entry);
  let names: string[];
  try {
    names = (await fs.readdir(entry)).filter((n) => n.endsWith(".jsonl"));
  } catch {
    names = [];
  }
  for (const n of names.slice(0, 8)) {
    try {
      for (const m of (await readHead(path.join(entry, n), 256 * 1024)).toString("utf8").matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) {
        const cwd = JSON.parse(`"${m[1]}"`) as string;
        if (encodeProjectDir(cwd) === name) return { path: cwd, exists: await fs.access(cwd).then(() => true, () => false) };
      }
    } catch {
      /* unreadable; try the next */
    }
  }
  const found = await walkTo(name);
  if (found.rest === "") return { path: found.dir, exists: true };
  // Gone: the part of the path that's still there, then the rest of the name as it was written.
  return { path: path.join(found.dir, found.rest), exists: false };
}

/**
 * Walks down from / for the folder whose path encodes to `name`, one
 * directory at a time. Returns the deepest folder that matched and what's
 * left of the name ("" when the whole path exists).
 */
async function walkTo(name: string, dir = "/"): Promise<{ dir: string; rest: string }> {
  const rest = name.slice(encodeProjectDir(dir === "/" ? "/" : dir + "/").length);
  if (!rest) return { dir, rest: "" };
  let kids: string[];
  try {
    kids = (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return { dir, rest };
  }
  let best = { dir, rest };
  for (const k of kids) {
    const enc = encodeProjectDir(k);
    if (rest === enc || rest.startsWith(enc + "-")) {
      const hit = await walkTo(name, path.join(dir, k));
      if (hit.rest === "") return hit;
      if (hit.rest.length < best.rest.length) best = hit;
    }
  }
  return best;
}
