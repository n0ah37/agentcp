import fs from "node:fs/promises";
import path from "node:path";

import type {
  CombinedView,
  FileKind,
  Finding,
  InstructionsMode,
  InstructionsView,
  Level,
  Loads,
  MissingSlot,
  ProjectRef,
  StackEntry,
} from "../../shared/types.ts";
import { LIMITS, checkInstruction, findImports, resolveImport, tally } from "./checks.ts";
import { claudeVersion } from "./claude.ts";
import { HEAVY_DIRS, fileInfo, readText, unreadable, walk } from "./fsx.ts";
import { splitFrontmatter } from "./frontmatter.ts";
import { gitRoot, isIgnored, isTracked, mainRepoRoot } from "./git.ts";
import { lockFor } from "./locks.ts";
import { memoryIndexPath } from "./memory.ts";
import { CLAUDE_DIR, HOME, MANAGED_DIR, isInside, tilde } from "./paths.ts";
import { getPath, readScopes } from "./settings.ts";

/**
 * Reproduces, from the documentation, which instruction files a Claude Code
 * session started in a project reads, in the order it reads them:
 *
 *   managed CLAUDE.md → ~/.claude/CLAUDE.md → ~/.claude/rules → for each
 *   directory from the filesystem root down to the project: CLAUDE.md,
 *   .claude/CLAUDE.md, CLAUDE.local.md (and AGENTS.md when the Project
 *   instructions setting allows) → the project's .claude/rules → auto memory.
 *
 * Imports are nested under the file that imports them. Files that load later
 * (path-scoped rules, nested CLAUDE.md) and files that are not read at all
 * are listed with the reason.
 */

const MODE_PATH = ["pluginConfigs", "agents-md@builtin", "options", "instructionFiles"];
const MODES: InstructionsMode[] = ["claude-md-or-agents-md", "claude-md-and-agents-md", "claude-md", "managed-only"];

export async function instructionsMode(): Promise<{ mode: InstructionsMode; setIn: string | null }> {
  // Claude Code reads this key only from user, --settings and managed files.
  const scopes = (await readScopes(null)).filter((s) => s.scope === "managed" || s.scope === "user");
  for (const s of scopes) {
    const v = getPath(s.data, MODE_PATH);
    if (typeof v === "string" && MODES.includes(v as InstructionsMode)) return { mode: v as InstructionsMode, setIn: tilde(s.path) };
  }
  return { mode: "claude-md-or-agents-md", setIn: null };
}

