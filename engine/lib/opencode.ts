import fs from "node:fs/promises";
import path from "node:path";

import type { CodexEntry, Definition, DefinitionsView, DocRef, FieldSpec, FileKind, Finding, Level, McpServer, McpView, MissingSlot, OpencodeLayer, OpencodeSettingsView, OpencodeView, ProjectRef } from "../../shared/types.ts";
import { findImports } from "./checks.ts";
import { docRef, opencodeSchema } from "./docs.ts";
import { splitFrontmatter } from "./frontmatter.ts";
import { fileInfo, readText } from "./fsx.ts";
import { lockFor } from "./locks.ts";
import { cleanUrl, maskArgs } from "./mcp.ts";
import { OC, OC_RULES, ocAgentFields, ocBuiltinAgents, ocCite, ocConfigKeys, ocRule, ocSkillPlaces, type OpencodeCite } from "./opencode-docs.ts";
import { CLAUDE_DIR, HOME, OPENCODE_DIR, expandHome, isInside, tilde } from "./paths.ts";

/**
 * What OpenCode reads, as its documentation describes it (opencode-docs.ts):
 * its instructions (AGENTS.md, with Claude Code's CLAUDE.md as the fallback),
 * its config files (opencode.json or .jsonc, merged in its order), agents,
 * skills and MCP servers. The files are read from disk and never written
 * here; edits go through the app's one write path like any other file.
 *
 * The app sees its own environment, not the shell OpenCode runs in, so
 * anything that turns on a variable (OPENCODE_CONFIG, OPENCODE_DISABLE_CLAUDE_CODE…)
 * is applied when the app was started with it, and said to depend on it.
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

/** JSON with comments and trailing commas, which OpenCode accepts ("JSONC"), as plain JSON. */
export function parseJsonc(text: string): { data: Record<string, unknown> | null; error: string | null } {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) out += text[i++] === "\n" ? "\n" : "";
      i++;
    } else out += c;
  }
  out = out.replace(/,(\s*[}\]])/g, "$1");
  if (!out.trim()) return { data: {}, error: null };
  try {
    const data = JSON.parse(out) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? { data: data as Record<string, unknown>, error: null } : { data: null, error: "isn't a JSON object" };
  } catch (e) {
    return { data: null, error: `isn't valid JSON: ${(e as Error).message.split("\n")[0]}` };
  }
}

/** The project folder and every folder above it, up to the repository root ("the nearest Git directory"), root first. */
export async function chainToGitRoot(dir: string): Promise<string[]> {
  const out: string[] = [];
  let cur = dir;
  for (;;) {
    out.unshift(cur);
    if (await exists(path.join(cur, ".git"))) return out;
    const up = path.dirname(cur);
    if (up === cur || cur === HOME) return [dir];
    cur = up;
  }
}

const env = (k: string) => !!process.env[k] && process.env[k] !== "0";

// ------------------------------------------------------------------ config

type Layer = OpencodeLayer & { data: Record<string, unknown> | null };

