import fs from "node:fs/promises";
import path from "node:path";

import type { CodexEntry, Definition, DefinitionsView, DocRef, FieldSpec, FileInfo, FileKind, Finding, Level, McpServer, McpView, MissingSlot, OpencodeLayer, OpencodeSettingsView, OpencodeView, ProjectRef } from "../../shared/types.ts";
import { docRef } from "./docs.ts";
import { body as bodyOf, splitFrontmatter } from "./frontmatter.ts";
import { fileInfo, readText, walk } from "./fsx.ts";
import { parseJsonc } from "./jsonc.ts";
import { lockFor } from "./locks.ts";
import { cleanUrl, maskArgs } from "./mcp.ts";
import {
  OC,
  OC_IGNORED,
  OC_RULES,
  OC_TO_CLI,
  OC_V1_NAMES,
  ocAgentFields,
  ocBuiltinAgents,
  ocCite,
  ocCliKeys,
  ocCommandFields,
  ocConfigKeys,
  ocHiddenAgents,
  ocRule,
  ocSkillPlaces,
  type OpencodeCite,
} from "./opencode-docs.ts";
import { CLAUDE_DIR, HOME, OPENCODE_DIR, expandHome, isInside, tilde } from "./paths.ts";

export { parseJsonc } from "./jsonc.ts";

/**
 * What OpenCode reads, as OpenCode 2's documentation describes it
 * (opencode-docs.ts): its instructions (AGENTS.md only), its config files
 * (opencode.json or .jsonc, merged in its order, in OpenCode 2's shape or
 * OpenCode 1's, which it still reads), the terminal client's cli.json, and its
 * agents, commands, skills, plugins and MCP servers. The files are read from
 * disk and never written here; edits go through the app's one write path like
 * any other file.
 *
 * The app sees its own environment, not the shell OpenCode runs in, so a
 * variable that changes what OpenCode reads (OPENCODE_DISABLE_PROJECT_CONFIG)
 * applies when the app was started with it, and the reason says so.
 */

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function finding(id: string, severity: Finding["severity"], title: string, detail: string, c: OpencodeCite, line?: number): Finding {
  return { id: `opencode:${id}`, severity, title, detail, line, ...ocCite(c) };
}

const env = (k: string) => !!process.env[k] && process.env[k] !== "0";
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// ------------------------------------------------------------------ folders

/** A folder and every folder above it, to the filesystem root, nearest first. */
function upToRoot(dir: string): string[] {
  const out = [dir];
  for (let cur = dir; path.dirname(cur) !== cur; ) out.push((cur = path.dirname(cur)));
  return out;
}

/** The nearest folder at or above `dir` that is a git repository: the project root. `dir` itself when there's none. */
export async function projectRoot(dir: string): Promise<string> {
  for (const d of upToRoot(dir)) {
    if (await exists(path.join(d, ".git"))) return d;
    if (d === HOME) break;
  }
  return dir;
}

/** From the project folder up to its project root, nearest first. */
async function toProjectRoot(dir: string): Promise<string[]> {
  const root = await projectRoot(dir);
  const out: string[] = [];
  for (const d of upToRoot(dir)) {
    out.push(d);
    if (d === root) break;
  }
  return out;
}

/** Where OpenCode looks for AGENTS.md: from the project folder up to your home folder, or to the project root outside it. Nearest first. */
async function instructionChain(dir: string): Promise<string[]> {
  if (!isInside(dir, HOME)) return toProjectRoot(dir);
  const out: string[] = [];
  for (const d of upToRoot(dir)) {
    out.push(d);
    if (d === HOME) break;
  }
  return out;
}

// ------------------------------------------------------------------ config

type Layer = OpencodeLayer & { data: Record<string, unknown> | null };

/**
 * OpenCode's config files that exist here, in the order it merges them (config
 * page, "Locations"): yours, then every opencode.json(c) from the farthest
 * folder above the project to the project, then every .opencode/opencode.json(c)
 * in the same order. Later ones win.
 */
export async function configLayers(project: ProjectRef | null): Promise<Layer[]> {
  const out: Layer[] = [];
  const add = async (file: string, label: string, kind: Layer["kind"], always = false) => {
    const t = await readText(file);
    if (!t && !always) return;
    const parsed = t ? parseJsonc(t.text) : { data: null, error: null };
    out.push({ path: file, display: tilde(file), label, kind, exists: !!t, broken: parsed.error, note: null, data: parsed.data });
  };
  await add(path.join(OPENCODE_DIR, "opencode.json"), "Yours", "user", !(await exists(path.join(OPENCODE_DIR, "opencode.jsonc"))));
  await add(path.join(OPENCODE_DIR, "opencode.jsonc"), "Yours", "user");
  if (project) {
    const far = upToRoot(project.path).reverse();
    const label = (d: string) => (d === project.path ? "This project" : tilde(d));
    const own = ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"];
    const hasOwn = (await Promise.all(own.map((n) => exists(path.join(project.path, n))))).some(Boolean);
    for (const d of far) {
      // ~/.config/opencode is read as yours, not as a project's .opencode.
      await add(path.join(d, "opencode.json"), label(d), "project", d === project.path && !hasOwn);
      await add(path.join(d, "opencode.jsonc"), label(d), "project");
    }
    for (const d of far) {
      await add(path.join(d, ".opencode", "opencode.json"), `${label(d)}, .opencode`, "project");
      await add(path.join(d, ".opencode", "opencode.jsonc"), `${label(d)}, .opencode`, "project");
    }
  }
  return out;
}

/** The value a file gives a setting under OpenCode 2's name: its own, or else the one it sets under OpenCode 1's name for it. */
function v2Value(data: Record<string, unknown> | null, key: string): { value: unknown; legacy: string | null } | null {
  if (!data) return null;
  if (data[key] !== undefined) return { value: data[key], legacy: null };
  for (const [old, now] of Object.entries(OC_V1_NAMES)) if (now === key && old !== key && data[old] !== undefined && sameMeaning(old)) return { value: data[old], legacy: old };
  return null;
}

/** OpenCode 1 names that are a straight rename; the others (tools, small_model, mode…) feed part of a setting, and are shown as notes. */
const sameMeaning = (old: string) => !["tools", "small_model", "mode", "enabled_providers", "disabled_providers"].includes(old);

/** Lists OpenCode adds together across files rather than replacing. */
const CONCAT = new Set(["skills", "plugins", "permissions"]);