export async function excludes(project: string | null): Promise<{ pattern: string; file: string }[]> {
  const out: { pattern: string; file: string }[] = [];
  for (const s of await readScopes(project)) {
    const v = getPath(s.data, ["claudeMdExcludes"]);
    if (Array.isArray(v)) for (const p of v) if (typeof p === "string") out.push({ pattern: p, file: tilde(s.path) });
  }
  return out;
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function ancestors(dir: string): string[] {
  const out: string[] = [];
  let d = dir;
  for (;;) {
    out.unshift(d);
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return out;
}

type Draft = {
  id: string;
  path: string;
  kind: FileKind;
  where: string;
  loads: Loads;
  reason: string | null;
  parent: string | null;
  depth: number;
};

function stripComments(text: string): string {
  let fence = false;
  const out: string[] = [];
  let inComment = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) {
      out.push(line);
      continue;
    }
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    if (/^\s*<!--/.test(line)) {
      if (!line.includes("-->")) inComment = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

export type StackResult = {
  levels: Level[];
  entries: StackEntry[];
  findings: Map<string, Finding[]>;
  missing: MissingSlot[];
  mode: InstructionsMode;
  modeSetIn: string | null;
};

export async function resolveStack(project: ProjectRef | null): Promise<StackResult> {
  const { mode, setIn } = await instructionsMode();
  const P = project?.path ?? null;
  const drafts: Draft[] = [];
  const add = (d: Omit<Draft, "id" | "parent" | "depth"> & Partial<Pick<Draft, "parent" | "depth">>) => {
    const id = `${d.loads}:${d.path}`;
    if (drafts.some((x) => x.path === d.path && x.loads !== "not-read")) return null;
    drafts.push({ parent: null, depth: 0, ...d, id });
    return id;
  };
  // A file AgentCP may not read is still there for the agent, so it stays in the list, locked.
  const has = async (p: string) => !!(await readText(p)) || (await unreadable(p));

  const managedOnly = mode === "managed-only";
  const managed = path.join(MANAGED_DIR, "CLAUDE.md");
  if (await has(managed)) add({ path: managed, kind: "managed", where: "Your organization", loads: "launch", reason: null });

  const userMd = path.join(CLAUDE_DIR, "CLAUDE.md");
  if (await has(userMd)) {
    add({ path: userMd, kind: "user-claude-md", where: "Everywhere", loads: managedOnly ? "not-read" : "launch", reason: managedOnly ? "Project instructions is set to managed-only." : null });
  }
  for (const rule of await walk(path.join(CLAUDE_DIR, "rules"), { maxDepth: 6, match: (n) => n.endsWith(".md") })) {
    const t = await readText(rule);
    const scoped = t ? splitFrontmatter(t.text).data.paths !== undefined : false;
    add({
      path: rule,
      kind: "user-rule",
      where: "Everywhere",
      loads: managedOnly ? "not-read" : scoped ? "on-demand" : "launch",
      reason: managedOnly ? "Project instructions is set to managed-only." : scoped ? "Loads when Claude reads a file matching its paths." : null,
    });
  }

  const shadowing: string[] = [];
  let repoRoot: string | null = null;
  let skipMainDir: string | null = null;
  if (P) {
    repoRoot = await gitRoot(P);
    const main = await mainRepoRoot(P);
    // Seen on Claude Code 2.1.285, not documented: from inside a worktree nested
    // in the main checkout, the main checkout's own instruction files are skipped.
    const skipMain = repoRoot && main && repoRoot !== main && isInside(repoRoot, main) ? main : null;
    skipMainDir = skipMain;
    const dirs = ancestors(P);
    for (const d of dirs) {
      if (skipMain && isInside(d, skipMain) && !isInside(d, repoRoot!)) continue;
      for (const n of ["CLAUDE.md", path.join(".claude", "CLAUDE.md"), "CLAUDE.local.md"]) {
        if (await has(path.join(d, n))) shadowing.push(path.join(d, n));
      }
    }
    const readAgents = mode === "claude-md-and-agents-md" || (mode === "claude-md-or-agents-md" && shadowing.length === 0);
    const agentsReason =
      mode === "claude-md"
        ? "Project instructions is set to read CLAUDE.md only."
        : mode === "managed-only"
          ? "Project instructions is set to managed-only."
          : `A CLAUDE.md is on the path, so Claude reads that instead.`;

    for (const d of dirs) {
      const isProject = d === P;
      const label = isProject ? "This project" : d === HOME ? "Home folder" : tilde(d);
      if (skipMain && isInside(d, skipMain) && !isInside(d, repoRoot!)) {
        for (const n of ["CLAUDE.md", "CLAUDE.local.md"]) {
          if (await has(path.join(d, n))) {
            add({ path: path.join(d, n), kind: n === "CLAUDE.md" ? "claude-md" : "local", where: "Main checkout", loads: "not-read", reason: "Claude Code skips the main checkout's files from inside a worktree (observed, not documented)." });
          }
        }
        continue;
      }
      for (const n of ["CLAUDE.md", path.join(".claude", "CLAUDE.md")]) {
        const p = path.join(d, n);
        if (await has(p)) add({ path: p, kind: "claude-md", where: label, loads: managedOnly ? "not-read" : "launch", reason: managedOnly ? "Project instructions is set to managed-only." : null });
      }
      const local = path.join(d, "CLAUDE.local.md");
      if (await has(local)) add({ path: local, kind: "local", where: isProject ? "Only you" : label, loads: managedOnly ? "not-read" : "launch", reason: managedOnly ? "Project instructions is set to managed-only." : null });
      for (const n of ["AGENTS.md", path.join(".claude", "AGENTS.md")]) {
        const p = path.join(d, n);
        if (await has(p)) add({ path: p, kind: "agents-md", where: label, loads: readAgents ? "launch" : "not-read", reason: readAgents ? null : agentsReason });
      }
    }

    for (const rule of await walk(path.join(P, ".claude", "rules"), { maxDepth: 6, match: (n) => n.endsWith(".md") })) {
      const t = await readText(rule);
      const scoped = t ? splitFrontmatter(t.text).data.paths !== undefined : false;
      add({
        path: rule,
        kind: "rule",
        where: "This project",
        loads: managedOnly ? "not-read" : scoped ? "on-demand" : "launch",
        reason: managedOnly ? "Project instructions is set to managed-only." : scoped ? "Loads when Claude reads a file matching its paths." : null,
      });
    }

    // Subdirectories: their instruction files load when Claude reads a file there.
    const nested = await walk(P, {
      maxDepth: 4,
      match: (n, full) => path.dirname(full) !== P && ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"].includes(n),
      skipDir: (n, full) => HEAVY_DIRS.has(n) || (n === "worktrees" && full.endsWith(`${path.sep}.claude${path.sep}worktrees`)),
    });
    for (const p of nested) {
      if (isInside(p, path.join(P, ".claude"))) continue;
      const n = path.basename(p);
      const dir = path.dirname(p);
      const sub = tilde(dir).replace(tilde(P) + "/", "");
      if (n === "AGENTS.md") {
        const own = (await has(path.join(dir, "CLAUDE.md"))) || (await has(path.join(dir, "CLAUDE.local.md")));
        const reads = mode === "claude-md-and-agents-md" || (readAgents && !own);
        add({ path: p, kind: "agents-md", where: sub, loads: reads ? "on-demand" : "not-read", reason: reads ? "Loads when Claude reads a file in this folder." : agentsReason });
      } else {
        add({ path: p, kind: n === "CLAUDE.md" ? "claude-md" : "local", where: sub, loads: managedOnly ? "on-demand" : "on-demand", reason: "Loads when Claude reads a file in this folder." });
      }
    }
  }

  // Imports, depth-first, nested under the file that imports them.
  const tooDeep = new Map<string, number[]>();
  const expand = async (d: Draft, hop: number) => {
    const t = await readText(d.path);
    if (!t) return;
    for (const imp of findImports(t.text)) {
      if (imp.quoted) continue;
      const abs = resolveImport(d.path, imp.target);
      if (!(await has(abs))) continue;
      if (hop >= LIMITS.importHops) {
        tooDeep.set(d.path, [...(tooDeep.get(d.path) ?? []), imp.line]);
        continue;
      }
      if (drafts.some((x) => x.path === abs && x.loads !== "not-read")) continue;
      const child: Draft = {
        id: `${d.loads}:${abs}`,
        path: abs,
        kind: "import",
        where: `Imported by ${path.basename(d.path)}`,
        loads: d.loads,
        reason: d.loads === "launch" ? null : d.reason,
        parent: d.id,
        depth: d.depth + 1,
      };
      const at = drafts.indexOf(d);
      const after = drafts.findIndex((x, i) => i > at && x.depth <= d.depth);
      drafts.splice(after === -1 ? drafts.length : after, 0, child);
      await expand(child, hop + 1);
    }
  };
  for (const d of [...drafts]) if (d.loads !== "not-read") await expand(d, 0);

  // An AGENTS.md already pulled in by an import or a link isn't read twice.
  for (const d of drafts) {
    if (d.kind === "agents-md" && d.loads === "not-read" && drafts.some((x) => x.kind === "import" && x.path === d.path)) {
      d.reason = "Loaded through an @AGENTS.md import instead.";
    }
  }

  // claudeMdExcludes, which never applies to managed files.
  const ex = await excludes(P);
  for (const d of drafts) {
    if (d.kind === "managed" || d.loads === "not-read") continue;
    const hit = ex.find((e) => globToRegExp(e.pattern).test(d.path));
    if (hit) {
      d.loads = "not-read";
      d.reason = `Skipped by claudeMdExcludes in ${hit.file}.`;
    }
  }

  // Auto memory's index loads at the start of every session too.
  if (P) {
    const idx = await memoryIndexPath(P);
    if (idx && (await has(idx.path))) {
      add({ path: idx.path, kind: "memory-index", where: "Auto memory", loads: idx.enabled ? "launch" : "not-read", reason: idx.enabled ? "The first 200 lines or 25 KB." : "Auto memory is turned off." });
    }
  }

  // Each file belongs to one level of the folder hierarchy; an import to the level of the file importing it.
  const byId = new Map(drafts.map((d) => [d.id, d]));
  const levelOf = (d: Draft): string => {
    const up = d.parent ? byId.get(d.parent) : undefined;
    if (up) return levelOf(up);
    if (d.kind === "managed") return "org";
    if (d.kind === "user-claude-md" || d.kind === "user-rule") return "user";
    if (d.kind === "memory-index") return "memory";
    if (d.kind === "rule") return P ? `dir:${P}` : "user";
    let dir = path.dirname(d.path);
    if (path.basename(dir) === ".claude") dir = path.dirname(dir);
    return `dir:${dir}`;
  };

  const findings = new Map<string, Finding[]>();
  const entries: StackEntry[] = [];
  for (const d of drafts) {
    const t = await readText(d.path);
    const info = await fileInfo(d.path, d.kind, lockFor(d.path));
    let f: Finding[] = [];
    if (t && d.kind !== "memory-index") {
      f = checkInstruction({
        path: d.path,
        kind: d.kind === "import" ? "import" : d.kind,
        text: t.text,
        bytes: t.bytes,
        isSymlink: t.isSymlink,
        linkTarget: t.linkTarget,
        repoRoot,
        mode,
        ignored: d.kind === "local" && repoRoot ? await isIgnored(repoRoot, d.path) : undefined,
        tracked: d.kind === "local" && repoRoot ? await isTracked(repoRoot, d.path) : undefined,
        shadowedBy: d.kind === "agents-md" && d.loads === "not-read" && d.reason?.startsWith("A CLAUDE.md") ? shadowing : undefined,
        tooDeep: tooDeep.get(d.path),
      });
    }
    findings.set(d.path, f);
    const sent = t ? (d.kind === "memory-index" ? Math.min(t.bytes, LIMITS.memoryBytes) : Buffer.byteLength(stripComments(t.text))) : 0;
    entries.push({ id: d.id, file: info, level: levelOf(d), where: d.where, loads: d.loads, reason: d.reason, parent: d.parent, depth: d.depth, sentBytes: sent, counts: tally(f) });
  }

  const missing: MissingSlot[] = [];
  if (!(await has(userMd))) {
    missing.push({ id: "user", level: "user", path: userMd, display: tilde(userMd), label: "Your CLAUDE.md", hint: "Instructions for every project on this Mac.", template: "# Preferences\n\n" });
  }
  if (P) {
    const projectMd = path.join(P, "CLAUDE.md");
    if (!(await has(projectMd)) && !(await has(path.join(P, ".claude", "CLAUDE.md")))) {
      const agents = await has(path.join(P, "AGENTS.md"));
      missing.push({
        id: "project",
        level: `dir:${P}`,
        path: projectMd,
        display: tilde(projectMd),
        label: "Project CLAUDE.md",
        hint: agents ? "Claude reads AGENTS.md here today. A CLAUDE.md would replace it unless it imports it." : "Shared with everyone who works in this repository.",
        template: agents ? "@AGENTS.md\n\n## Claude Code\n\n" : "# Project\n\n",
      });
    }
    const local = path.join(P, "CLAUDE.local.md");
    if (!(await has(local))) {
      missing.push({ id: "local", level: `dir:${P}`, path: local, display: tilde(local), label: "CLAUDE.local.md", hint: "Your own notes for this project, kept out of git.", template: "# Just for me\n\n" });
    }
  }

  const levels = buildLevels(new Set([...entries.map((e) => e.level), ...missing.map((m) => m.level)]), P, !!project?.isWorktree, skipMainDir);
  return { levels, entries, findings, missing, mode, modeSetIn: setIn };
}

/**
 * The levels in the order Claude reads them: organization, ~/.claude, each
 * folder from the top of the disk down to the project, the project's
 * subfolders (nested under the folder above them), then auto memory.
 */
function buildLevels(used: Set<string>, P: string | null, worktree: boolean, skipMain: string | null): Level[] {
  const out: Level[] = [];
  if (used.has("org")) out.push({ key: "org", kind: "org", label: "Your organization", covers: "Set by your organization, for everyone on this Mac", path: MANAGED_DIR, depth: 0 });
  out.push({ key: "user", kind: "user", label: "~/.claude", covers: "Every project on this Mac", path: CLAUDE_DIR, depth: 0 });
  if (P) {
    let prev: string | null = null;
    for (const d of ancestors(P)) {
      if (d !== P && !used.has(`dir:${d}`)) continue;
      const label = prev ? path.relative(prev, d) : tilde(d);
      const covers =
        d === P
          ? worktree ? "This worktree" : "This project"
          : skipMain && d === skipMain
            ? "The main checkout, which Claude skips from this worktree"
            : d === HOME
              ? "Every project in your home folder"
              : `Every project under ${tilde(d)}`;
      out.push({ key: `dir:${d}`, kind: d === P ? "project" : "folder", label, covers, path: d, depth: 0 });
      prev = d;
    }
    const subs = [...used].filter((k) => k.startsWith("dir:") && k !== `dir:${P}` && isInside(k.slice(4), P)).map((k) => k.slice(4)).sort();
    for (const d of subs) {
      const parents = subs.filter((o) => o !== d && isInside(d, o));
      const nearest = parents.sort((a, b) => b.length - a.length)[0] ?? P;
      const rel = path.relative(P, d);
      out.push({ key: `dir:${d}`, kind: "subfolder", label: path.relative(nearest, d) + "/", covers: `When Claude works in ${rel}/`, path: d, depth: 1 + parents.length });
    }
  }
  if (used.has("memory")) out.push({ key: "memory", kind: "memory", label: "Auto memory", covers: "Notes Claude keeps for itself about this project", path: null, depth: 0 });
  return out;
}

/** Every file read at launch, in order, as the text Claude receives (block comments removed). */
export async function combinedView(project: ProjectRef | null): Promise<CombinedView> {
  const r = await resolveStack(project);
  const sections: CombinedView["sections"] = [];
  for (const e of r.entries) {
    if (e.loads !== "launch" || !e.file.exists) continue;
    const t = await readText(e.file.path);
    if (!t) continue;
    let text = e.file.kind === "memory-index" ? t.text.split("\n").slice(0, LIMITS.memoryLines).join("\n") : stripComments(t.text);
    if (e.file.kind === "memory-index" && Buffer.byteLength(text) > LIMITS.memoryBytes) text = Buffer.from(text).subarray(0, LIMITS.memoryBytes).toString("utf8");
    sections.push({ path: e.file.path, display: e.file.display, name: e.file.kind === "memory-index" ? "MEMORY.md" : e.file.name, where: e.where, level: e.level, lines: text.split("\n").length, text });
  }
  const bytes = sections.reduce((n, s) => n + Buffer.byteLength(s.text), 0);
  return { sections, totals: { lines: sections.reduce((n, s) => n + s.lines, 0), bytes, tokens: Math.round(bytes / 4) } };
}

export async function instructionsView(project: ProjectRef | null): Promise<InstructionsView> {
  const r = await resolveStack(project);
  const launched = r.entries.filter((e) => e.loads === "launch" && e.file.exists);
  const version = await claudeVersion();
  return {
    project,
    levels: r.levels,
    mode: r.mode,
    modeSetIn: r.modeSetIn,
    claudeVersion: version,
    agentsMdSupported: version ? compareVersion(version, "2.1.277") >= 0 : true,
    entries: r.entries,
    missing: r.missing,
    totals: {
      files: launched.length,
      lines: launched.reduce((n, e) => n + e.file.lines, 0),
      bytes: launched.reduce((n, e) => n + e.sentBytes, 0),
      tokens: Math.round(launched.reduce((n, e) => n + e.sentBytes, 0) / 4),
    },
  };
}

export function compareVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Findings for any one instruction file, for the editor's live checks. */
export async function findingsFor(project: ProjectRef | null, file: string, text?: string): Promise<Finding[]> {
  const r = await resolveStack(project);
  const entry = r.entries.find((e) => e.file.path === file);
  if (text === undefined) return r.findings.get(file) ?? [];
  const t = await readText(file);
  const repoRoot = project ? await gitRoot(project.path) : null;
  const kind = entry?.file.kind ?? guessKind(file);
  return checkInstruction({
    path: file,
    kind,
    text,
    bytes: Buffer.byteLength(text),
    isSymlink: t?.isSymlink ?? false,
    linkTarget: t?.linkTarget ?? null,
    repoRoot,
    mode: r.mode,
    ignored: kind === "local" && repoRoot ? await isIgnored(repoRoot, file) : undefined,
    tracked: kind === "local" && repoRoot ? await isTracked(repoRoot, file) : undefined,
  });
}

export function guessKind(file: string): FileKind {
  const n = path.basename(file);
  if (file === path.join(CLAUDE_DIR, "CLAUDE.md")) return "user-claude-md";
  if (isInside(file, path.join(CLAUDE_DIR, "rules"))) return "user-rule";
  if (file.includes(`${path.sep}.claude${path.sep}rules${path.sep}`)) return "rule";
  if (n === "CLAUDE.local.md") return "local";
  if (n === "AGENTS.md") return "agents-md";
  return "claude-md";
}

export async function readDirSafe(p: string): Promise<string[]> {
  try {
    return await fs.readdir(p);
  } catch {
    return [];
  }
}
