import fs from "node:fs/promises";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

import type {
  CodexEntry,
  CodexMemoriesView,
  CodexRulesView,
  CodexView,
  Definition,
  DefinitionsView,
  DocRef,
  FieldSpec,
  FileKind,
  Finding,
  Level,
  MissingSlot,
  ProjectRef,
  SettingControl,
  SettingRow,
  SettingsView,
  SettingValue,
  SharePlan,
} from "../../shared/types.ts";
import { findImports } from "./checks.ts";
import { CX, RULES, cite, configKeys, defaultBudget, projectIgnoredKeys, ruleText, skillPlaces, type CodexCite } from "./codex-docs.ts";
import { docRef, docSays, plain, section } from "./docs.ts";
import { splitFrontmatter } from "./frontmatter.ts";
import { fileInfo, readText } from "./fsx.ts";
import { resolveStack } from "./instructions.ts";
import { lockFor } from "./locks.ts";
import { CODEX_DIR, HOME, isInside, tilde } from "./paths.ts";
import { setTomlKeys } from "./toml-edit.ts";

/**
 * What OpenAI's Codex reads, and how its settings resolve, for one project.
 * Every rule here is the one Codex's documentation states, cited through
 * codex-docs.ts; nothing is learned from the Codex installed on this Mac.
 * The files themselves are read from disk, because showing them is the point.
 */

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function finding(id: string, severity: Finding["severity"], title: string, detail: string, c: CodexCite, line?: number): Finding {
  return { id, severity, title, detail, ...cite(c), ...(line ? { line } : {}) };
}

function lineOf(text: string, re: RegExp): number | undefined {
  const i = text.split("\n").findIndex((l) => re.test(l));
  return i === -1 ? undefined : i + 1;
}