function mergeInto(cur: unknown, v: unknown, key: string): unknown {
  if (CONCAT.has(key) && Array.isArray(cur) && Array.isArray(v)) return [...cur, ...v];
  if (key === "mcp" && isObj(cur) && isObj(v)) {
    // A later file replaces a whole server with the same name (MCP page, "Config").
    const servers = { ...(isObj(cur.servers) ? cur.servers : {}), ...(isObj(v.servers) ? v.servers : {}) };
    return { ...deepMerge(cur, v), servers };
  }
  return isObj(cur) && isObj(v) ? deepMerge(cur, v) : v;
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(out[k]) && isObj(v) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  return out;
}

const publicLayer = (l: Layer): OpencodeLayer => ({ path: l.path, display: l.display, label: l.label, kind: l.kind, exists: l.exists, broken: l.broken, note: l.note });

// ------------------------------------------------------------ instructions

/**
 * OpenCode's instruction files for a project (instructions page, "Scope"): your
 * ~/.config/opencode/AGENTS.md, then every AGENTS.md from the project folder up
 * to your home folder (to the project root outside it), all combined. Files
 * below the project load when OpenCode reads there. OpenCode 2 reads no
 * CLAUDE.md, and doesn't yet read what `instructions` in opencode.json lists.
 */
export async function opencodeView(project: ProjectRef | null): Promise<OpencodeView> {
  const levels: Level[] = [{ key: "oc-home", kind: "user", label: tilde(OPENCODE_DIR), covers: "Every project", path: OPENCODE_DIR, depth: 0 }];
  const entries: CodexEntry[] = [];
  const missing: MissingSlot[] = [];
  const noProject = env("OPENCODE_DISABLE_PROJECT_CONFIG");
  const notClaude = "OpenCode 2 reads AGENTS.md only, never CLAUDE.md";

  const entry = async (p: string, level: string, loads: CodexEntry["loads"], reason: string | null): Promise<void> => {
    const info = await fileInfo(p, "opencode-instructions", lockFor(p));
    entries.push({ id: `oc:${p}`, file: info, level, loads, reason, bytesRead: loads === "read" ? info.bytes : 0 });
  };

  const globalAgents = path.join(OPENCODE_DIR, "AGENTS.md");
  if (await exists(globalAgents)) await entry(globalAgents, "oc-home", "read", null);
  else missing.push({ id: `oc-missing:${globalAgents}`, level: "oc-home", path: globalAgents, display: tilde(globalAgents), label: "AGENTS.md", hint: "Your instructions for OpenCode in every project", template: "# My instructions for OpenCode\n\n" });
  const globalClaude = path.join(CLAUDE_DIR, "CLAUDE.md");
  if (await exists(globalClaude)) await entry(globalClaude, "oc-home", "not-read", notClaude);

  const remote: OpencodeView["remote"] = [];
  const layers = await configLayers(project);
  if (project) {
    const chain = await instructionChain(project.path);
    const dirs = [...chain].reverse();
    for (const [i, dir] of dirs.entries()) {
      const isProject = dir === project.path;
      levels.push({
        key: `oc-dir:${dir}`,
        kind: isProject ? "project" : "folder",
        label: i === 0 ? tilde(dir) : path.relative(dirs[i - 1], dir) + "/",
        covers: isProject ? "This project" : "Every project below",
        path: dir,
        depth: i,
      });
    }
    for (const d of dirs) {
      const p = path.join(d, "AGENTS.md");
      if (await exists(p)) await entry(p, `oc-dir:${d}`, noProject ? "not-read" : "read", noProject ? "Turned off by OPENCODE_DISABLE_PROJECT_CONFIG in the app's environment" : null);
      const c = path.join(d, "CLAUDE.md");
      if (await exists(c)) await entry(c, `oc-dir:${d}`, "not-read", notClaude);
    }
    if (!(await exists(path.join(project.path, "AGENTS.md")))) {
      const p = path.join(project.path, "AGENTS.md");
      missing.push({ id: `oc-missing:${p}`, level: `oc-dir:${project.path}`, path: p, display: tilde(p), label: "AGENTS.md", hint: "Instructions OpenCode reads in this project", template: "# " + path.basename(project.path) + "\n\n" });
    }
    // Below the project: each AGENTS.md loads when OpenCode reads a file in its folder.
    const nested = await walk(project.path, {
      maxDepth: 4,
      match: (n, full) => n === "AGENTS.md" && path.dirname(full) !== project.path,
      skipDir: (n) => n.startsWith(".") || ["node_modules", "dist", "build", "vendor", "Pods", "DerivedData", "target", "release", ".git"].includes(n),
    });
    for (const p of nested.sort()) {
      const dir = path.dirname(p);
      const rel = path.relative(project.path, dir);
      levels.push({ key: `oc-sub:${dir}`, kind: "subfolder", label: rel + "/", covers: `When OpenCode works in ${rel}/`, path: dir, depth: dirs.length });
      await entry(p, `oc-sub:${dir}`, noProject ? "not-read" : "on-demand", noProject ? "Turned off by OPENCODE_DISABLE_PROJECT_CONFIG in the app's environment" : "Loads when OpenCode reads a file in this folder");
    }
  }

  // `instructions` in opencode.json: accepted, but OpenCode 2 doesn't read the files yet.
  const listed: { pattern: string; from: Layer }[] = [];
  for (const l of layers) for (const v of Array.isArray(l.data?.instructions) ? (l.data!.instructions as unknown[]) : []) if (typeof v === "string") listed.push({ pattern: v, from: l });
  if (listed.length) {
    levels.push({ key: "oc-config", kind: "subfolder", label: "opencode.json", covers: "Files it lists under instructions", path: null, depth: 1 });
    const seen = new Set(entries.map((e) => e.file.path));
    for (const { pattern, from } of listed) {
      if (/^https?:\/\//.test(pattern)) {
        remote.push({ url: cleanUrl(pattern), from: from.display });
        continue;
      }
      const base = from.kind === "project" ? (project?.path ?? path.dirname(from.path)) : path.dirname(from.path);
      for (const p of await expandGlob(pattern, base)) {
        if (seen.has(p)) continue;
        seen.add(p);
        await entry(p, "oc-config", "not-read", "Listed under instructions, which OpenCode 2 doesn't read yet");
      }
    }
  }

  return {
    home: tilde(OPENCODE_DIR),
    levels,
    entries,
    missing,
    remote,
    layers: layers.map(publicLayer),
    rules: [OC_RULES.globalThenUp, OC_RULES.combined, OC_RULES.agentsOnly, OC_RULES.nested, OC_RULES.instructionsUnused].map(ocRule),
  };
}