/** OpenCode's config files that exist here, in the order its config page lists ("Precedence order"); later ones win. */
export async function configLayers(project: ProjectRef | null): Promise<Layer[]> {
  const out: Layer[] = [];
  const add = async (file: string, label: string, kind: Layer["kind"], note: string | null = null, always = false) => {
    const t = await readText(file);
    if (!t && !always) return;
    const parsed = t ? parseJsonc(t.text) : { data: null, error: null };
    out.push({ path: file, display: tilde(file), label, kind, exists: !!t, broken: parsed.error, note, data: parsed.data });
  };
  await add(path.join(OPENCODE_DIR, "opencode.json"), "User", "user", null, !(await exists(path.join(OPENCODE_DIR, "opencode.jsonc"))));
  await add(path.join(OPENCODE_DIR, "opencode.jsonc"), "User", "user");
  if (process.env.OPENCODE_CONFIG) await add(path.resolve(expandHome(process.env.OPENCODE_CONFIG)), "OPENCODE_CONFIG", "custom", "Read because OPENCODE_CONFIG names it.");
  if (project) {
    const dirs = await chainToGitRoot(project.path);
    for (const d of dirs) {
      const label = d === project.path ? "This project" : `${tilde(d)} (repository)`;
      await add(path.join(d, "opencode.json"), label, "project", null, d === project.path && !(await exists(path.join(d, "opencode.jsonc"))));
      await add(path.join(d, "opencode.jsonc"), label, "project");
      await add(path.join(d, ".opencode", "opencode.json"), `${label}, .opencode`, "project");
      await add(path.join(d, ".opencode", "opencode.jsonc"), `${label}, .opencode`, "project");
    }
  }
  for (const n of ["opencode.json", "opencode.jsonc"]) await add(path.join("/Library/Application Support/opencode", n), "Managed", "managed", "Set by your organization; it wins over every other file.");
  return out;
}

/** Keys whose lists OpenCode adds together across files rather than replacing. */
const CONCAT = new Set(["instructions", "plugin"]);

function merge(layers: Layer[]): { value: Record<string, unknown>; from: Map<string, Layer[]> } {
  const value: Record<string, unknown> = {};
  const from = new Map<string, Layer[]>();
  for (const l of layers) {
    for (const [k, v] of Object.entries(l.data ?? {})) {
      if (k === "$schema") continue;
      from.set(k, [...(from.get(k) ?? []), l]);
      const cur = value[k];
      if (CONCAT.has(k) && Array.isArray(cur) && Array.isArray(v)) value[k] = [...cur, ...v];
      else if (cur && v && typeof cur === "object" && typeof v === "object" && !Array.isArray(cur) && !Array.isArray(v)) value[k] = deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>);
      else value[k] = v;
    }
  }
  return { value, from };
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    out[k] = cur && v && typeof cur === "object" && typeof v === "object" && !Array.isArray(cur) && !Array.isArray(v) ? deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}

const publicLayer = (l: Layer): OpencodeLayer => ({ path: l.path, display: l.display, label: l.label, kind: l.kind, exists: l.exists, broken: l.broken, note: l.note });

// ------------------------------------------------------------ instructions

/**
 * OpenCode's instruction files for a project (rules page, "Precedence"): from
 * the project folder up to the repository root it looks for AGENTS.md, then
 * CLAUDE.md, and the first file found wins; your own file is
 * ~/.config/opencode/AGENTS.md, else ~/.claude/CLAUDE.md; and the files
 * opencode.json lists under `instructions` are added to those.
 */
