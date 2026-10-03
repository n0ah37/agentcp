import { createTwoFilesPatch, structuredPatch } from "diff";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { FIXED_NAMES } from "../../shared/names.ts";
import type { HistoryEntry, RenamePlan, WritePlan, WriteResult } from "../../shared/types.ts";
import { UNREADABLE, atomicWrite, hashText, readText, unreadable } from "./fsx.ts";
import {
  APP_DIR,
  CLAUDE_DIR,
  CODEX_DIR,
  HISTORY_FILE,
  HOME,
  MANAGED_DIR,
  OPENCODE_DATA_DIR,
  OPENCODE_DIR,
  SNAPSHOT_DIR,
  expandHome,
  isInside,
  tilde,
} from "./paths.ts";
import { getPrefs } from "./prefs.ts";

/**
 * The only code in the engine that changes a file on disk.
 *
 * The sequence is fixed: read → diff → check the disk still holds the version
 * the client opened → snapshot → atomic write → journal. A caller can stop
 * after the diff (`planWrite`) but cannot reach the write without the
 * snapshot, and a save against a file that moved underneath the editor is
 * refused rather than silently overwriting it.
 */

const INSTRUCTION_NAMES = /^(CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md|\.gitignore)$/;

/** Why `abs` may not be written, or null when it may. */
export function refusalFor(abs: string, extraRoots: string[] = []): string | null {
  if (isInside(abs, MANAGED_DIR)) return "Your organization manages this file. It can't be changed here.";
  if (abs.split(path.sep).includes(".git")) return "Files inside .git are never written.";
  if (abs === path.join(HOME, ".claude.json")) return "~/.claude.json holds credentials and is never written.";

  const ext = path.extname(abs);
  if (isInside(abs, CLAUDE_DIR)) {
    const rel = path.relative(CLAUDE_DIR, abs).split(path.sep);
    if (rel[0] === "projects" && rel[2] !== "memory") return "Only memory files are written inside ~/.claude/projects.";
    if (rel[0] === "plugins") return "Plugin files are managed by Claude Code and are not written here.";
    return ext === ".md" || ext === ".json" ? null : "Only Markdown and JSON files are written.";
  }
  if (isInside(abs, CODEX_DIR)) return [".md", ".toml", ".json", ".rules"].includes(ext) ? null : "Only Markdown, TOML, JSON and rules files are written.";
  // OpenCode's data folder holds its sessions and its sign-ins (auth.json, mcp-auth.json).
  if (isInside(abs, OPENCODE_DATA_DIR)) return "OpenCode's sessions and sign-ins are never written.";
  if (isInside(abs, OPENCODE_DIR) || abs.split(path.sep).includes(".opencode")) return [".md", ".json", ".jsonc"].includes(ext) ? null : "Only Markdown and OpenCode's config files are written; plugins and tools are code, edited in your editor.";
  if (/^opencode\.jsonc?$/.test(path.basename(abs)) && isInside(abs, HOME)) return null;
  if (isInside(abs, APP_DIR)) return null;
  if (extraRoots.some((r) => isInside(abs, r))) return ext === ".md" ? null : "Only Markdown files are written here.";
  if (!isInside(abs, HOME)) return "Files outside your home folder are never written.";
  if (INSTRUCTION_NAMES.test(path.basename(abs))) return null;
  if (abs.split(path.sep).includes(".claude") && (ext === ".md" || ext === ".json")) return null;
  // Codex's skills live in .agents/skills (~/.agents/skills, or a repository's own).
  if (abs.split(path.sep).includes(".agents") && ext === ".md") return null;
  // A repository's own Codex layer: config.toml, hooks.json, agents/*.toml, rules/*.rules.
  if (abs.split(path.sep).includes(".codex") && [".md", ".toml", ".json", ".rules"].includes(ext)) return null;
  return "Only instruction and configuration files are written.";
}

function lineCounts(before: string, after: string) {
  let added = 0;
  let removed = 0;
  for (const h of structuredPatch("a", "b", before, after, "", "", { context: 0 }).hunks) {
    for (const l of h.lines) {
      if (l.startsWith("+")) added++;
      else if (l.startsWith("-")) removed++;
    }
  }
  return { added, removed };
}

export type PlanInput = { path: string; content: string | null; baseHash: string | null; extraRoots?: string[] };

/** Read, diff and check, touching nothing. `content: null` plans a delete. */
export async function planWrite(input: PlanInput): Promise<WritePlan> {
  const abs = path.resolve(expandHome(input.path));
  const cur = await readText(abs);
  const before = cur?.text ?? "";
  const after = input.content ?? "";
  const display = tilde(abs);
  // A null base means the client believes the file does not exist yet.
  const conflict = (cur?.hash ?? null) !== input.baseHash;
  const patch = createTwoFilesPatch(
    cur ? display : "/dev/null",
    input.content === null ? "/dev/null" : display,
    before,
    after,
    "",
    "",
    { context: 3 },
  );
  const { added, removed } = lineCounts(before, after);
  return {
    path: abs,
    display,
    exists: !!cur,
    changed: input.content === null ? !!cur : before !== after || !cur,
    patch,
    added,
    removed,
    conflict,
    diskHash: cur?.hash ?? null,
    refusal: refusalFor(abs, input.extraRoots) ?? (!cur && (await unreadable(abs)) ? UNREADABLE : null),
    writesTo: cur?.isSymlink ? tilde(cur.realPath) : display,
  };
}