function get(obj: unknown, dotted: string): unknown {
  let cur = obj;
  for (const k of dotted.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

async function tomlFile(p: string): Promise<{ text: string; hash: string | null; data: Record<string, unknown> | null; error: string | null } | null> {
  const t = await readText(p);
  if (!t) return null;
  try {
    return { text: t.text, hash: t.hash, data: parseToml(t.text) as Record<string, unknown>, error: null };
  } catch (e) {
    return { text: t.text, hash: t.hash, data: null, error: (e as Error).message.split("\n")[0] };
  }
}

const userConfigPath = () => path.join(CODEX_DIR, "config.toml");

async function userConfig(): Promise<Record<string, unknown>> {
  return (await tomlFile(userConfigPath()))?.data ?? {};
}

/**
 * The project root, the way the advanced config guide describes it: walk up
 * from where Codex starts until a folder holds one of `project_root_markers`
 * (`.git` by default). An empty list means the folder itself; no marker found
 * means Codex only checks the current folder.
 */
export async function projectRoot(dir: string): Promise<string> {
  const markers = (await userConfig()).project_root_markers;
  const list = Array.isArray(markers) ? markers.map(String) : [".git"];
  if (!list.length) return dir;
  for (let d = dir; ; d = path.dirname(d)) {
    for (const m of list) if (await exists(path.join(d, m))) return d;
    if (path.dirname(d) === d) return dir;
  }
}

/** The folders from the project root down to `dir`, root first. */
async function chain(dir: string): Promise<string[]> {
  const root = await projectRoot(dir);
  const dirs: string[] = [];
  for (let d = dir; ; d = path.dirname(d)) {
    dirs.unshift(d);
    if (d === root || path.dirname(d) === d) break;
  }
  return dirs;
}

// ------------------------------------------------------------ instructions

function kib(n: number): string {
  return n % 1024 === 0 ? `${n / 1024} KiB` : `${(n / 1024).toFixed(1)} KiB`;
}

async function nonEmpty(p: string): Promise<boolean> {
  const t = await readText(p);
  return !!t && t.text.trim().length > 0;
}

export async function codexView(project: ProjectRef | null): Promise<CodexView> {
  const cfg = await userConfig();
  const budget = typeof cfg.project_doc_max_bytes === "number" ? cfg.project_doc_max_bytes : defaultBudget();
  const fallbacks = Array.isArray(cfg.project_doc_fallback_filenames) ? cfg.project_doc_fallback_filenames.map(String) : [];
  const names = ["AGENTS.override.md", "AGENTS.md", ...fallbacks];

  const levels: Level[] = [{ key: "codex-home", kind: "user", label: tilde(CODEX_DIR), covers: "Every project", path: CODEX_DIR, depth: 0 }];
  const entries: CodexEntry[] = [];
  const missing: MissingSlot[] = [];

  // One folder: the first non-empty candidate is read, the others are listed with why not.
  const folder = async (dir: string, level: string, candidates: string[]) => {
    let winner: string | null = null;
    for (const n of candidates) {
      const p = path.join(dir, n);
      if (!(await exists(p))) continue;
      const info = await fileInfo(p, "codex-instructions", lockFor(p));
      const full = await nonEmpty(p);
      if (!winner && full) {
        winner = n;
        entries.push({ id: `codex:${p}`, file: info, level, loads: "read", reason: null, bytesRead: info.bytes });
      } else {
        entries.push({ id: `codex:${p}`, file: info, level, loads: "not-read", reason: full ? `${winner} is read here instead` : "Empty, so Codex skips it", bytesRead: 0 });
      }
    }
    return winner;
  };

  await folder(CODEX_DIR, "codex-home", ["AGENTS.override.md", "AGENTS.md"]);
  if (!entries.some((e) => e.level === "codex-home" && e.loads === "read")) {
    const p = path.join(CODEX_DIR, "AGENTS.md");
    missing.push({ id: `codex-missing:${p}`, level: "codex-home", path: p, display: tilde(p), label: "AGENTS.md", hint: "Your instructions for Codex in every project", template: "# My instructions for Codex\n\n" });
  }

  const claudeOnly: CodexView["claudeOnly"] = [];
  let share: CodexView["share"] = null;
  if (project) {
    const dirs = await chain(project.path);
    let used = 0;
    for (const [i, dir] of dirs.entries()) {
      const key = `codex-dir:${dir}`;
      const isProject = dir === project.path;
      levels.push({
        key,
        kind: isProject ? "project" : "folder",
        label: i === 0 ? tilde(dir) : path.relative(dirs[i - 1], dir) + "/",
        covers: i === 0 ? (isProject ? "This project" : "This repository") : isProject ? "This project" : "Every folder below",
        path: dir,
        depth: i,
      });
      const winner = await folder(dir, key, names);
      const read = winner ? entries.find((e) => e.level === key && e.loads === "read") : undefined;
      if (read) {
        const left = budget - used;
        if (left <= 0) {
          read.loads = "dropped";
          read.bytesRead = 0;
          read.reason = `Codex's ${kib(budget)} for project instructions ran out before this file`;
        } else if (read.file.bytes > left) {
          read.loads = "cut";
          read.bytesRead = left;
          read.reason = `Only the first ${kib(left)} fit in Codex's ${kib(budget)}`;
        }
        used += read.bytesRead;
      }
      if (isProject && !entries.some((e) => e.level === key && e.loads !== "not-read")) {
        const p = path.join(dir, "AGENTS.md");
        missing.push({ id: `codex-missing:${p}`, level: key, path: p, display: tilde(p), label: "AGENTS.md", hint: "Instructions Codex reads in this project", template: "# " + path.basename(dir) + "\n\n" });
      }
    }

    // Claude's instruction files in these folders that Codex never reads.
    const stack = await resolveStack(project);
    for (const e of stack.entries) {
      const inChain = dirs.some((d) => path.dirname(e.file.path).replace(/\/\.claude$/, "") === d);
      if (inChain && e.file.exists && (e.file.kind === "claude-md" || e.file.kind === "local") && e.loads !== "not-read") {
        claudeOnly.push({ path: e.file.path, display: e.file.display, lines: e.file.lines });
      }
    }
    const own = path.join(project.path, "CLAUDE.md");
    const agents = path.join(project.path, "AGENTS.md");
    const ownText = (await readText(own))?.text ?? "";
    const alreadyImports = /^\s*@AGENTS\.md\s*$/m.test(ownText);
    const agentsText = (await readText(agents))?.text ?? null;
    // An AGENTS.md that is the CLAUDE.md's copy is a share left half done: only the second step remains.
    if (ownText.trim() && !alreadyImports && (agentsText === null || agentsText === ownText)) {
      share = { from: own, to: agents, imports: findImports(ownText).length, finish: agentsText !== null };
    }
  }

  const read = entries.filter((e) => e.loads === "read" || e.loads === "cut");
  return {
    installed: await exists(CODEX_DIR),
    home: tilde(CODEX_DIR),
    config: { path: userConfigPath(), display: tilde(userConfigPath()), maxBytes: budget, fallbacks, exists: await exists(userConfigPath()) },
    levels,
    entries,
    missing,
    totals: { files: read.length, bytes: read.filter((e) => e.level !== "codex-home").reduce((n, e) => n + e.bytesRead, 0), budget },
    claudeOnly,
    share,
    rules: [RULES.globalOne, RULES.perFolder, RULES.budget, RULES.rootMarkers].map((r) => ({ text: ruleText(r), ...cite(r) })),
  };
}

/**
 * Sharing a project's CLAUDE.md with Codex, the way Claude Code's docs lay it
 * out ("Share one file with other coding tools"): the instructions move to an
 * AGENTS.md, which Codex reads, and CLAUDE.md becomes `@AGENTS.md` plus a
 * place for anything only Claude should read. Two writes, each reviewed.
 */
export async function sharePlan(project: ProjectRef): Promise<SharePlan> {
  const view = await codexView(project);
  if (!view.share) throw new Error("This project has no CLAUDE.md to share, or already has an AGENTS.md.");
  const from = await readText(view.share.from);
  if (!from) throw new Error("CLAUDE.md couldn't be read.");
  const claude = "@AGENTS.md\n\n<!-- The instructions above live in AGENTS.md, which Codex reads too. Put anything only Claude should read below. -->\n";
  const point = { path: view.share.from, content: claude, baseHash: from.hash ?? null, title: "Point CLAUDE.md at AGENTS.md?" };
  return {
    steps: view.share.finish ? [point] : [{ path: view.share.to, content: from.text, baseHash: null, title: "Create AGENTS.md from CLAUDE.md?" }, point],
    note: view.share.imports ? `CLAUDE.md has ${view.share.imports} @ import${view.share.imports === 1 ? "" : "s"}. Codex doesn't follow imports, so it reads those lines as plain text.` : null,
  };
}

// ------------------------------------------------------------------ skills

/** The fields a SKILL.md needs, as the skills guide states them. */
function skillFields(): FieldSpec[] {
  const req = docSays(CX.skills, "The `SKILL.md` file must include `name` and `description`.");
  return [
    { name: "name", required: req ? "yes" : "recommended", description: "The skill's name." },
    { name: "description", required: req ? "yes" : "recommended", description: "When Codex should use it. Codex matches your request against this." },
  ];
}

/**
 * The skills Codex can use, from the folders the skills guide lists
 * ("Where Codex loads local skills"): `.agents/skills` in each folder from
 * where Codex starts up to the repository root, `$HOME/.agents/skills`, and
 * `/etc/codex/skills`. A skill turned off in `[[skills.config]]` is shown
 * off. Custom prompts in ~/.codex/prompts are listed too, marked deprecated
 * as the docs mark them.
 */
export async function codexSkills(project: ProjectRef | null): Promise<{ items: Definition[]; locations: DefinitionsView["locations"]; fields: FieldSpec[]; doc: DocRef; findings: Finding[] }> {
  const places: { dir: string; label: string; source: Definition["source"] }[] = [];
  const patterns = skillPlaces();
  const dirs = project ? await chain(project.path) : [];
  const seen = new Set<string>();
  const add = (dir: string, label: string, source: Definition["source"]) => {
    if (seen.has(dir)) return;
    seen.add(dir);
    places.push({ dir, label, source });
  };
  for (const p of patterns) {
    if (p.pattern.startsWith("$CWD/../") && project) {
      for (const d of dirs.slice(1, -1).reverse()) add(path.join(d, ".agents", "skills"), `${path.relative(d, project.path)}/ and below`, "project");
    } else if (p.pattern.startsWith("$CWD/") && project) add(path.join(project.path, p.pattern.slice(5)), "This project", "project");
    else if (p.pattern.startsWith("$REPO_ROOT/") && project && dirs.length > 1) add(path.join(dirs[0], p.pattern.slice(11)), "Repository", "project");
    else if (p.pattern.startsWith("$HOME/")) add(path.join(HOME, p.pattern.slice(6)), "User", "user");
    else if (p.pattern.startsWith("/")) add(p.pattern, "Admin", "managed");
  }

  const cfg = await userConfig();
  const off = new Set(
    (Array.isArray(get(cfg, "skills.config")) ? (get(cfg, "skills.config") as { path?: string; enabled?: boolean }[]) : [])
      .filter((e) => e.enabled === false && typeof e.path === "string")
      .map((e) => path.resolve(e.path!.replace(/^~(?=\/)/, HOME))),
  );

  const items: Definition[] = [];
  const locations: DefinitionsView["locations"] = [];
  for (const p of places) {
    locations.push({ label: p.label, path: p.dir, display: tilde(p.dir), exists: await exists(p.dir) });
    let names: string[];
    try {
      names = (await fs.readdir(p.dir, { withFileTypes: true })).filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith(".")).map((e) => e.name);
    } catch {
      continue;
    }
    for (const n of names.sort()) {
      const file = path.join(p.dir, n, "SKILL.md");
      const t = await readText(file);
      if (!t) continue;
      const fm = splitFrontmatter(t.text);
      const lock = p.source === "managed" ? { editable: false, lockedBecause: "Installed for everyone on this Mac; not written here." } : lockFor(file);
      const problems = (fm.data.name ? 0 : 1) + (fm.data.description ? 0 : 1);
      items.push({
        file: await fileInfo(file, "codex-skill", lock),
        name: String(fm.data.name ?? n),
        description: String(fm.data.description ?? ""),
        where: p.label,
        source: p.source,
        plugin: null,
        counts: { problem: problems, warning: 0, note: 0 },
        active: !off.has(file),
      });
    }
  }

  // Custom prompts: deprecated in favour of skills, still read by Codex.
  const promptsDir = path.join(CODEX_DIR, "prompts");
  try {
    for (const n of (await fs.readdir(promptsDir)).filter((x) => x.endsWith(".md")).sort()) {
      const file = path.join(promptsDir, n);
      const t = await readText(file);
      const fm = splitFrontmatter(t?.text ?? "");
      items.push({
        file: await fileInfo(file, "codex-skill", lockFor(file)),
        name: `/prompts:${n.replace(/\.md$/, "")}`,
        description: String(fm.data.description ?? ""),
        where: "Custom prompts (deprecated)",
        source: "user",
        plugin: null,
        counts: { problem: 0, warning: 1, note: 0 },
      });
    }
  } catch {
    /* none */
  }

  // The skills list Codex starts with has a budget: 2% of the context window, or 8,000 characters.
  const findings: Finding[] = [];
  const listed = items.filter((i) => i.active !== false && !i.name.startsWith("/prompts:"));
  const chars = listed.reduce((n, i) => n + i.name.length + i.description.length + i.file.path.length, 0);
  if (chars > 8000) {
    findings.push(
      finding("skills:budget", "note", `Your ${listed.length} skills come to ${chars.toLocaleString("en-US")} characters of names, descriptions and paths.`, "When the model's context size isn't known, Codex keeps that list to 8,000 characters and shortens descriptions first, so put the trigger words at the start of each description.", { slug: CX.skills, says: "or 8,000 characters when the context window is unknown" }),
    );
  }
  if (items.some((i) => i.name.startsWith("/prompts:"))) {
    findings.push(finding("prompts:deprecated", "warning", "Custom prompts are deprecated.", "Codex still runs them as /prompts: commands. Make each one a skill instead, which Codex can also pick on its own.", { slug: "codex/custom-prompts", says: "Custom prompts are deprecated." }));
  }
  return { items, locations, fields: skillFields(), doc: docRef(CX.skills, "where-codex-loads-local-skills"), findings };
}

// --------------------------------------------------------------- subagents

/** The custom agent file schema table: field, type, required, purpose. */
function agentFields(): FieldSpec[] {
  const s = section(CX.subagents, "custom-agent-file-schema") ?? "";
  const out: FieldSpec[] = [];
  for (const row of s.split("\n")) {
    const m = /^\|\s*`(\w+)`\s*\|\s*[^|]*\|\s*(Yes|No)\s*\|\s*([^|]+?)\s*\|/.exec(row);
    if (m) out.push({ name: m[1], required: m[2] === "Yes" ? "yes" : "no", description: plain(m[3]) });
  }
  return out;
}

/** "Codex ships with built-in agents": the bullet list under Custom agents. */
function builtinAgents(): { name: string; description: string }[] {
  const s = section(CX.subagents, "custom-agents") ?? "";
  return [...s.matchAll(/^- `([\w-]+)`: (.+)$/gm)].map((m) => ({ name: m[1], description: plain(m[2]).replace(/\.$/, "") }));
}

/** Codex's custom agents: one TOML file each, in ~/.codex/agents and a project's .codex/agents. */
export async function codexAgents(project: ProjectRef | null): Promise<{ items: Definition[]; locations: DefinitionsView["locations"]; fields: FieldSpec[]; doc: DocRef }> {
  const places: { dir: string; label: string; source: Definition["source"] }[] = [];
  if (project) places.push({ dir: path.join(project.path, ".codex", "agents"), label: "This project", source: "project" });
  places.push({ dir: path.join(CODEX_DIR, "agents"), label: "User", source: "user" });
  const fields = agentFields();
  const required = fields.filter((f) => f.required === "yes").map((f) => f.name);
  const items: Definition[] = [];
  const locations: DefinitionsView["locations"] = [];
  for (const p of places) {
    locations.push({ label: p.label, path: p.dir, display: tilde(p.dir), exists: await exists(p.dir) });
    let names: string[];
    try {
      names = (await fs.readdir(p.dir)).filter((n) => n.endsWith(".toml")).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      const file = path.join(p.dir, n);
      const t = await tomlFile(file);
      if (!t) continue;
      const data = t.data ?? {};
      const missing = t.data ? required.filter((k) => !data[k]).length : 1;
      items.push({
        file: await fileInfo(file, "codex-agent", lockFor(file)),
        name: String(data.name ?? n.replace(/\.toml$/, "")),
        description: String(data.description ?? ""),
        where: p.label,
        source: p.source,
        plugin: null,
        counts: { problem: missing, warning: 0, note: 0 },
      });
    }
  }
  const custom = new Set(items.map((i) => i.name));
  for (const b of builtinAgents()) {
    items.push({
      file: { path: `builtin:codex:${b.name}`, display: "Built into Codex", name: b.name, kind: "codex-agent", exists: true, bytes: 0, lines: 0, modified: null, isSymlink: false, linkTarget: null, hash: null, editable: false, lockedBecause: "Built into Codex.", unreadable: false },
      name: b.name,
      description: b.description,
      where: "Built in",
      source: "builtin",
      plugin: null,
      counts: { problem: 0, warning: 0, note: 0 },
      shadowedBy: custom.has(b.name) ? b.name : null,
    });
  }
  return { items, locations, fields, doc: docRef(CX.subagents, "custom-agents") };
}

// ---------------------------------------------------------------- memories

/** What Codex keeps in ~/.codex/memories: generated state, fine to read, not meant for hand edits. */
export async function codexMemories(): Promise<CodexMemoriesView> {
  const dir = path.join(CODEX_DIR, "memories");
  const files: CodexMemoriesView["files"] = [];
  try {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isFile()) {
        const t = await readText(p);
        files.push({ path: p, display: tilde(p), name: e.name, lines: t?.lines ?? 0, bytes: t?.bytes ?? 0, modified: t?.modified ?? null, count: null });
      } else if (e.isDirectory() && !e.name.startsWith(".")) {
        const n = (await fs.readdir(p).catch(() => [] as string[])).length;
        files.push({ path: p, display: tilde(p), name: `${e.name}/`, lines: 0, bytes: 0, modified: null, count: n });
      }
    }
  } catch {
    /* no memories yet */
  }
  const v = get(await userConfig(), "features.memories");
  files.sort((a, b) => Number(!!a.count) - Number(!!b.count) || a.name.localeCompare(b.name));
  return {
    dir: tilde(dir),
    files,
    enabled: typeof v === "boolean" ? v : null,
    // The feature flags table gives memories' default.
    enabledByDefault: featureFlags().find((f) => f.key === "memories")?.default === "true",
    doc: docRef(CX.memories, "local-memory-storage"),
    rules: [RULES.memoryDir, RULES.memoryGenerated].map((r) => ({ text: ruleText(r), ...cite(r) })),
  };
}