export async function opencodeView(project: ProjectRef | null): Promise<OpencodeView> {
  const levels: Level[] = [{ key: "oc-home", kind: "user", label: tilde(OPENCODE_DIR), covers: "Every project", path: OPENCODE_DIR, depth: 0 }];
  const entries: CodexEntry[] = [];
  const missing: MissingSlot[] = [];
  const noClaude = env("OPENCODE_DISABLE_CLAUDE_CODE");
  const noClaudePrompt = noClaude || env("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT");

  const entry = async (p: string, level: string, loads: "read" | "not-read", reason: string | null): Promise<void> => {
    const info = await fileInfo(p, "opencode-instructions", lockFor(p));
    entries.push({ id: `oc:${p}`, file: info, level, loads, reason, bytesRead: loads === "read" ? info.bytes : 0 });
  };

  // Yours: ~/.config/opencode/AGENTS.md wins over ~/.claude/CLAUDE.md.
  const globalAgents = path.join(OPENCODE_DIR, "AGENTS.md");
  const globalClaude = path.join(CLAUDE_DIR, "CLAUDE.md");
  const hasGlobal = await exists(globalAgents);
  if (hasGlobal) await entry(globalAgents, "oc-home", "read", null);
  else missing.push({ id: `oc-missing:${globalAgents}`, level: "oc-home", path: globalAgents, display: tilde(globalAgents), label: "AGENTS.md", hint: "Your instructions for OpenCode in every project", template: "# My instructions for OpenCode\n\n" });
  if (await exists(globalClaude)) {
    await entry(globalClaude, "oc-home", hasGlobal || noClaudePrompt ? "not-read" : "read", hasGlobal ? `${tilde(globalAgents)} is read instead` : noClaudePrompt ? "Turned off by OPENCODE_DISABLE_CLAUDE_CODE in the app's environment" : null);
  }

  const remote: OpencodeView["remote"] = [];
  const layers = await configLayers(project);
  if (project) {
    const dirs = await chainToGitRoot(project.path);
    for (const [i, dir] of dirs.entries()) {
      const isProject = dir === project.path;
      levels.push({
        key: `oc-dir:${dir}`,
        kind: isProject ? "project" : "folder",
        label: i === 0 ? tilde(dir) : path.relative(dirs[i - 1], dir) + "/",
        covers: i === 0 ? (isProject ? "This project" : "This repository") : isProject ? "This project" : "Every folder below",
        path: dir,
        depth: i,
      });
    }
    // Nearest first: AGENTS.md anywhere on the way up beats CLAUDE.md.
    const up = [...dirs].reverse();
    const found = async (name: string) => {
      const hits: string[] = [];
      for (const d of up) if (await exists(path.join(d, name))) hits.push(path.join(d, name));
      return hits;
    };
    const agents = await found("AGENTS.md");
    const claude = await found("CLAUDE.md");
    const winner = agents[0] ?? (noClaude ? undefined : claude[0]);
    for (const p of [...agents, ...claude].sort((a, b) => a.length - b.length)) {
      const level = `oc-dir:${path.dirname(p)}`;
      if (p === winner) await entry(p, level, "read", null);
      else if (path.basename(p) === "CLAUDE.md" && noClaude) await entry(p, level, "not-read", "Turned off by OPENCODE_DISABLE_CLAUDE_CODE in the app's environment");
      else await entry(p, level, "not-read", winner ? `${path.relative(path.dirname(p), winner) || path.basename(winner)} is read instead` : null);
    }
    if (!agents.length) {
      const p = path.join(project.path, "AGENTS.md");
      missing.push({ id: `oc-missing:${p}`, level: `oc-dir:${project.path}`, path: p, display: tilde(p), label: "AGENTS.md", hint: winner ? "OpenCode reads CLAUDE.md until there is one" : "Instructions OpenCode reads in this project", template: "# " + path.basename(project.path) + "\n\n" });
    }
  }

  // `instructions` in opencode.json: paths and globs, added to AGENTS.md.
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
        await entry(p, "oc-config", "read", null);
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
    rules: [OC_RULES.walkUp, OC_RULES.firstWins, OC_RULES.claudeProject, OC_RULES.claudeGlobal, OC_RULES.instructionsCombined].map(ocRule),
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
    { name: "name", required: "yes", description: "Lowercase letters, digits and single hyphens, the same as the skill's folder." },
    { name: "description", required: "yes", description: "1 to 1,024 characters: when OpenCode should use the skill." },
    { name: "license", required: "no", description: "" },
    { name: "compatibility", required: "no", description: "" },
    { name: "metadata", required: "no", description: "" },
  ];
}

