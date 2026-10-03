import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { FileInfo, FileKind } from "../../shared/types.ts";
import { tilde } from "./paths.ts";

export type TextFile = {
  path: string;
  text: string;
  hash: string;
  bytes: number;
  lines: number;
  modified: string;
  mode: number;
  isSymlink: boolean;
  linkTarget: string | null;
  realPath: string;
};

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 20);
}

export function countLines(text: string): number {
  if (!text) return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Largest file the app will open as text. Claude Code itself skips instruction files over 4 MiB. */
export const MAX_TEXT = 8 * 1024 * 1024;

export async function readText(p: string): Promise<TextFile | null> {
  let lst;
  try {
    lst = await fs.lstat(p);
  } catch {
    return null;
  }
  const isSymlink = lst.isSymbolicLink();
  let realPath = p;
  let linkTarget: string | null = null;
  if (isSymlink) {
    try {
      linkTarget = await fs.readlink(p);
      realPath = await fs.realpath(p);
    } catch {
      return null;
    }
  }
  let st;
  try {
    st = await fs.stat(realPath);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  let buf: Buffer;
  try {
    buf = st.size > MAX_TEXT ? await readHead(realPath, MAX_TEXT) : await fs.readFile(realPath);
  } catch {
    // There, but not readable (no permission, or macOS's privacy protection): see `unreadable`.
    return null;
  }
  const text = buf.toString("utf8");
  return {
    path: p,
    text,
    hash: hashText(text),
    bytes: st.size,
    lines: countLines(text),
    modified: st.mtime.toISOString(),
    mode: st.mode,
    isSymlink,
    linkTarget,
    realPath,
  };
}

/** The first `n` bytes of a file. The handle is closed even when the read fails (a folder named like a file). */
export async function readHead(p: string, n: number): Promise<Buffer> {
  const fh = await fs.open(p, "r");
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * A file that's there but can't be opened: no read permission, or macOS refused
 * it. It is shown as there, and never written over, because nobody has seen it.
 */
export async function unreadable(p: string): Promise<boolean> {
  try {
    if (!(await fs.stat(p)).isFile()) return false;
  } catch {
    return false;
  }
  try {
    await (await fs.open(p, "r")).close();
    return false;
  } catch (e) {
    return ["EACCES", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? "");
  }
}

export const UNREADABLE = "AgentCP isn't allowed to read this file, so it can't show or change it.";

export async function fileInfo(
  p: string,
  kind: FileKind,
  lock: { editable: boolean; lockedBecause: string | null },
): Promise<FileInfo> {
  const f = await readText(p);
  const shut = !f && (await unreadable(p));
  return {
    path: p,
    display: tilde(p),
    name: path.basename(p),
    kind,
    exists: !!f || shut,
    bytes: f?.bytes ?? 0,
    lines: f?.lines ?? 0,
    modified: f?.modified ?? null,
    isSymlink: f?.isSymlink ?? false,
    linkTarget: f?.linkTarget ?? null,
    hash: f?.hash ?? null,
    editable: lock.editable && !shut,
    lockedBecause: shut ? UNREADABLE : lock.lockedBecause,
    unreadable: shut,
  };
}

/**
 * Write through a temporary file and a rename, so a crash never leaves a
 * half-written instruction file. A link is written at its target, never
 * replaced by a regular file.
 */
export async function atomicWrite(p: string, text: string, mode?: number): Promise<void> {
  let target = p;
  try {
    target = await fs.realpath(p);
  } catch {
    /* new file */
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.acp-${process.pid}-${Date.now()}`);
  await fs.writeFile(tmp, text, { encoding: "utf8", mode: mode ?? 0o644 });
  if (mode !== undefined) await fs.chmod(tmp, mode & 0o777);
  await fs.rename(tmp, target);
}

/** Recursively list files under a directory, skipping heavy or irrelevant folders. */
export async function walk(
  dir: string,
  opts: { maxDepth: number; match: (name: string, full: string) => boolean; skipDir?: (name: string, full: string) => boolean },
): Promise<string[]> {
  const out: string[] = [];
  const go = async (d: string, depth: number) => {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory() || (e.isSymbolicLink() && (await isDir(full)))) {
        if (depth < opts.maxDepth && !(opts.skipDir?.(e.name, full) ?? false)) await go(full, depth + 1);
      } else if (opts.match(e.name, full)) {
        out.push(full);
      }
    }
  };
  await go(dir, 0);
  return out.sort();
}

export const HEAVY_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "out",
  "vendor",
  "Pods",
  "DerivedData",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  ".cache",
  "coverage",
  "target",
]);