// ------------------------------------------------------------------- rules

/**
 * Codex's `.rules` files: Starlark `prefix_rule(...)` calls under `rules/`
 * next to each config layer, ~/.codex/rules and a trusted project's
 * .codex/rules (rules guide). Each rule's pattern, decision and reason are
 * read out so the list can be scanned; the file opens in the editor.
 */
export async function codexRules(project: ProjectRef | null): Promise<CodexRulesView> {
  const trusted = project ? (await trustFor(project.path)).level === "trusted" : false;
  const dirs: { dir: string; label: string; scope: "user" | "project"; used: boolean }[] = [{ dir: path.join(CODEX_DIR, "rules"), label: "User", scope: "user", used: true }];
  if (project) {
    const root = (await chain(project.path))[0];
    dirs.push({ dir: path.join(root, ".codex", "rules"), label: "This project", scope: "project", used: trusted });
  }
  const files: CodexRulesView["files"] = [];
  for (const d of dirs) {
    let names: string[] = [];
    try {
      names = (await fs.readdir(d.dir)).filter((n) => n.endsWith(".rules")).sort();
    } catch {
      /* none */
    }
    if (!names.length) files.push({ path: path.join(d.dir, "default.rules"), display: tilde(path.join(d.dir, "default.rules")), label: d.label, scope: d.scope, exists: false, used: d.used, rules: [] });
    for (const n of names) {
      const p = path.join(d.dir, n);
      const t = await readText(p);
      files.push({ path: p, display: tilde(p), label: d.label, scope: d.scope, exists: true, used: d.used, rules: parseRules(t?.text ?? "") });
    }
  }
  const c = (r: CodexCite) => ({ text: ruleText(r), ...cite(r) });
  return {
    files,
    doc: docRef("codex/agent-configuration/rules", "create-a-rules-file"),
    rules: [
      c({ slug: "codex/agent-configuration/rules", anchor: "understand-rule-fields", says: "Codex applies the most restrictive decision when more than one rule matches" }),
      c({ slug: "codex/agent-configuration/rules", anchor: "create-a-rules-file", says: "Project-local rules under `<repo>/.codex/rules/` load only when the project `.codex/` layer is trusted." }),
    ],
    template: '# Prompt before running commands that start with this prefix outside the sandbox.\nprefix_rule(\n    pattern = ["gh", "pr", "view"],\n    decision = "prompt",\n    justification = "Viewing PRs is allowed with approval",\n)\n',
  };
}