/** The skills OpenCode loads, from the six folders its skills page lists; project folders on every level up to the repository root. */
export async function opencodeSkills(project: ProjectRef | null): Promise<{ items: Definition[]; locations: DefinitionsView["locations"]; fields: FieldSpec[]; doc: DocRef; findings: Finding[] }> {
  const dirs = project ? [...(await chainToGitRoot(project.path))].reverse() : [];
  const noClaude = env("OPENCODE_DISABLE_CLAUDE_CODE") || env("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS");
  const places: { dir: string; label: string; source: Definition["source"]; off: boolean }[] = [];
  for (const p of ocSkillPlaces()) {
    const claude = p.pattern.includes(".claude/");
    if (p.scope === "user") places.push({ dir: p.pattern.startsWith("~/.config/opencode/") ? path.join(OPENCODE_DIR, p.pattern.slice("~/.config/opencode/".length)) : expandHome(p.pattern), label: p.label, source: "user", off: claude && noClaude });
    else for (const d of dirs) places.push({ dir: path.join(d, p.pattern), label: d === project?.path ? p.label : `${p.label}, ${tilde(d)}`, source: "project", off: claude && noClaude });
  }
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
      const f = skillFindings(file, t.text);
      items.push({
        file: await fileInfo(file, "opencode-skill", lockFor(file)),
        name: String(fm.data.name ?? n),
        description: String(fm.data.description ?? ""),
        where: p.label,
        source: p.source,
        plugin: null,
        counts: { problem: f.filter((x) => x.severity === "problem").length, warning: f.filter((x) => x.severity === "warning").length, note: 0 },
        active: !p.off,
      });
    }
  }
  const findings: Finding[] = [];
  const byName = new Map<string, number>();
  for (const i of items) byName.set(i.name, (byName.get(i.name) ?? 0) + 1);
  const twice = [...byName].filter(([, n]) => n > 1).map(([n]) => n);
  if (twice.length) findings.push(finding("skills:unique", "warning", `${twice.length === 1 ? `Two skills are named ${twice[0]}` : `${twice.length} skill names are used twice`}.`, "OpenCode's docs ask for names that are unique across every folder it reads.", OC_RULES.skillUnique));
  return { items, locations, fields: skillFields(), doc: docRef(OC.skills, "place-files"), findings };
}

function skillFindings(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  const fm = splitFrontmatter(text);
  const name = typeof fm.data.name === "string" ? fm.data.name : null;
  const desc = typeof fm.data.description === "string" ? fm.data.description : null;
  if (!name) out.push(finding("skill:name", "problem", "name is missing from the frontmatter.", "OpenCode needs a name to list the skill.", OC_RULES.skillNameRegex, 1));
  else {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) out.push(finding("skill:name-form", "warning", `“${name}” isn't a name OpenCode's docs allow.`, "Use 1 to 64 lowercase letters or digits, with single hyphens between words.", OC_RULES.skillNameRegex, 1));
    if (name !== path.basename(path.dirname(file))) out.push(finding("skill:name-dir", "warning", `The name doesn't match the folder, ${path.basename(path.dirname(file))}.`, "OpenCode's docs ask for the same name on both.", OC_RULES.skillNameDir, 1));
  }
  if (!desc) out.push(finding("skill:description", "problem", "description is missing from the frontmatter.", "OpenCode picks a skill by its description.", OC_RULES.skillDescLen, 1));
  else if (desc.length > 1024) out.push(finding("skill:description-long", "warning", `The description is ${desc.length.toLocaleString("en-US")} characters.`, "OpenCode's docs allow up to 1,024.", OC_RULES.skillDescLen, 1));
  return out;
}

// ------------------------------------------------------------------ agents