/** A path or glob from `instructions`, as the files it names. */
async function expandGlob(pattern: string, base: string): Promise<string[]> {
  const p = expandHome(pattern);
  const abs = path.isAbsolute(p) ? p : path.join(base, p);
  if (!/[*?[{]/.test(abs)) return (await exists(abs)) ? [abs] : [];
  const out: string[] = [];
  try {
    for await (const f of fs.glob(abs)) out.push(path.resolve(f));
  } catch {
    /* an unreadable folder matches nothing */
  }
  return out.sort();
}

// ------------------------------------------------------------------ skills

function skillFields(): FieldSpec[] {
  return [
    { name: "name", required: "no", description: "A display name. The skill's ID comes from its file path." },
    { name: "description", required: "no", description: "When to use it. Without one, OpenCode doesn't show the skill to the model." },
    { name: "metadata", required: "no", description: "opencode/autoinvoke: false keeps it off the model's list." },
    { name: "disable-model-invocation", required: "no", description: "true does the same as opencode/autoinvoke: false." },
  ];
}

type SkillSource = { dir: string; label: string; source: Definition["source"] };

/**
 * The skill sources, in the order OpenCode registers them (skills page,
 * "Precedence"): .claude/skills, then .agents/skills, yours then each folder
 * from the project root down; then ~/.config/opencode/skills; then the
 * project's .opencode/skills from the root down; then `skills` in opencode.json.
 * A later source wins for an ID.
 */
async function skillSources(project: ProjectRef | null): Promise<{ sources: SkillSource[]; urls: { url: string; from: string }[] }> {
  const places = ocSkillPlaces();
  const down = project ? (await toProjectRoot(project.path)).reverse() : [];
  const label = (base: string, d: string) => (d === project?.path ? `${base}, this project` : `${base}, ${tilde(d)}`);
  const sources: SkillSource[] = [];
  const compat = (folder: string) => {
    const user = places.find((p) => p.scope === "user" && p.pattern === `~/${folder}`);
    if (user) sources.push({ dir: expandHome(user.pattern), label: tilde(expandHome(user.pattern)), source: "user" });
    if (places.some((p) => p.scope === "project" && p.pattern === folder)) for (const d of down) sources.push({ dir: path.join(d, folder), label: label(folder, d), source: "project" });
  };
  compat(".claude/skills");
  compat(".agents/skills");
  if (places.some((p) => p.pattern === "~/.config/opencode/skills")) sources.push({ dir: path.join(OPENCODE_DIR, "skills"), label: "Yours", source: "user" });
  for (const d of down) {
    sources.push({ dir: path.join(d, ".opencode", "skill"), label: label(".opencode/skill", d), source: "project" });
    sources.push({ dir: path.join(d, ".opencode", "skills"), label: label(".opencode/skills", d), source: "project" });
  }
  const urls: { url: string; from: string }[] = [];
  for (const l of await configLayers(project)) {
    const list = Array.isArray(l.data?.skills) ? (l.data!.skills as unknown[]) : isObj(l.data?.skills) ? [...((l.data!.skills as { paths?: unknown[] }).paths ?? []), ...((l.data!.skills as { urls?: unknown[] }).urls ?? [])] : [];
    for (const v of list) {
      if (typeof v !== "string") continue;
      if (/^https?:\/\//.test(v)) urls.push({ url: cleanUrl(v), from: l.display });
      // Relative paths start from where OpenCode runs, not from the config file (skills page, "Sources").
      else sources.push({ dir: path.isAbsolute(expandHome(v)) ? expandHome(v) : path.join(project?.path ?? HOME, v), label: `${v}, from ${l.label === "Yours" ? "your opencode.json" : l.display}`, source: l.kind === "user" ? "user" : "project" });
    }
  }
  return { sources, urls };
}

/** One source's skills: Markdown files at its root, and SKILL.md files at any depth, each with its ID. */
async function skillFiles(dir: string): Promise<{ file: string; id: string }[]> {
  const out: { file: string; id: string }[] = [];
  let top: import("node:fs").Dirent[];
  try {
    top = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of top) if (e.isFile() && e.name.endsWith(".md") && e.name !== "SKILL.md") out.push({ file: path.join(dir, e.name), id: e.name.replace(/\.md$/, "") });
  for (const f of await walk(dir, { maxDepth: 6, match: (n) => n === "SKILL.md", skipDir: (n) => n === "node_modules" || n.startsWith(".") })) {
    // A root-level SKILL.md has the literal ID SKILL (skills page, "Catalogs").
    out.push({ file: f, id: path.dirname(f) === dir ? "SKILL" : path.basename(path.dirname(f)) });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

export async function opencodeSkills(project: ProjectRef | null): Promise<{ items: Definition[]; locations: DefinitionsView["locations"]; fields: FieldSpec[]; doc: DocRef; findings: Finding[] }> {
  const { sources, urls } = await skillSources(project);
  const items: (Definition & { order: number })[] = [];
  const locations: DefinitionsView["locations"] = [];
  // New skills go in OpenCode's own folders.
  const own = [path.join(OPENCODE_DIR, "skills"), ...(project ? [path.join(project.path, ".opencode", "skills")] : [])];
  for (const d of own) locations.push({ label: d === own[0] ? "Yours" : "This project", path: d, display: tilde(d), exists: await exists(d) });
  for (const [order, s] of sources.entries()) {
    if (!own.includes(s.dir) && (await exists(s.dir))) locations.push({ label: s.label, path: s.dir, display: tilde(s.dir), exists: true });
    for (const { file, id } of await skillFiles(s.dir)) {
      const t = await readText(file);
      if (!t) continue;
      const fm = splitFrontmatter(t.text);
      const f = skillFindings(file, t.text);
      items.push({
        order,
        file: await fileInfo(file, "opencode-skill", lockFor(file)),
        name: id,
        description: String(fm.data.description ?? fm.data.name ?? ""),
        where: s.label,
        source: s.source,
        plugin: null,
        counts: { problem: f.filter((x) => x.severity === "problem").length, warning: f.filter((x) => x.severity === "warning").length, note: f.filter((x) => x.severity === "note").length },
        active: advertised(fm.data),
      });
    }
  }
  // The later source supplies an ID; earlier ones with the same ID are left out.
  for (const i of items) {
    const winner = items.filter((x) => x.name === i.name && x.order > i.order).pop();
    if (winner) i.shadowedBy = winner.where;
  }
  const findings: Finding[] = [];
  const twice = new Set(items.filter((i) => i.shadowedBy).map((i) => i.name));
  if (twice.size) findings.push(finding("skills:shadowed", "note", `${twice.size === 1 ? `Two sources define ${[...twice][0]}` : `${twice.size} skill IDs are defined twice`}.`, "OpenCode loads the one from the source it registers later; the earlier one is dimmed.", OC_RULES.skillLater));
  if (urls.length) findings.push(finding("skills:urls", "note", `opencode.json adds ${urls.length === 1 ? "a skill catalog" : `${urls.length} skill catalogs`} from the web: ${urls.map((u) => u.url).join(", ")}.`, "OpenCode downloads them; the app only lists them.", OC_RULES.skillArrays));
  return { items: items.map(({ order: _o, ...d }) => d), locations, fields: skillFields(), doc: docRef(OC.skills, "discovery"), findings };
}

/** Whether OpenCode shows a skill to the model: it needs a description, and neither opt-out. */
function advertised(d: Record<string, unknown>): boolean {
  const meta = isObj(d.metadata) ? d.metadata : {};
  if (meta["opencode/autoinvoke"] !== undefined) return meta["opencode/autoinvoke"] !== false;
  return !!d.description && d["disable-model-invocation"] !== true;
}

function skillFindings(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const fm = splitFrontmatter(text);
  const d = fm.data;
  const meta = isObj(d.metadata) ? d.metadata : {};
  const id = path.basename(file) === "SKILL.md" ? path.basename(path.dirname(file)) : path.basename(file, ".md");
  if (fm.error) out.push(finding("skill:yaml", "warning", "The frontmatter isn't valid YAML.", `${fm.error}. Quote the value, or OpenCode may not read the description.`, OC_RULES.skillNoDesc, 1));
  else if (!d.description) out.push(finding("skill:description", "warning", "No description, so OpenCode doesn't offer it.", "The model only sees skills with a description. You can still load it yourself as @" + id + ".", OC_RULES.skillNoDesc, 1));
  else if (meta["opencode/autoinvoke"] === false || d["disable-model-invocation"] === true) out.push(finding("skill:hidden", "note", "Kept off the model's list.", "It loads only when named, as @" + id + ".", OC_RULES.skillAutoinvoke, 1));
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) || id.length > 64) out.push(finding("skill:id", "note", `The ID ${id} isn't lowercase words with hyphens.`, "OpenCode accepts it; other agents may not. The ID comes from the file or folder name.", OC_RULES.skillPortable, 1));
  return out;
}

// ------------------------------------------------------------------ agents

const AGENT_DIRS = ["agents", "agent", "modes", "mode"];

/**
 * OpenCode's agents: Markdown files in an agents folder (yours and each
 * project .opencode folder up to the project root; OpenCode 1's agent/, mode/
 * and modes/ too), those defined under `agents` in opencode.json (or OpenCode
 * 1's `agent` and `mode`), and the built-in ones its docs list.
 */
export async function opencodeAgents(project: ProjectRef | null): Promise<{ items: Definition[]; locations: DefinitionsView["locations"]; fields: FieldSpec[]; doc: DocRef }> {
  const places: { dir: string; label: string; source: Definition["source"]; primary: boolean }[] = [];
  for (const sub of AGENT_DIRS) places.push({ dir: path.join(OPENCODE_DIR, sub), label: "Yours", source: "user", primary: sub.startsWith("mode") });
  if (project) for (const d of (await toProjectRoot(project.path)).reverse()) for (const sub of AGENT_DIRS) places.push({ dir: path.join(d, ".opencode", sub), label: d === project.path ? "This project" : tilde(d), source: "project", primary: sub.startsWith("mode") });
  const items: Definition[] = [];
  const locations: DefinitionsView["locations"] = [];
  for (const p of places) {
    const there = await exists(p.dir);
    // Only the agents folder is offered for new agents; the others are shown when they're used.
    if (there || path.basename(p.dir) === "agents") locations.push({ label: p.label, path: p.dir, display: tilde(p.dir), exists: there });
    for (const file of await mdFiles(p.dir)) {
      const t = await readText(file);
      if (!t) continue;
      const fm = splitFrontmatter(t.text);
      const f = agentFindings(t.text);
      // A new custom agent is primary unless it says otherwise; OpenCode 1's mode folders hold primary agents.
      const mode = p.primary ? "primary" : String(fm.data.mode ?? "primary");
      items.push({
        file: await fileInfo(file, "opencode-agent", lockFor(file)),
        name: path.relative(p.dir, file).replace(/\.md$/, "").split(path.sep).join("/"),
        description: [modeWord(mode), String(fm.data.description ?? "")].filter(Boolean).join(" "),
        where: p.label,
        source: p.source,
        plugin: null,
        counts: { problem: 0, warning: f.filter((x) => x.severity === "warning").length, note: f.filter((x) => x.severity === "note").length },
        active: fm.data.disabled !== true && fm.data.disable !== true,
      });
    }
  }
  // Agents defined in opencode.json, shown with the file that defines them.
  const builtins = ocBuiltinAgents();
  const hidden = ocHiddenAgents();
  for (const l of await configLayers(project)) {
    const defs: [string, unknown, boolean][] = [
      ...Object.entries(isObj(l.data?.agents) ? l.data!.agents : {}).map(([n, v]) => [n, v, false] as [string, unknown, boolean]),
      ...Object.entries(isObj(l.data?.agent) ? l.data!.agent : {}).map(([n, v]) => [n, v, false] as [string, unknown, boolean]),
      ...Object.entries(isObj(l.data?.mode) ? l.data!.mode : {}).map(([n, v]) => [n, v, true] as [string, unknown, boolean]),
    ];
    for (const [name, raw, fromMode] of defs) {
      const r = isObj(raw) ? raw : {};
      const builtin = builtins.find((b) => b.name === name);
      const isHidden = hidden.includes(name);
      const what = builtin ? "Changes the built-in agent." : isHidden ? `Changes the hidden ${name} agent, which OpenCode runs itself.` : "";
      items.push({
        file: await fileInfo(l.path, "opencode-config", lockFor(l.path)),
        name,
        description: [isHidden ? "" : modeWord(String(r.mode ?? (fromMode ? "primary" : builtin?.mode ?? "primary"))), what, typeof r.description === "string" ? r.description : ""].filter(Boolean).join(" "),
        where: `In ${l.label === "Yours" ? "your opencode.json" : `${l.label}'s ${path.basename(l.path)}`}`,
        source: l.kind === "user" ? "user" : "project",
        plugin: null,
        counts: { problem: 0, warning: 0, note: 0 },
        active: r.disabled !== true && r.disable !== true,
      });
    }
  }
  const changed = new Set(items.map((i) => i.name));
  for (const b of builtins) {
    items.push({
      file: builtinFile(b.name, "opencode-agent"),
      name: b.name,
      description: `${modeWord(b.mode)} ${b.description}`,
      where: "Built in",
      source: "builtin",
      plugin: null,
      counts: { problem: 0, warning: 0, note: 0 },
      shadowedBy: changed.has(b.name) ? b.name : null,
    });
  }
  return { items, locations, fields: ocAgentFields(), doc: docRef(OC.agents, "locations") };
}

const modeWord = (mode: string) => (mode === "subagent" ? "Subagent." : mode === "all" ? "Primary or subagent." : "Primary agent.");

function builtinFile(name: string, kind: FileKind): FileInfo {
  return { path: `builtin:opencode:${name}`, display: "Built into OpenCode", name, kind, exists: true, bytes: 0, lines: 0, modified: null, isSymlink: false, linkTarget: null, hash: null, editable: false, lockedBecause: "Built into OpenCode.", unreadable: false };
}

async function mdFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for (const e of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
      if (e.isFile() && e.name.endsWith(".md")) out.push(path.join(e.parentPath, e.name));
    }
  } catch {
    /* no folder */
  }
  return out.sort();
}

const LEGACY_AGENT_FIELDS: Record<string, string> = { temperature: "request.body", top_p: "request.body", prompt: "system", permission: "permissions", tools: "permissions", disable: "disabled", maxSteps: "steps" };

function agentFindings(text: string): Finding[] {
  const out: Finding[] = [];
  const d = splitFrontmatter(text).data;
  const mode = d.mode ?? "primary";
  if (!d.description && (mode === "subagent" || mode === "all")) out.push(finding("agent:description", "warning", "No description.", "OpenCode shows a subagent's description to the agent deciding which one to launch.", OC_RULES.descForSubagents, 1));
  for (const [k, now] of Object.entries(LEGACY_AGENT_FIELDS)) {
    if (d[k] !== undefined) out.push(finding(`agent:${k}`, "note", `${k} is OpenCode 1's field.`, `OpenCode 2 still reads it; its own is ${now}.`, OC_RULES.agentLegacy, 1));
  }
  return out;
}

// ---------------------------------------------------------------- commands

const COMMAND_DIRS = ["commands", "command"];

/**
 * OpenCode's commands: Markdown files in a commands folder (yours, then each
 * project .opencode folder from the project root down; nearer ones win), and
 * those under `commands` (or OpenCode 1's `command`) in opencode.json.
 */
export async function opencodeCommands(project: ProjectRef | null): Promise<{ items: Definition[]; locations: DefinitionsView["locations"]; fields: FieldSpec[]; doc: DocRef; findings: Finding[] }> {
  const places: { dir: string; label: string; source: Definition["source"] }[] = [];
  for (const sub of COMMAND_DIRS) places.push({ dir: path.join(OPENCODE_DIR, sub), label: "Yours", source: "user" });
  if (project) for (const d of (await toProjectRoot(project.path)).reverse()) for (const sub of COMMAND_DIRS) places.push({ dir: path.join(d, ".opencode", sub), label: d === project.path ? "This project" : tilde(d), source: "project" });
  const items: (Definition & { order: number })[] = [];
  const locations: DefinitionsView["locations"] = [];
  let order = 0;
  for (const p of places) {
    const there = await exists(p.dir);
    if (there || path.basename(p.dir) === "commands") locations.push({ label: p.label, path: p.dir, display: tilde(p.dir), exists: there });
    for (const file of await mdFiles(p.dir)) {
      const t = await readText(file);
      if (!t) continue;
      const fm = splitFrontmatter(t.text);
      const f = commandFindings(t.text);
      items.push({
        order: order++,
        file: await fileInfo(file, "opencode-command", lockFor(file)),
        name: "/" + path.relative(p.dir, file).replace(/\.md$/, "").split(path.sep).join("/"),
        description: String(fm.data.description ?? bodyOf(t.text).trim().split("\n")[0] ?? ""),
        where: p.label,
        source: p.source,
        plugin: null,
        counts: { problem: f.filter((x) => x.severity === "problem").length, warning: f.filter((x) => x.severity === "warning").length, note: f.filter((x) => x.severity === "note").length },
      });
    }
  }
  for (const l of await configLayers(project)) {
    const defs = { ...(isObj(l.data?.command) ? l.data!.command : {}), ...(isObj(l.data?.commands) ? l.data!.commands : {}) };
    for (const [name, raw] of Object.entries(defs)) {
      const r = isObj(raw) ? raw : {};
      items.push({
        order: order++,
        file: await fileInfo(l.path, "opencode-config", lockFor(l.path)),
        name: "/" + name,
        description: typeof r.description === "string" ? r.description : typeof r.template === "string" ? r.template.split("\n")[0] : "",
        where: `In ${l.label === "Yours" ? "your opencode.json" : `${l.label}'s ${path.basename(l.path)}`}`,
        source: l.kind === "user" ? "user" : "project",
        plugin: null,
        counts: { problem: typeof r.template === "string" ? 0 : 1, warning: 0, note: 0 },
      });
    }
  }
  for (const i of items) {
    const winner = items.filter((x) => x.name === i.name && x.order > i.order).pop();
    if (winner) i.shadowedBy = winner.where;
  }
  const findings: Finding[] = [];
  const noTemplate = items.filter((i) => i.file.kind === "opencode-config" && i.counts.problem);
  if (noTemplate.length) findings.push(finding("commands:template", "problem", `${noTemplate.map((i) => i.name).join(", ")} ${noTemplate.length === 1 ? "has" : "have"} no template.`, "A command defined in opencode.json needs a template: the prompt it sends.", OC_RULES.commandJson));
  return { items: items.map(({ order: _o, ...d }) => d), locations, fields: ocCommandFields(), doc: docRef(OC.commands, "markdown"), findings };
}

function commandFindings(text: string): Finding[] {
  const out: Finding[] = [];
  const d = splitFrontmatter(text).data;
  if (d.template !== undefined) out.push(finding("command:template", "warning", "template in the frontmatter isn't used.", "In a Markdown command, the text below the frontmatter is the prompt.", OC_RULES.commandNoTemplate, 1));
  if (d.subtask !== undefined) out.push(finding("command:subtask", "note", "subtask is OpenCode 1's name.", "OpenCode 2 still reads it; its own is subagent, which wins when both are set.", OC_RULES.commandSubtask, 1));
  return out;
}

// ----------------------------------------------------------------- plugins

const PLUGIN_DIRS = ["plugins", "plugin"];

/**
 * OpenCode's plugins (plugins page): the entries under `plugins` (or OpenCode
 * 1's `plugin`) in each config file, lowest to highest, and the .ts and .js
 * files and package folders in your plugins folder and in every .opencode
 * folder from the project up. An entry starting with "-" turns plugins off.
 */
export async function opencodePlugins(project: ProjectRef | null): Promise<{ items: Definition[]; locations: DefinitionsView["locations"]; fields: FieldSpec[]; doc: DocRef; findings: Finding[] }> {
  const items: Definition[] = [];
  const locations: DefinitionsView["locations"] = [];
  const findings: Finding[] = [];
  const dirs: { dir: string; label: string; source: Definition["source"] }[] = PLUGIN_DIRS.map((sub) => ({ dir: path.join(OPENCODE_DIR, sub), label: "Yours", source: "user" as const }));
  if (project) for (const d of upToRoot(project.path).reverse()) for (const sub of PLUGIN_DIRS) dirs.push({ dir: path.join(d, ".opencode", sub), label: d === project.path ? "This project" : tilde(d), source: "project" });
  for (const p of dirs) {
    let list: import("node:fs").Dirent[];
    try {
      list = await fs.readdir(p.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    locations.push({ label: p.label, path: p.dir, display: tilde(p.dir), exists: true });
    for (const e of list.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(p.dir, e.name);
      const isCode = e.isFile() && /\.(ts|js|mts|mjs)$/.test(e.name);
      if (!isCode && !e.isDirectory()) continue;
      const entryFile = isCode ? full : await packageEntry(full);
      if (!entryFile) continue;
      const t = await readText(entryFile);
      const f = t ? pluginFindings(t.text) : [];
      items.push({
        file: await fileInfo(entryFile, entryFile.endsWith(".json") ? "opencode-config" : "opencode-plugin", lockFor(entryFile)),
        name: e.name.replace(/\.(ts|js|mts|mjs)$/, ""),
        description: isCode ? "A local plugin file." : "A local plugin package.",
        where: p.label,
        source: p.source,
        plugin: null,
        counts: { problem: 0, warning: f.length, note: 0 },
      });
    }
  }
  // A plugins/ folder beside a project's opencode.json isn't picked up.
  if (project && (await exists(path.join(project.path, "plugins"))) && ((await exists(path.join(project.path, "opencode.json"))) || (await exists(path.join(project.path, "opencode.jsonc"))))) {
    findings.push(finding("plugins:beside", "note", "OpenCode doesn't load the plugins/ folder beside this project's opencode.json.", "List its files under plugins in opencode.json, or move the folder into .opencode/.", OC_RULES.pluginBeside));
  }
  for (const l of await configLayers(project)) {
    const list = [...(Array.isArray(l.data?.plugin) ? (l.data!.plugin as unknown[]) : []), ...(Array.isArray(l.data?.plugins) ? (l.data!.plugins as unknown[]) : [])];
    for (const raw of list) {
      const spec = typeof raw === "string" ? raw : Array.isArray(raw) && typeof raw[0] === "string" ? raw[0] : isObj(raw) && typeof raw.package === "string" ? raw.package : null;
      if (!spec) continue;
      const off = spec.startsWith("-");
      const local = /^(\.{1,2}\/|\/|~\/|file:)/.test(spec);
      const where = `In ${l.label === "Yours" ? "your opencode.json" : `${l.label}'s ${path.basename(l.path)}`}`;
      items.push({
        file: { ...(await fileInfo(l.path, "opencode-config", lockFor(l.path))) },
        name: spec,
        description: off ? "Turns plugins off." : spec === "*" ? "Every plugin." : local ? `A local plugin, from ${path.resolve(path.dirname(l.path), expandHome(spec.replace(/^file:\/\//, "")))}.` : "A package OpenCode installs.",
        where,
        source: l.kind === "user" ? "user" : "project",
        plugin: null,
        counts: { problem: 0, warning: 0, note: 0 },
        active: !off,
      });
    }
  }
  return { items, locations, fields: [], doc: docRef(OC.plugins, "discover"), findings };
}

async function packageEntry(dir: string): Promise<string | null> {
  for (const n of ["index.ts", "index.js", "src/index.ts", "package.json"]) if (await exists(path.join(dir, n))) return path.join(dir, n);
  return null;
}

/** A plugin written for OpenCode 1 returns hooks from a function; OpenCode 2's default-exports a definition with setup(ctx). */
function pluginFindings(text: string): Finding[] {
  if (/\bsetup\s*\(|Plugin\.define\s*\(/.test(text) || !/export\s/.test(text)) return [];
  return [finding("plugin:v1", "warning", "This looks like an OpenCode 1 plugin.", "OpenCode 2 plugins default-export a definition with an id and setup(ctx); plugins written for OpenCode 1 don't run.", OC_RULES.pluginV1Code)];
}

// --------------------------------------------------------------------- MCP

/**
 * OpenCode's MCP servers: `mcp.servers` in each config file (and OpenCode 1's
 * servers placed straight under `mcp`, which OpenCode 2 still reads). A later
 * file replaces a server with the same name whole.
 */
export async function opencodeMcp(project: ProjectRef | null): Promise<McpView> {
  const layers = await configLayers(project);
  const servers = new Map<string, McpServer>();
  for (const l of layers) {
    const mcp = isObj(l.data?.mcp) ? l.data!.mcp : {};
    const v2 = isObj(mcp.servers) ? mcp.servers : {};
    const v1 = Object.fromEntries(Object.entries(mcp).filter(([k, v]) => k !== "servers" && k !== "timeout" && isObj(v)));
    for (const [name, raw, old] of [...Object.entries(v1).map(([n, v]) => [n, v, true] as const), ...Object.entries(v2).map(([n, v]) => [n, v, false] as const)]) {
      const r = isObj(raw) ? raw : {};
      const prev = servers.get(name);
      const where = l.label === "Yours" ? "Your opencode.json" : l.label;
      if (old && r.type === undefined) {
        // OpenCode 1 let an entry with only `enabled` switch another file's server; OpenCode 2 ignores it.
        if (prev) prev.note = `${prev.note} ${where} has an entry with only enabled, which OpenCode 2 ignores.`;
        continue;
      }
      const command = Array.isArray(r.command) ? r.command.map(String) : null;
      const off = r.disabled === true || r.enabled === false;
      const secrets = [...Object.keys(isObj(r.environment) ? r.environment : {}), ...Object.keys(isObj(r.headers) ? r.headers : {}).map((h) => `${h} header`)];
      const notes = [
        off ? `Turned off with ${r.disabled === true ? "disabled: true" : "enabled: false"}.` : "OpenCode connects to it.",
        r.type === "remote" && r.oauth !== false ? "Signs in with OAuth when the server asks." : null,
        old ? "Written the OpenCode 1 way, straight under mcp; OpenCode 2 reads it." : null,
        prev ? `Replaces the one in ${prev.where}.` : null,
      ].filter(Boolean);
      servers.set(name, {
        name,
        scope: l.kind === "user" ? "user" : "project",
        where,
        file: l.display,
        transport: r.type === "remote" ? "http" : "stdio",
        endpoint: command ? maskArgs(command).join(" ") : typeof r.url === "string" ? cleanUrl(r.url) : "",
        secrets,
        status: off ? "off" : "on",
        note: notes.join(" "),
        findings: [],
      });
    }
  }
  return {
    project,
    agent: "opencode",
    servers: [...servers.values()],
    files: layers.map((l) => ({ label: l.label, display: l.display, exists: l.exists, broken: l.broken })),
    doc: docRef(OC.mcp, "config"),
  };
}

// ---------------------------------------------------------------- settings

/** cli.json, the terminal client's one settings file (CLI settings page). */
export const cliJsonPath = () => path.join(OPENCODE_DIR, "cli.json");

/**
 * Every setting OpenCode's config page lists, with the value in force here and
 * the file that set it, OpenCode 1's names counted as the new ones; then
 * cli.json's settings, from its schema.
 */
export async function opencodeSettings(project: ProjectRef | null, capturedAt: string | null): Promise<OpencodeSettingsView> {
  const layers = await configLayers(project);
  const keys = ocConfigKeys();
  const known = new Set(keys.map((k) => k.key));
  const rows = keys.map((k) => {
    let value: unknown;
    const files: Layer[] = [];
    const legacy: { name: string; file: string }[] = [];
    for (const l of layers) {
      if (!l.data) continue;
      const v = v2Value(l.data, k.key);
      for (const [old, now] of Object.entries(OC_V1_NAMES)) if (now === k.key && l.data[old] !== undefined) legacy.push({ name: old, file: l.display });
      if (!v) continue;
      // OpenCode 2 ignores `update` in a project file (config page, "Updates").
      if (k.key === "update" && l.kind === "project") continue;
      files.push(l);
      value = value === undefined ? v.value : mergeInto(value, v.value, k.key);
    }
    return {
      key: k.key,
      type: k.type,
      description: k.description,
      options: k.enum,
      deprecated: false,
      value: value === undefined ? null : show(k.key, value),
      setIn: files.length ? files[files.length - 1].display : null,
      alsoIn: files.slice(0, -1).map((f) => f.display),
      legacy,
      doc: docRef(OC.config, k.anchor),
    };
  });
  const ignored: OpencodeSettingsView["ignored"] = [];
  const unknown: OpencodeSettingsView["unknown"] = [];
  for (const l of layers) {
    for (const key of Object.keys(l.data ?? {})) {
      if (key === "$schema" || known.has(key) || OC_V1_NAMES[key]) continue;
      if (OC_IGNORED[key]) ignored.push({ key, file: l.display, why: `OpenCode 2 ignores it. ${OC_IGNORED[key]}` });
      else if (OC_TO_CLI.has(key)) ignored.push({ key, file: l.display, why: "It belongs in cli.json now; OpenCode moves it there when it can." });
      else if (key === "lsp") ignored.push({ key, file: l.display, why: "OpenCode 2 keeps it but doesn't run language servers." });
      else unknown.push({ key, file: l.display });
    }
  }
  // cli.json: one global file for the terminal client, never a project's.
  const cliFile = cliJsonPath();
  const cliText = await readText(cliFile);
  const cliParsed = cliText ? parseJsonc(cliText.text) : { data: null, error: null };
  const cliLayer: OpencodeLayer = { path: cliFile, display: tilde(cliFile), label: "Terminal client", kind: "cli", exists: !!cliText, broken: cliParsed.error, note: null };
  const cliRows = ocCliKeys().map((k) => {
    const v = cliParsed.data?.[k.key];
    return { key: k.key, type: k.type, description: k.description, options: k.options, deprecated: false, value: v === undefined ? null : show(k.key, v), setIn: v === undefined ? null : cliLayer.display, alsoIn: [], legacy: [], doc: docRef(OC.cliConfig) };
  });
  return {
    project,
    layers: layers.map(publicLayer),
    rows,
    unknown,
    ignored,
    cli: { layer: cliLayer, rows: cliRows },
    capturedAt,
    doc: docRef(OC.config, "locations"),
    rules: [OC_RULES.directThenDot, OC_RULES.dotWins, OC_RULES.preserved, OC_RULES.v1Read, OC_RULES.cliSeparate].map(ocRule),
  };
}

const SECRETISH = /^(sk-|ghp_|xox|AKIA)|[A-Za-z0-9_-]{32,}/;
const SECRET_KEYS = /api[-_]?key|^key$|token|secret|password|authorization|cookie|credential/i;

/** A value in a line. Secrets are hidden: strings that look like keys, and anything under a key named like one. */
function show(key: string, v: unknown): string {
  if (typeof v === "string") return SECRETISH.test(v) || SECRET_KEYS.test(key) ? "(hidden)" : v;
  const s = JSON.stringify(v, (k, x) => (typeof x === "string" && (SECRETISH.test(x) || SECRET_KEYS.test(k)) ? "(hidden)" : x));
  return s.length > 160 ? s.slice(0, 157) + "…" : s;
}

// -------------------------------------------------------------- file kinds

/** Which OpenCode file a path is; null for anything that isn't OpenCode's. `agent` is the screen's agent. */
export function opencodeKindFor(abs: string, agent: string | null): FileKind | null {
  const n = path.basename(abs);
  const inOc = isInside(abs, OPENCODE_DIR) || abs.includes(`${path.sep}.opencode${path.sep}`);
  if (abs === cliJsonPath()) return "opencode-cli";
  if ((inOc || agent === "opencode") && (n === "opencode.json" || n === "opencode.jsonc")) return "opencode-config";
  const parts = abs.split(path.sep);
  if (inOc && n.endsWith(".md") && parts.some((p) => AGENT_DIRS.includes(p))) return "opencode-agent";
  if (inOc && n.endsWith(".md") && parts.some((p) => COMMAND_DIRS.includes(p))) return "opencode-command";
  if (inOc && /\.(ts|js|mts|mjs)$/.test(n) && parts.some((p) => PLUGIN_DIRS.includes(p))) return "opencode-plugin";
  if (n === "SKILL.md" && (inOc || agent === "opencode")) return "opencode-skill";
  if (inOc && n.endsWith(".md") && parts.some((p) => p === "skills" || p === "skill")) return "opencode-skill";
  if (isInside(abs, OPENCODE_DIR) && n === "AGENTS.md") return "opencode-instructions";
  if (agent === "opencode" && n === "AGENTS.md") return "opencode-instructions";
  return null;
}

export const OPENCODE_ABOUT: Partial<Record<FileKind, { summary: string; doc: () => DocRef }>> = {
  "opencode-instructions": { summary: "Instructions OpenCode reads in every session: yours, then each AGENTS.md from the project up to your home folder, all combined.", doc: () => docRef(OC.instructions, "scope") },
  "opencode-config": { summary: "OpenCode's settings, in JSON with comments allowed. Its files are merged; later ones win where they set the same key.", doc: () => docRef(OC.config, "locations") },
  "opencode-cli": { summary: "Settings for OpenCode's terminal client: theme, tabs, keys. One file for every project.", doc: () => docRef(OC.cliConfig, "configuration-file") },
  "opencode-agent": { summary: "An OpenCode agent. Its path is its ID; the frontmatter sets how it runs, and the text below is its system prompt.", doc: () => docRef(OC.agents, "markdown") },
  "opencode-command": { summary: "An OpenCode command. Its path is its name after /; the text below the frontmatter is the prompt it sends.", doc: () => docRef(OC.commands, "markdown") },
  "opencode-skill": { summary: "A skill. Its path is its ID. OpenCode lists its name and description, and reads the rest when it picks the skill.", doc: () => docRef(OC.skills, "frontmatter") },
  "opencode-plugin": { summary: "An OpenCode plugin: code OpenCode loads at start. Edit it in your editor.", doc: () => docRef(OC.plugins, "discover") },
};

/** OpenCode's checks for one file, each citing OpenCode's docs. */
export function opencodeFindings(kind: FileKind, file: string, text: string): Finding[] {
  if (kind === "opencode-skill") return skillFindings(file, text);
  if (kind === "opencode-agent") return agentFindings(text);
  if (kind === "opencode-command") return commandFindings(text);
  if (kind === "opencode-plugin") return pluginFindings(text);
  if (kind === "opencode-config") return configFindings(file, text);
  if (kind === "opencode-cli") {
    const { error } = parseJsonc(text);
    return error ? [finding("cli:parse", "problem", `This file ${error}.`, "OpenCode rejects a cli.json it can't read.", OC_RULES.cliOnly)] : [];
  }
  return [];
}

function configFindings(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const { data, error } = parseJsonc(text);
  if (error) return [finding("config:parse", "problem", `This file ${error.replace(/^isn't valid JSON: /, "isn't valid JSON (")}${error.startsWith("isn't valid JSON: ") ? ")" : ""}.`, "OpenCode reads JSON with comments and trailing commas, but nothing else.", OC_RULES.formats)];
  const keys = new Set(ocConfigKeys().map((k) => k.key));
  const isProject = !isInside(file, OPENCODE_DIR);
  for (const k of Object.keys(data ?? {})) {
    if (k === "$schema") continue;
    if (OC_V1_NAMES[k]) {
      const both = data![OC_V1_NAMES[k]] !== undefined && sameMeaning(k);
      out.push(finding(`config:v1:${k}`, "note", `${k} is OpenCode 1's name${sameMeaning(k) ? ` for ${OC_V1_NAMES[k]}` : ""}.`, both ? `This file sets ${OC_V1_NAMES[k]} too, which wins.` : "OpenCode 2 still reads it.", both ? OC_RULES.v2Wins : OC_RULES.v1Read));
    } else if (OC_IGNORED[k]) out.push(finding(`config:ignored:${k}`, "warning", `OpenCode 2 ignores ${k}.`, OC_IGNORED[k], OC_RULES.ignored));
    else if (OC_TO_CLI.has(k)) out.push(finding(`config:${k}`, "note", `${k} belongs in cli.json now.`, "OpenCode moves it there itself when it can.", OC_RULES.cliJson));
    else if (k === "lsp") out.push(finding("config:lsp", "note", "OpenCode 2 keeps lsp but doesn't run language servers.", "Use the project's lint or typecheck commands instead.", OC_RULES.lspIdle));
    else if (k === "instructions") out.push(finding("config:instructions", "note", "OpenCode 2 doesn't read the files listed under instructions yet.", "Put the guidance in an AGENTS.md instead.", OC_RULES.instructionsUnused));
    else if (k === "update" && isProject) out.push(finding("config:update", "note", "OpenCode ignores update in a project's file.", "Set it in your own opencode.json.", OC_RULES.updateGlobal));
    else if (keys.size && !keys.has(k)) out.push(finding(`config:unknown:${k}`, "note", `OpenCode's config page has no setting ${k}.`, "Check the spelling. A newer OpenCode than its docs may know it.", OC_RULES.formats));
  }
  const mcp = isObj(data?.mcp) ? data!.mcp : null;
  if (mcp) {
    const v1 = Object.keys(mcp).filter((k) => k !== "servers" && k !== "timeout" && isObj(mcp[k]));
    if (v1.length) out.push(finding("config:mcp-v1", "note", `${v1.join(", ")} ${v1.length === 1 ? "sits" : "sit"} straight under mcp, the OpenCode 1 way.`, "OpenCode 2 reads them; its own place is mcp.servers.", OC_RULES.mcpV1));
    const servers = isObj(mcp.servers) ? mcp.servers : {};
    const enabled = Object.entries(servers).filter(([, v]) => isObj(v) && v.enabled !== undefined).map(([k]) => k);
    if (enabled.length) out.push(finding("config:mcp-enabled", "warning", `${enabled.join(", ")} ${enabled.length === 1 ? "uses" : "use"} enabled under mcp.servers.`, "OpenCode 2 uses disabled: true there.", OC_RULES.mcpDisabled));
  }
  return out;
}

/** Every rule this module stands on, for the test that checks the docs still say them. */
export const OPENCODE_CITES = Object.values(OC_RULES);