async function snapshot(abs: string): Promise<string | null> {
  const cur = await readText(abs);
  if (!cur) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rel = isInside(abs, HOME) ? path.relative(HOME, abs) : path.join("_root", abs);
  const dest = path.join(SNAPSHOT_DIR, stamp, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(cur.realPath, dest);
  return dest;
}

async function journal(entry: HistoryEntry): Promise<void> {
  await fs.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
  await fs.appendFile(HISTORY_FILE, JSON.stringify(entry) + "\n", "utf8");
}

export class WriteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: "disabled" | "refused" | "conflict" | "unchanged",
  ) {
    super(message);
  }
}

/** Snapshot, then write or delete. Refuses whatever `planWrite` refused. */
export async function applyWrite(
  input: PlanInput & { action?: HistoryEntry["action"] },
): Promise<WriteResult> {
  if (!(await getPrefs()).allowEdits) {
    throw new WriteError("Editing is turned off. Turn it on in Preferences.", 403, "disabled");
  }
  const plan = await planWrite(input);
  if (plan.refusal) throw new WriteError(plan.refusal, 403, "refused");
  if (plan.conflict) {
    throw new WriteError(`${path.basename(plan.path)} changed on disk after you opened it.`, 409, "conflict");
  }
  const cur = await readText(plan.path);
  if (input.content !== null && cur && cur.text === input.content) {
    return { path: plan.path, hash: cur.hash, historyId: null };
  }

  const snap = await snapshot(plan.path);
  if (input.content === null) {
    if (cur) await fs.unlink(plan.path);
  } else {
    await atomicWrite(plan.path, input.content, cur?.mode);
  }
  const id = randomUUID();
  await journal({
    id,
    at: new Date().toISOString(),
    action: input.action ?? (input.content === null ? "delete" : cur ? "save" : "create"),
    path: plan.path,
    display: plan.display,
    bytesBefore: cur?.bytes ?? 0,
    bytesAfter: input.content === null ? 0 : Buffer.byteLength(input.content),
    snapshot: snap,
  });
  return { path: plan.path, hash: input.content === null ? "" : hashText(input.content), historyId: id };
}

/**
 * Runs an agent's own command that edits files the app shows (its settings,
 * a project's .mcp.json), and records each file it changed in History with the
 * version before, the way a save here is recorded. Never pass ~/.claude.json:
 * it holds the sign-in session, and no copy of it is kept.
 */
export async function withHistory<T>(paths: string[], run: () => Promise<T>): Promise<T> {
  if (!(await getPrefs()).allowEdits) throw new WriteError("Editing is turned off. Turn it on in Preferences.", 403, "disabled");
  const before = await Promise.all(paths.map(async (p) => ({ p, cur: await readText(p), snap: await snapshot(p) })));
  try {
    return await run();
  } finally {
    for (const b of before) {
      const after = await readText(b.p);
      if ((after?.hash ?? null) === (b.cur?.hash ?? null)) {
        if (b.snap) await fs.rm(b.snap, { force: true }).catch(() => {});
        continue;
      }
      await journal({
        id: randomUUID(),
        at: new Date().toISOString(),
        action: !after ? "delete" : b.cur ? "save" : "create",
        path: b.p,
        display: tilde(b.p),
        bytesBefore: b.cur?.bytes ?? 0,
        bytesAfter: after?.bytes ?? 0,
        snapshot: b.snap,
      });
    }
  }
}

export function canRename(p: string): boolean {
  return !FIXED_NAMES.test(path.basename(p));
}

/** A memory index beside the file, and whether it links to the file by name. */
async function indexLinking(abs: string): Promise<{ path: string; text: string; hash: string } | null> {
  const index = path.join(path.dirname(abs), "MEMORY.md");
  if (index === abs) return null;
  const cur = await readText(index);
  return cur && cur.text.includes(`](${path.basename(abs)})`) ? { path: index, text: cur.text, hash: cur.hash } : null;
}