/** OpenCode's agents: Markdown files in an agents folder (global and per project), those defined under `agent` in opencode.json, and the built-in ones its docs list. */
export async function opencodeAgents(project: ProjectRef | null): Promise<{ items: Definition[]; locations: DefinitionsView["locations"]; fields: FieldSpec[]; doc: DocRef }> {
  const places: { dir: string; label: string; source: Definition["source"] }[] = [];
  if (project) for (const d of [...(await chainToGitRoot(project.path))].reverse()) for (const sub of ["agents", "agent"]) places.push({ dir: path.join(d, ".opencode", sub), label: d === project.path ? "This project" : tilde(d), source: "project" });
  for (const sub of ["agents", "agent"]) places.push({ dir: path.join(OPENCODE_DIR, sub), label: "User", source: "user" });
  const items: Definition[] = [];
  const locations: DefinitionsView["locations"] = [];
  for (const p of places) {
    const there = await exists(p.dir);
    // The singular folder is shown only when it's used; the docs keep it for backwards compatibility.
    if (there || p.dir.endsWith(`${path.sep}agents`)) locations.push({ label: p.label, path: p.dir, display: tilde(p.dir), exists: there });
    for (const file of await mdFiles(p.dir)) {
      const t = await readText(file);
      if (!t) continue;
      const fm = splitFrontmatter(t.text);
      const f = agentFindings(t.text);
      items.push({
        file: await fileInfo(file, "opencode-agent", lockFor(file)),
        name: path.relative(p.dir, file).replace(/\.md$/, "").split(path.sep).join("/"),
        description: String(fm.data.description ?? ""),
        where: p.label,
        source: p.source,
        plugin: null,
        counts: { problem: f.filter((x) => x.severity === "problem").length, warning: f.filter((x) => x.severity === "warning").length, note: 0 },
        active: fm.data.disable !== true,
      });
    }
  }
  // Agents defined in opencode.json, shown with the file that defines them.
  for (const l of await configLayers(project)) {
    for (const [name, raw] of Object.entries((l.data?.agent ?? {}) as Record<string, Record<string, unknown> | null>)) {
      if (items.some((i) => i.name === name)) continue;
      const builtin = ocBuiltinAgents().some((b) => b.name === name);
      items.push({
        file: await fileInfo(l.path, "opencode-config", lockFor(l.path)),
        name,
        description: String(raw?.description ?? (builtin ? "Built-in agent, changed in opencode.json" : "")),
        where: `In ${l.label === "User" ? "your opencode.json" : `${l.label}'s opencode.json`}`,
        source: l.kind === "user" ? "user" : l.kind === "managed" ? "managed" : "project",
        plugin: null,
        counts: { problem: 0, warning: 0, note: 0 },
        active: raw?.disable !== true,
      });
    }
  }
  const custom = new Set(items.map((i) => i.name));
  for (const b of ocBuiltinAgents()) {
    items.push({
      file: { path: `builtin:opencode:${b.name}`, display: "Built into OpenCode", name: b.name, kind: "opencode-agent", exists: true, bytes: 0, lines: 0, modified: null, isSymlink: false, linkTarget: null, hash: null, editable: false, lockedBecause: "Built into OpenCode.", unreadable: false },
      name: b.name,
      description: `${b.mode === "primary" ? "Primary agent. " : "Subagent. "}${b.description}`,
      where: "Built in",
      source: "builtin",
      plugin: null,
      counts: { problem: 0, warning: 0, note: 0 },
      shadowedBy: custom.has(b.name) ? b.name : null,
    });
  }
  return { items, locations, fields: ocAgentFields(), doc: docRef(OC.agents, "markdown") };
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

function agentFindings(text: string): Finding[] {
  const out: Finding[] = [];
  const fm = splitFrontmatter(text);
  const d = fm.data;
  if (!d.description) out.push(finding("agent:description", "problem", "description is missing.", "OpenCode's docs make description required: it's how OpenCode decides when to use the agent.", OC_RULES.descRequired, 1));
  if (d.maxSteps !== undefined) out.push(finding("agent:maxSteps", "warning", "maxSteps is deprecated.", "Use steps instead.", OC_RULES.maxStepsDeprecated, 1));
  if (d.tools !== undefined) out.push(finding("agent:tools", "warning", "tools is deprecated.", "Use permission instead.", OC_RULES.agentToolsDeprecated, 1));
  if (d.hidden !== undefined && d.mode !== "subagent") out.push(finding("agent:hidden", "warning", "hidden has no effect here.", "It applies only to agents with mode: subagent.", OC_RULES.hiddenSubagentOnly, 1));
  return out;
}

// --------------------------------------------------------------------- MCP

/** OpenCode's MCP servers: the `mcp` key, merged across its config files; local ones run a command, remote ones connect to an address. */
export async function opencodeMcp(project: ProjectRef | null): Promise<McpView> {
  const layers = await configLayers(project);
  const servers = new Map<string, McpServer>();
  for (const l of layers) {
    for (const [name, raw] of Object.entries((l.data?.mcp ?? {}) as Record<string, Record<string, unknown> | null>)) {
      const r = raw ?? {};
      const prev = servers.get(name);
      // An entry with only `enabled` turns a server from another file on or off.
      const type = r.type ?? (prev ? (prev.transport === "stdio" ? "local" : "remote") : undefined);
      const command = Array.isArray(r.command) ? r.command.map(String) : null;
      const off = r.enabled === false;
      const secrets = [...Object.keys((r.environment ?? {}) as object), ...Object.keys((r.headers ?? {}) as object).map((h) => `${h} header`)];
      const where = l.label === "User" ? "Your opencode.json" : l.kind === "managed" ? "Managed" : l.label;
      servers.set(name, {
        name,
        scope: l.kind === "user" ? "user" : l.kind === "managed" ? "managed" : "project",
        where,
        file: l.display,
        transport: type === "remote" ? "http" : "stdio",
        endpoint: command ? maskArgs(command).join(" ") : typeof r.url === "string" ? cleanUrl(r.url) : (prev?.endpoint ?? ""),
        secrets: secrets.length ? secrets : (prev?.secrets ?? []),
        status: off ? "off" : "on",
        note: off ? "Turned off with enabled: false." : prev ? `Also set in ${prev.where}; ${where === "Your opencode.json" ? "yours" : "this file's"} values win where both set one.` : "OpenCode connects to it.",
        findings: [],
      });
    }
  }
  return {
    project,
    agent: "opencode",
    servers: [...servers.values()],
    files: layers.map((l) => ({ label: l.label, display: l.display, exists: l.exists, broken: l.broken })),
    doc: docRef(OC.mcp, "enable"),
  };
}

// ---------------------------------------------------------------- settings

/** Every top-level key OpenCode's schema has, with the value in force here and the file that set it. */
export async function opencodeSettings(project: ProjectRef | null, capturedAt: string | null): Promise<OpencodeSettingsView> {
  const layers = await configLayers(project);
  const { value, from } = merge(layers.filter((l) => l.data));
  const keys = ocConfigKeys();
  const known = new Set(keys.map((k) => k.key));
  const rows = keys.map((k) => {
    const files = from.get(k.key) ?? [];
    const v = value[k.key];
    return {
      key: k.key,
      type: k.type,
      description: k.description,
      options: k.enum,
      deprecated: k.deprecated,
      value: v === undefined ? null : show(v),
      setIn: files.length ? files[files.length - 1].display : null,
      alsoIn: files.slice(0, -1).map((f) => f.display),
    };
  });
  const unknown = opencodeSchema() ? layers.flatMap((l) => Object.keys(l.data ?? {}).filter((k) => k !== "$schema" && !known.has(k)).map((key) => ({ key, file: l.display }))) : [];
  return {
    project,
    layers: layers.map(publicLayer),
    rows,
    unknown,
    capturedAt,
    doc: docRef(OC.config, "precedence-order"),
    rules: [OC_RULES.merged, OC_RULES.conflictOnly, OC_RULES.projectWalk, OC_RULES.managedWins].map(ocRule),
  };
}

/** A value in a line: secrets in strings that look like keys are hidden. */
function show(v: unknown): string {
  if (typeof v === "string") return /^(sk-|ghp_|xox|AKIA)|[A-Za-z0-9_-]{32,}/.test(v) ? "(hidden)" : v;
  const s = JSON.stringify(v, (_k, x) => (typeof x === "string" && /^(sk-|ghp_|xox|AKIA)|[A-Za-z0-9_-]{32,}/.test(x) ? "(hidden)" : x));
  return s.length > 160 ? s.slice(0, 157) + "…" : s;
}

// -------------------------------------------------------------- file kinds

/** Which OpenCode file a path is; null for anything that isn't OpenCode's. `agent` is the screen's agent. */
export function opencodeKindFor(abs: string, agent: string | null): FileKind | null {
  const n = path.basename(abs);
  const inOc = isInside(abs, OPENCODE_DIR) || abs.includes(`${path.sep}.opencode${path.sep}`);
  if ((inOc || agent === "opencode") && (n === "opencode.json" || n === "opencode.jsonc")) return "opencode-config";
  if (inOc && n.endsWith(".md") && new RegExp(`\\${path.sep}agents?\\${path.sep}`).test(abs)) return "opencode-agent";
  if (n === "SKILL.md" && (inOc || agent === "opencode")) return "opencode-skill";
  if (isInside(abs, OPENCODE_DIR) && n === "AGENTS.md") return "opencode-instructions";
  if (agent === "opencode" && (n === "AGENTS.md" || n === "CLAUDE.md")) return "opencode-instructions";
  return null;
}

export const OPENCODE_ABOUT: Partial<Record<FileKind, { summary: string; doc: () => DocRef }>> = {
  "opencode-instructions": { summary: "Instructions OpenCode reads when a session starts. It reads AGENTS.md, or CLAUDE.md when there's none, from the project folder up.", doc: () => docRef(OC.rules, "precedence") },
  "opencode-config": { summary: "OpenCode's settings, in JSON with comments allowed. Its files are merged; later ones win only where they set the same key.", doc: () => docRef(OC.config, "precedence-order") },
  "opencode-agent": { summary: "An OpenCode agent. The file name is its name; the frontmatter sets how it runs, and the text below is its prompt.", doc: () => docRef(OC.agents, "markdown") },
  "opencode-skill": { summary: "A skill. OpenCode lists its name and description, and reads the rest when it picks the skill.", doc: () => docRef(OC.skills, "write-frontmatter") },
};

/** OpenCode's checks for one file, each citing OpenCode's docs. */
export function opencodeFindings(kind: FileKind, file: string, text: string): Finding[] {
  if (kind === "opencode-skill") return skillFindings(file, text);
  if (kind === "opencode-agent") return agentFindings(text);
  if (kind === "opencode-instructions") {
    const imports = findImports(text);
    return imports.length
      ? [finding("instructions:imports", "note", `OpenCode doesn't follow the ${imports.length === 1 ? "@ reference" : `${imports.length} @ references`} here.`, "It reads those lines as plain text. List the files under instructions in opencode.json to have OpenCode read them.", OC_RULES.noImports)]
      : [];
  }
  if (kind === "opencode-config") {
    const out: Finding[] = [];
    const { data, error } = parseJsonc(text);
    if (error) return [finding("config:parse", "problem", `This file ${error.replace(/^isn't valid JSON: /, "isn't valid JSON (")}${error.startsWith("isn't valid JSON: ") ? ")" : ""}.`, "OpenCode reads JSON with comments and trailing commas, but nothing else.", OC_RULES.formats)];
    const keys = new Set(ocConfigKeys().map((k) => k.key));
    for (const k of Object.keys(data ?? {})) {
      if (["theme", "keybinds", "tui"].includes(k)) out.push(finding(`config:${k}`, "note", `${k} belongs in tui.json now.`, "OpenCode moves it there itself when it can.", OC_RULES.tuiLegacy));
      else if (keys.size && k !== "$schema" && !keys.has(k)) out.push(finding(`config:unknown:${k}`, "note", `OpenCode's published schema has no key ${k}.`, "Check the spelling against the schema the config page links to. A newer OpenCode than its docs may know it.", OC_RULES.schema));
    }
    return out;
  }
  return [];
}

/** Every rule this module stands on, for the test that checks the docs still say them. */
export const OPENCODE_CITES = Object.values(OC_RULES);