export function parseRules(text: string): CodexRulesView["files"][number]["rules"] {
  const out: CodexRulesView["files"][number]["rules"] = [];
  const re = /prefix_rule\s*\(/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 1;
    let i = m.index + m[0].length;
    let quote: string | null = null;
    for (; i < text.length && depth; i++) {
      const c = text[i];
      if (quote) {
        if (c === "\\") i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "#") i = text.indexOf("\n", i) === -1 ? text.length : text.indexOf("\n", i);
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    const body = text.slice(m.index, i);
    const arr = /pattern\s*=\s*\[([\s\S]*?)\]\s*,?\s*(?:\n|#|\w+\s*=)/.exec(body)?.[1] ?? /pattern\s*=\s*\[([\s\S]*)\]/.exec(body)?.[1] ?? "";
    const pattern = splitTop(arr).map((part) => {
      const strs = [...part.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((s) => s[1] ?? s[2]);
      return strs.join("|");
    }).filter(Boolean);
    out.push({
      pattern,
      decision: (/decision\s*=\s*["'](\w+)["']/.exec(body)?.[1] as "allow" | "prompt" | "forbidden" | undefined) ?? "allow",
      justification: /justification\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1] ?? null,
      line: text.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

/** Splits a Starlark list body at its top-level commas. */
function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  let quote: string | null = null;
  for (const c of s) {
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

// ---------------------------------------------------------------- settings

/** This project's trust, from `[projects."<path>"]` in ~/.codex/config.toml. */
export async function trustFor(dir: string): Promise<{ path: string; level: string | null }> {
  const projects = ((await userConfig()).projects ?? {}) as Record<string, { trust_level?: string }>;
  const real = await fs.realpath(dir).catch(() => dir);
  const root = await projectRoot(dir);
  const level = [dir, real, root].map((p) => projects[p]?.trust_level).find(Boolean) ?? null;
  return { path: tilde(dir), level };
}

/** The "Common feature flags" table in config basics: key, default, maturity, description. */
export function featureFlags(): { key: string; default: string; maturity: string; description: string }[] {
  const s = section(CX.configBasic, "common-feature-flags") ?? "";
  const out: { key: string; default: string; maturity: string; description: string }[] = [];
  for (const row of s.split("\n")) {
    const m = /^\|\s*`(\w+)`\s*\|\s*([^|]+?)\s*\|\s*(\w+)\s*\|\s*(.+?)\s*\|\s*$/.exec(row);
    if (m) out.push({ key: m[1], default: plain(m[2].replace(/`/g, "")), maturity: m[3], description: plain(m[4].replace(/`/g, "")) });
  }
  return out;
}

/** The keys config basics shows under "Common configuration options", in its order. */
function commonKeys(known: Set<string>): string[] {
  const s = section(CX.configBasic, "common-configuration-options") ?? "";
  const out: string[] = [];
  for (const block of s.matchAll(/```toml\n([\s\S]*?)```/g)) {
    let table = "";
    for (const l of block[1].split("\n")) {
      const h = /^\s*\[([\w.]+)\]/.exec(l);
      if (h) table = h[1];
      const k = /^\s*([\w]+)\s*=/.exec(l);
      if (k) {
        const key = table ? `${table}.${k[1]}` : k[1];
        if (known.has(key) && !out.includes(key)) out.push(key);
      }
    }
  }
  return out;
}

/** A shelf for each key, by what it's about. A grouping for reading, not a fact from the docs. */
function topicFor(key: string): string {
  const top = key.split(".")[0];
  if (/^(model|review_model|oss_provider|personality|service_tier|plan_mode_reasoning_effort)/.test(top)) return "Model and responses";
  if (/^(approval_policy|approvals_reviewer|auto_review|allow_login_shell|sandbox_mode|sandbox_workspace_write|windows|default_permissions|permissions|network)/.test(top)) return "Approvals and sandbox";
  if (top === "features") return "Feature flags";
  if (/^(instructions|developer_instructions|model_instructions_file|compact_prompt|experimental_compact_prompt_file|project_doc|project_root_markers)/.test(top)) return "Instructions and context";
  if (top === "agents") return "Subagents";
  if (top === "memories") return "Memories";
  if (/^(skills|plugins|marketplaces|apps|tool_suggest)$/.test(top)) return "Skills, plugins and apps";
  if (/^mcp/.test(top)) return "MCP";
  if (/^(tui|notice|hide_|show_|file_opener|notify|check_for_update)/.test(top)) return "Interface and notifications";
  if (/^(shell_environment_policy|shell)/.test(top)) return "Commands and environment";
  if (/^(web_search|tools|browser_use|computer_use)/.test(top)) return "Web, browser and computer use";
  if (/^(history|log_dir|sqlite_home)/.test(top)) return "History and logs";
  if (/^(otel|analytics|feedback)/.test(top)) return "Privacy and telemetry";
  return "Other";
}

function controlFor(type: string): SettingControl {
  const t = type.trim();
  if (t === "boolean") return { type: "boolean" };
  if (/^(number|integer)/.test(t)) return { type: "number" };
  if (/^string/.test(t)) return { type: "string" };
  // Split at the top-level bars only: approval_policy is `on-request | never | { granular = { … } }`.
  const opts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of t) {
    if (ch === "{" || ch === "<") depth++;
    if (ch === "}" || ch === ">") depth--;
    if (ch === "|" && depth === 0) {
      opts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  opts.push(cur.trim());
  const simple = opts.filter((o) => /^[\w:.-]+$/.test(o));
  // A choice of words, maybe with one structured form beside them, is a menu of the words; the structured form is edited in the file.
  if (simple.length > 1 && opts.length - simple.length <= 1) return { type: "enum", options: simple.map((o) => ({ value: o, label: o })) };
  return { type: "json" };
}

const DEFAULT_RE = /\((?:default(?:s to)?:?|defaults? to)\s*([^)]+)\)|Defaults to\s+`?([^`.]+)`?/i;

export type CodexLayer = NonNullable<SettingsView["codex"]>["layers"][number];

/**
 * Codex's settings, as one list like Claude Code's: every `config.toml` key
 * in the configuration reference, its control picked from its type, and the
 * value in force from the layers Codex reads, in its order (config basics:
 * a trusted project's .codex/config.toml from the root down, over your
 * ~/.codex/config.toml, over the system file). Profile files are listed and
 * shown but only apply with `--profile`.
 */
export async function codexSettings(project: ProjectRef | null): Promise<SettingsView> {
  const layers: CodexLayer[] = [];
  const findings: Record<string, Finding[]> = {};
  const loaded: { layer: CodexLayer; data: Record<string, unknown> }[] = [];
  const ignored = new Set(projectIgnoredKeys());

  const read = async (p: string, label: string, kind: CodexLayer["kind"], used: boolean, note: string | null = null) => {
    const t = await tomlFile(p);
    const out: Finding[] = [];
    if (t?.error) out.push(finding("toml:parse", "problem", "This file isn't valid TOML.", `Codex can't read it, so none of its settings apply. ${t.error}`, { slug: CX.configBasic, says: "config.toml" }, Number(/line (\d+)/.exec(t.error)?.[1]) || undefined));
    const data = t?.data;
    if (data && t) {
      const ap = data.approval_policy;
      if (ap === "untrusted") out.push(finding("ap:untrusted", "problem", 'approval_policy = "untrusted" is no longer supported.', "It can stop Codex from starting. Remove it; a project marked untrusted under [projects] keeps the stricter behaviour.", RULES.untrusted, lineOf(t.text, /^\s*approval_policy\s*=/)));
      if (ap === "on-failure") out.push(finding("ap:on-failure", "warning", 'approval_policy = "on-failure" is deprecated.', "Use on-request when you're watching, or never for runs nobody watches.", RULES.onFailure, lineOf(t.text, /^\s*approval_policy\s*=/)));
      if (kind === "user" && data.profiles && typeof data.profiles === "object") {
        for (const name of Object.keys(data.profiles as object)) {
          out.push(finding(`profiles:${name}`, "warning", `[profiles.${name}] isn't read any more.`, `--profile ${name} reads ~/.codex/${name}.config.toml. Move these keys there, at the top level.`, RULES.profileTables, lineOf(t.text, new RegExp(`^\\s*\\[profiles\\.${name}\\]`))));
        }
      }
      if (kind === "user" && typeof data.profile === "string") out.push(finding("profile:selector", "warning", `profile = "${data.profile}" isn't supported any more.`, "Start Codex with --profile instead.", RULES.profileSelector, lineOf(t.text, /^\s*profile\s*=/)));
      if (kind === "project") for (const k of [...ignored].filter((k) => k in data)) out.push(finding(`ignored:${k}`, "warning", `${k} is ignored in a project's config.`, "Codex reads it only from ~/.codex/config.toml.", RULES.projectIgnored, lineOf(t.text, new RegExp(`^\\s*(\\[)?${k}\\b`))));
      if (get(data, "features.codex_hooks") !== undefined) out.push(finding("hooks:alias", "note", "features.codex_hooks is the old name.", "Use features.hooks.", RULES.hooksAlias, lineOf(t.text, /codex_hooks/)));
      if (data.sandbox_mode !== undefined && data.default_permissions !== undefined) out.push(finding("sandbox:both", "warning", "Both sandbox_mode and default_permissions are set.", "The configuration reference says not to combine them; keep one.", RULES.sandboxBoth, lineOf(t.text, /^\s*default_permissions\s*=/)));
      if (data.experimental_instructions_file !== undefined) out.push(finding("instructions:old", "warning", "experimental_instructions_file is the old name.", "Rename it to model_instructions_file.", RULES.instructionsFile, lineOf(t.text, /experimental_instructions_file/)));
      if (kind === "project" && !used) out.push(finding("trust:untrusted", "warning", "Codex doesn't read this file.", "It reads a project's .codex layer only in a project you've trusted.", RULES.trust));
    }
    const layer: CodexLayer = { path: p, display: tilde(p), label, kind, exists: !!t, used, problems: out.filter((f) => f.severity !== "note").length, note };
    layers.push(layer);
    findings[p] = out;
    if (data) loaded.push({ layer, data });
  };

  await read(userConfigPath(), "User", "user", true);
  let trust: { path: string; level: string | null } | null = null;
  let projectFile: string | null = null;
  if (project) {
    trust = await trustFor(project.path);
    const trusted = trust.level === "trusted";
    const dirs = await chain(project.path);
    for (const d of dirs) {
      const p = path.join(d, ".codex", "config.toml");
      if (d === project.path) projectFile = p;
      if ((await exists(p)) || d === project.path) await read(p, d === project.path ? "This project" : tilde(d), "project", trusted, trusted ? null : "Read only once you trust the project");
    }
  }
  try {
    for (const n of (await fs.readdir(CODEX_DIR)).filter((n) => n.endsWith(".config.toml")).sort()) {
      await read(path.join(CODEX_DIR, n), `Profile: ${n.replace(/\.config\.toml$/, "")}`, "profile", false, `Only with --profile ${n.replace(/\.config\.toml$/, "")}`);
    }
  } catch {
    /* no ~/.codex */
  }
  if (await exists("/etc/codex/config.toml")) await read("/etc/codex/config.toml", "System", "system", true, docSays(RULES.systemConfig.slug, RULES.systemConfig.says) ? null : "The docs no longer list this file");

  // Lowest precedence first, so a later layer overwrites: system, your config, then project files root → here.
  const order = loaded.filter((l) => l.layer.used && l.layer.kind !== "profile").sort((a, b) => rank(a.layer) - rank(b.layer) || a.layer.path.length - b.layer.path.length);
  const specs = configKeys().filter((k) => !k.key.includes("<"));
  const flags = featureFlags();
  const known = new Map(specs.map((s) => [s.key, s]));
  for (const f of flags) if (!known.has(`features.${f.key}`)) known.set(`features.${f.key}`, { key: `features.${f.key}`, type: "boolean", description: f.description });

  const doc = docRef(CX.configRef, "configtoml");
  const rows: SettingRow[] = [...known.values()].map((s) => {
    const flag = s.key.startsWith("features.") ? flags.find((f) => `features.${f.key}` === s.key) : undefined;
    const values: SettingValue[] = [];
    for (const l of [...order].reverse()) {
      if (l.layer.kind === "project" && [...ignored].some((u) => s.key === u || s.key.startsWith(u + "."))) continue;
      const v = get(l.data, s.key);
      if (v !== undefined) values.push({ scope: l.layer.kind === "project" ? "project" : l.layer.kind === "user" ? "user" : "managed", file: l.layer.display, value: v instanceof Date ? v.toISOString() : v, label: l.layer.label });
    }
    for (const l of loaded.filter((x) => x.layer.kind === "profile")) {
      const v = get(l.data, s.key);
      if (v !== undefined) values.push({ scope: "managed", file: l.layer.display, value: v instanceof Date ? v.toISOString() : v, label: l.layer.label, inactive: true });
    }
    const userOnly = [...ignored].some((u) => s.key === u || s.key.startsWith(u + "."));
    const dm = DEFAULT_RE.exec(s.description);
    return {
      key: s.key,
      path: s.key.split("."),
      description: flag ? `${flag.description}${flag.maturity !== "Stable" ? ` (${flag.maturity.toLowerCase()})` : ""}` : s.description,
      topic: topicFor(s.key),
      scopeText: userOnly ? "Your config only" : "",
      allowed: userOnly ? ["user"] : ["user", "project"],
      typeText: s.type,
      defaultText: flag ? flag.default : dm ? (dm[1] ?? dm[2] ?? "").trim() : "",
      overridesText: null,
      control: controlFor(s.type),
      doc,
      values,
      effective: values.find((v) => !v.inactive) ?? null,
      merges: false,
    };
  });

  const mcp: NonNullable<SettingsView["codex"]>["mcp"] = [];
  for (const l of order) {
    const servers = (l.data.mcp_servers ?? {}) as Record<string, Record<string, unknown>>;
    for (const [name, s] of Object.entries(servers)) {
      const row = { name, run: String(s.url ?? [s.command, ...((s.args as string[]) ?? [])].filter(Boolean).join(" ")), enabled: s.enabled !== false, from: l.layer.label };
      const i = mcp.findIndex((m) => m.name === name);
      if (i === -1) mcp.push(row);
      else mcp[i] = row;
    }
  }
  const topics = [...new Set(rows.map((r) => r.topic))].sort((a, b) => (a === "Other" ? 1 : b === "Other" ? -1 : a.localeCompare(b)));
  return {
    project,
    files: layers.filter((l) => l.kind === "user" || l.kind === "project").map((l) => ({ scope: l.kind === "project" ? "project" : "user", path: l.path, display: l.display, exists: l.exists, error: findings[l.path]?.find((f) => f.id === "toml:parse")?.detail ?? null })),
    topics,
    featured: commonKeys(new Set(known.keys())),
    rows,
    capturedAt: null,
    agent: "codex",
    codex: { layers, trust, mcp, findings, projectFile, doc, permissions: permissionPresets() },
  };
}

function rank(l: CodexLayer): number {
  return l.kind === "system" ? 0 : l.kind === "user" ? 1 : 2;
}

/**
 * The combinations in "Common sandbox and approval combinations"
 * (agent-approvals-security), as presets: what each sets in config.toml.
 */
function permissionPresets(): NonNullable<SettingsView["codex"]>["permissions"] {
  const s = section("codex/agent-approvals-security", "common-sandbox-and-approval-combinations") ?? "";
  const out: NonNullable<SettingsView["codex"]>["permissions"] = [];
  for (const row of s.split("\n")) {
    const m = /^\|\s*([^|`]+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/.exec(row);
    if (!m || /^-+$|^Intent$/.test(m[1])) continue;
    const flags = m[2];
    const sandbox = /--sandbox ([\w-]+)/.exec(flags)?.[1];
    const approval = /--ask-for-approval ([\w-]+)/.exec(flags)?.[1];
    const reviewer = /approvals_reviewer\s*=\s*"?([\w_]+)/.exec(flags)?.[1];
    if (/dangerously-bypass/.test(flags)) {
      out.push({ name: m[1], effect: plain(m[3].replace(/<[^>]+>/g, "")), sets: { sandbox_mode: "danger-full-access", approval_policy: "never", approvals_reviewer: null }, byDefault: false });
    } else if (sandbox || /no flags needed/.test(flags)) {
      out.push({ name: m[1], effect: plain(m[3]), sets: { sandbox_mode: sandbox ?? "workspace-write", approval_policy: approval ?? "on-request", approvals_reviewer: reviewer ?? null }, byDefault: /no flags needed/.test(flags) });
    }
  }
  return out;
}

/** The new text of a Codex config.toml with keys set or removed, for the usual review and save. */
export async function planCodexSettings(input: { project: ProjectRef | null; scope: "user" | "project"; sets: { key: string; value: unknown }[] }): Promise<{ path: string; content: string; baseHash: string | null }> {
  let file = userConfigPath();
  if (input.scope === "project") {
    if (!input.project) throw new Error("Pick a project first.");
    file = path.join(input.project.path, ".codex", "config.toml");
    const ignored = new Set(projectIgnoredKeys());
    const bad = input.sets.find((s) => [...ignored].some((u) => s.key === u || s.key.startsWith(u + ".")));
    if (bad) throw new Error(`Codex ignores ${bad.key} in a project's config; it goes in your own config.`);
  }
  const t = await readText(file);
  return { path: file, content: setTomlKeys(t?.text ?? "", input.sets), baseHash: t?.hash ?? null };
}

// -------------------------------------------------------------- file kinds

/** Which Codex file a path is, by where it sits; null for anything that isn't Codex's. */
export function codexKindFor(abs: string, agent: string | null): FileKind | null {
  const n = path.basename(abs);
  const inCodex = isInside(abs, CODEX_DIR) || abs.includes(`${path.sep}.codex${path.sep}`);
  if (inCodex && n.endsWith(".rules")) return "codex-rules";
  if (inCodex && (n === "config.toml" || n.endsWith(".config.toml"))) return "codex-config";
  if (inCodex && n === "hooks.json") return "codex-hooks";
  if (inCodex && abs.includes(`${path.sep}agents${path.sep}`) && n.endsWith(".toml")) return "codex-agent";
  if (isInside(abs, path.join(CODEX_DIR, "memories"))) return "codex-memory";
  if (isInside(abs, path.join(CODEX_DIR, "prompts"))) return "codex-skill";
  if (n === "SKILL.md" && abs.includes(`${path.sep}.agents${path.sep}skills${path.sep}`)) return "codex-skill";
  if (agent === "codex" && (n === "AGENTS.md" || n === "AGENTS.override.md")) return "codex-instructions";
  if (isInside(abs, CODEX_DIR) && (n === "AGENTS.md" || n === "AGENTS.override.md")) return "codex-instructions";
  return null;
}

export const CODEX_ABOUT: Partial<Record<FileKind, { summary: string; doc: () => DocRef }>> = {
  "codex-instructions": { summary: "Instructions Codex reads before it starts work. It reads one file per folder, from the project root down, up to its size limit.", doc: () => docRef(CX.agentsMd, "how-codex-discovers-guidance") },
  "codex-config": { summary: "Codex's settings. A trusted project's .codex/config.toml wins over yours; a profile file applies only with --profile.", doc: () => docRef(CX.configBasic, "configuration-precedence") },
  "codex-agent": { summary: "A custom Codex agent. It needs name, description and developer_instructions; other config.toml keys set how it runs.", doc: () => docRef(CX.subagents, "custom-agent-file-schema") },
  "codex-skill": { summary: "A skill. Codex starts with its name and description and reads the rest when it picks the skill.", doc: () => docRef(CX.skills, "how-chatgpt-and-codex-use-skills") },
  "codex-rules": { summary: "Rules for commands Codex wants to run outside the sandbox: allow, prompt or forbidden. The strictest match wins.", doc: () => docRef("codex/agent-configuration/rules", "understand-rule-fields") },
  "codex-hooks": { summary: "Commands Codex runs at fixed points in a session. Codex asks you to trust each hook before it runs.", doc: () => docRef(CX.hooks, "where-codex-looks-for-hooks") },
  "codex-memory": { summary: "Generated by Codex from past sessions. Reading it is fine; Codex's docs advise against hand edits as the way to steer it.", doc: () => docRef(CX.memories, "local-memory-storage") },
};

/** Codex's checks for one file, each citing Codex's docs. */
export function codexFindings(kind: FileKind, text: string): Finding[] {
  const out: Finding[] = [];
  if (kind === "codex-agent") {
    let data: Record<string, unknown> | null = null;
    try {
      data = parseToml(text) as Record<string, unknown>;
    } catch (e) {
      out.push(finding("agent:toml", "problem", "This file isn't valid TOML, so Codex can't load the agent.", (e as Error).message.split("\n")[0], { slug: CX.subagents, says: "add standalone TOML files" }));
    }
    if (data) {
      for (const f of agentFields().filter((x) => x.required === "yes")) {
        if (!data[f.name]) out.push(finding(`agent:${f.name}`, "problem", `${f.name} is missing.`, `Every custom agent file must set ${f.name}.`, { slug: CX.subagents, anchor: "custom-agents", says: "Every standalone custom agent file must define:" }));
      }
    }
  } else if (kind === "codex-skill") {
    const fm = splitFrontmatter(text);
    for (const f of ["name", "description"]) {
      if (!fm.data[f]) out.push(finding(`skill:${f}`, "problem", `${f} is missing from the frontmatter.`, "Codex needs name and description to list the skill.", { slug: CX.skills, says: "The `SKILL.md` file must include `name` and `description`." }, 1));
    }
  } else if (kind === "codex-config") {
    try {
      parseToml(text);
    } catch (e) {
      out.push(finding("toml:parse", "problem", "This file isn't valid TOML.", (e as Error).message.split("\n")[0], { slug: CX.configBasic, says: "config.toml" }, Number(/line (\d+)/.exec((e as Error).message)?.[1]) || undefined));
    }
  } else if (kind === "codex-instructions") {
    const bytes = Buffer.byteLength(text);
    const budget = defaultBudget();
    if (bytes > budget) out.push(finding("agents:budget", "warning", `This file is ${kib(bytes)}, over the ${kib(budget)} Codex reads by default.`, "Codex stops adding project instructions at that size. Split it across folders or raise project_doc_max_bytes.", RULES.budget));
    if (!text.trim()) out.push(finding("agents:empty", "note", "Empty, so Codex skips it.", "Codex reads the next file in this folder instead.", RULES.empty));
  }
  return out;
}