/** Checks a rename in the same folder, touching nothing. The ending stays, so the agent still reads it. */
export async function planRename(input: { from: string; name: string; extraRoots?: string[] }): Promise<RenamePlan> {
  const from = path.resolve(expandHome(input.from));
  const name = input.name.trim();
  const ext = path.extname(from);
  const to = path.join(path.dirname(from), name.endsWith(ext) ? name : name + ext);
  const out: RenamePlan = { from, to, display: tilde(to), refusal: null, alsoUpdates: [] };
  const refuse = (r: string) => ({ ...out, refusal: r });
  if (!canRename(from)) return refuse(`${path.basename(from)} is read by that name, so renaming it would stop it loading.`);
  if (!name || name === ext) return refuse("Type a name.");
  if (name.includes("/") || name.startsWith(".")) return refuse("A name can't contain / or start with a dot.");
  if (path.extname(to) !== ext) return refuse(`Keep the ${ext} ending, or the agent won't read it.`);
  if (to === from) return refuse("That's its name already.");
  const why = refusalFor(from, input.extraRoots) ?? refusalFor(to, input.extraRoots);
  if (why) return refuse(why);
  // A change of case alone is the same file on a Mac's disk, so it doesn't count as taken.
  if (to.toLowerCase() !== from.toLowerCase() && (await readText(to))) return refuse(`There's already a ${path.basename(to)} here.`);
  const index = await indexLinking(from);
  if (index) out.alsoUpdates.push(tilde(index.path));
  return out;
}

/**
 * Renames a file in its folder: snapshot, move, journal (a delete at the old
 * name and a create at the new one, so History can undo either), then the
 * memory index's link to it, as an ordinary snapshotted write.
 */
export async function applyRename(input: { from: string; name: string; baseHash: string | null; extraRoots?: string[] }): Promise<RenamePlan> {
  if (!(await getPrefs()).allowEdits) throw new WriteError("Editing is turned off. Turn it on in Preferences.", 403, "disabled");
  const plan = await planRename(input);
  if (plan.refusal) throw new WriteError(plan.refusal, 403, "refused");
  const cur = await readText(plan.from);
  if (!cur) throw new WriteError(`${path.basename(plan.from)} isn't there any more.`, 409, "conflict");
  if (cur.hash !== input.baseHash) throw new WriteError(`${path.basename(plan.from)} changed on disk after you opened it.`, 409, "conflict");
  const index = await indexLinking(plan.from);
  const snap = await snapshot(plan.from);
  await fs.rename(plan.from, plan.to);
  const at = new Date().toISOString();
  await journal({ id: randomUUID(), at, action: "delete", path: plan.from, display: tilde(plan.from), bytesBefore: cur.bytes, bytesAfter: 0, snapshot: snap });
  await journal({ id: randomUUID(), at, action: "create", path: plan.to, display: plan.display, bytesBefore: 0, bytesAfter: cur.bytes, snapshot: null });
  if (index) {
    const text = index.text.split(`](${path.basename(plan.from)})`).join(`](${path.basename(plan.to)})`);
    await applyWrite({ path: index.path, content: text, baseHash: index.hash, extraRoots: [path.dirname(index.path)] });
  }
  return plan;
}

export async function listHistory(limit = 300): Promise<HistoryEntry[]> {
  let raw = "";
  try {
    raw = await fs.readFile(HISTORY_FILE, "utf8");
  } catch {
    /* nothing written yet */
  }
  const out: HistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as HistoryEntry);
    } catch {
      /* a torn line from a crash; skip it */
    }
  }
  out.reverse();
  if (out.length < limit) out.push(...(await legacySnapshots(limit - out.length, new Set(out.map((e) => e.snapshot)))));
  return out.slice(0, limit);
}

/** Snapshots written by the previous version of the app, which kept no journal. */
async function legacySnapshots(limit: number, known: Set<string | null>): Promise<HistoryEntry[]> {
  let stamps: string[];
  try {
    stamps = (await fs.readdir(SNAPSHOT_DIR)).sort().reverse();
  } catch {
    return [];
  }
  const out: HistoryEntry[] = [];
  for (const stamp of stamps) {
    const root = path.join(SNAPSHOT_DIR, stamp);
    const walkDir = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walkDir(p);
          continue;
        }
        if (known.has(p)) continue;
        const rel = path.relative(root, p);
        const original = rel.startsWith("_root") ? rel.slice(5) : path.join(HOME, rel);
        const at = stamp.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "$1T$2:$3:$4.$5Z");
        let bytes = 0;
        try {
          bytes = (await fs.stat(p)).size;
        } catch {
          /* raced with a delete */
        }
        out.push({ id: `legacy:${p}`, at, action: "save", path: original, display: tilde(original), bytesBefore: bytes, bytesAfter: 0, snapshot: p });
      }
    };
    await walkDir(root);
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

/** The text a history entry can put back: the version before that write. */
export async function historySnapshot(id: string): Promise<{ entry: HistoryEntry; text: string | null }> {
  const entry = (await listHistory(5000)).find((e) => e.id === id);
  if (!entry) throw new WriteError("That history entry no longer exists.", 404, "refused");
  if (!entry.snapshot) return { entry, text: null };
  if (!isInside(entry.snapshot, SNAPSHOT_DIR)) throw new WriteError("Not a snapshot.", 400, "refused");
  return { entry, text: await fs.readFile(entry.snapshot, "utf8") };
}
