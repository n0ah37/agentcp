import fs from "node:fs/promises";
import path from "node:path";

import type { Definition, DefinitionsView, FieldSpec, FileKind, ProjectRef } from "../../shared/types.ts";
import { checkDefinition, tally } from "./checks.ts";
import { anchorFor, docRef, section } from "./docs.ts";
import { exists, fileInfo, readText, walk } from "./fsx.ts";
import { fieldsFromDocs, splitFrontmatter } from "./frontmatter.ts";
import { lockFor } from "./locks.ts";
import { CLAUDE_DIR, MANAGED_DIR, tilde } from "./paths.ts";
import { listPlugins } from "./plugins.ts";
import { readScopes, resolveValue } from "./settings.ts";

/**
 * Subagents, output styles and skills: Markdown files with YAML frontmatter,
 * found in the user folder, the project, and every enabled plugin. The fields
 * each kind accepts are read from the documentation's own field tables.
 */

type Kind = "agent" | "style" | "skill";

const SPEC: Record<Kind, { folder: string; doc: [string, string]; fields: [string, string]; fileKind: FileKind }> = {
  agent: { folder: "agents", doc: ["sub-agents", ""], fields: ["sub-agents", "frontmatter-reference"], fileKind: "agent" },
  style: { folder: "output-styles", doc: ["output-styles", ""], fields: ["output-styles", "frontmatter-reference"], fileKind: "style" },
  skill: { folder: "skills", doc: ["skills", ""], fields: ["skills", "frontmatter-reference"], fileKind: "skill" },
};

export function fieldsFor(kind: Kind): FieldSpec[] {
  return fieldsFromDocs(...SPEC[kind].fields);
}

/**
 * The built-in output styles, read from the table on the output styles page,
 * each with its own section of that page, which is what the app shows for it.
 */
export function builtinStyles(): { name: string; description: string; body: string }[] {
  const md = section("output-styles", "built-in-output-styles") ?? "";
  const body = (name: string) => (section("output-styles", anchorFor(name)) ?? "").replace(/^#+ .*\n+/, "");
  const out = [{ name: "Default", description: "Claude Code's standard instructions for software engineering tasks.", body: body("Default") }];
  for (const line of md.split("\n")) {
    const m = /^\|\s*\[([^\]]+)\]\(#[^)]+\)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|/.exec(line);
    if (m) out.push({ name: m[1], description: m[2].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"), body: `${body(m[1])}\n\n**Use it when:** ${m[3]}` });
  }
  return out;
}

export type Plugin = { id: string; path: string };

/** The plugins that load here, from every origin Claude Code has: marketplace, synced from claude.ai, and skills folders. */
export async function enabledPlugins(project: string | null): Promise<Plugin[]> {
  const ref = project ? { path: project, display: tilde(project), name: path.basename(project), group: "", lastActive: null, isWorktree: false, exists: true } : null;
  return (await listPlugins(ref)).filter((p) => p.on).map((p) => ({ id: p.id, path: p.path }));
}

async function filesIn(kind: Kind, root: string): Promise<string[]> {
  const dir = path.join(root, SPEC[kind].folder);
  if (kind === "skill") {
    return walk(dir, { maxDepth: 1, match: (n) => n === "SKILL.md" });
  }
  return walk(dir, { maxDepth: kind === "agent" ? 6 : 0, match: (n) => n.endsWith(".md") });
}

async function toDefinition(
  kind: Kind,
  file: string,
  source: Definition["source"],
  where: string,
  plugin: string | null,
  fields: FieldSpec[],
): Promise<Definition> {
  const t = await readText(file);
  const fm = t ? splitFrontmatter(t.text) : null;
  const fallback = kind === "skill" ? path.basename(path.dirname(file)) : path.basename(file, ".md");
  // A field the YAML parser refused still reads as its line's text, the way Claude Code shows it.
  const loose = fm?.error && t ? looseFields(t.text, fm.endLine) : {};
  const name = String(fm?.data.name ?? loose.name ?? fallback);
  const findings = t && source !== "plugin" ? checkDefinition(kind, t.text, fields) : [];
  const lock = source === "plugin" || source === "managed" ? { editable: false, lockedBecause: source === "plugin" ? "Plugin files are managed by Claude Code and are not written here." : "Your organization manages this file." } : lockFor(file);
  return {
    file: await fileInfo(file, SPEC[kind].fileKind, lock),
    name: plugin && kind !== "style" ? `${plugin.split("@")[0]}:${name}` : name,
    description: String(fm?.data.description ?? loose.description ?? ""),
    where,
    source,
    plugin,
    counts: tally(findings),
  };
}

export async function definitionsView(kind: Kind, project: ProjectRef | null): Promise<DefinitionsView> {
  const fields = fieldsFor(kind);
  const P = project?.path ?? null;
  const items: Definition[] = [];
  const locations: DefinitionsView["locations"] = [];

  const userRoot = CLAUDE_DIR;
  const userDir = path.join(userRoot, SPEC[kind].folder);
  locations.push({ label: "User", path: userDir, display: tilde(userDir), exists: await exists(userDir) });
  for (const f of await filesIn(kind, userRoot)) items.push(await toDefinition(kind, f, "user", "User", null, fields));

  if (P) {
    const projRoot = path.join(P, ".claude");
    const projDir = path.join(projRoot, SPEC[kind].folder);
    locations.push({ label: "This project", path: projDir, display: tilde(projDir), exists: await exists(projDir) });
    for (const f of await filesIn(kind, projRoot)) items.push(await toDefinition(kind, f, "project", "This project", null, fields));
  }

  if (kind === "agent") {
    for (const f of await filesIn(kind, path.join(MANAGED_DIR, ".claude"))) items.push(await toDefinition(kind, f, "managed", "Your organization", null, fields));
  }

  for (const pl of await enabledPlugins(P)) {
    for (const f of await filesIn(kind, pl.path)) items.push(await toDefinition(kind, f, "plugin", pl.id.split("@")[0], pl.id, fields));
  }

  const view: DefinitionsView = {
    project,
    kind,
    items,
    locations,
    fields,
    doc: docRef(SPEC[kind].doc[0]),
  };

  if (kind === "style") {
    const { effective } = resolveValue(await readScopes(P), ["outputStyle"]);
    const activeName = typeof effective?.value === "string" ? effective.value : "Default";
    const builtins: Definition[] = builtinStyles().map((b) => ({
      file: { path: `builtin:${b.name}`, display: "Built into Claude Code", name: b.name, kind: "style", exists: true, bytes: 0, lines: 0, modified: null, isSymlink: false, linkTarget: null, hash: null, editable: false, lockedBecause: "Built into Claude Code.", unreadable: false },
      body: b.body,
      name: b.name,
      description: b.description,
      where: "Built in",
      source: "builtin",
      plugin: null,
      counts: { problem: 0, warning: 0, note: 0 },
    }));
    view.items = [...builtins, ...items];
    for (const i of view.items) i.active = i.name === activeName;
    view.active = { name: activeName, setIn: effective?.file ?? null };
  }
  return view;
}

/** Findings for one definition file, optionally for unsaved text. */
export async function definitionFindings(kind: Kind, file: string, text?: string) {
  const body = text ?? (await readText(file))?.text ?? "";
  return checkDefinition(kind, body, fieldsFor(kind));
}

export function kindOfDefinition(file: string): Kind | null {
  const parts = file.split(path.sep);
  if (path.basename(file) === "SKILL.md" && parts.includes("skills")) return "skill";
  if (parts.includes("agents")) return "agent";
  if (parts.includes("output-styles")) return "style";
  return null;
}

/**
 * Marks each skill that the other agent also has by name: the same file (one
 * folder both read, or a link), a word-for-word copy, or a different skill.
 */
export async function pairSkills(items: Definition[], others: Definition[], agent: "claude" | "codex"): Promise<void> {
  const real = async (p: string) => fs.realpath(p).catch(() => p);
  const byName = new Map(others.map((o) => [o.name, o]));
  for (const i of items) {
    const o = byName.get(i.name);
    if (!o) continue;
    const relation = (await real(i.file.path)) === (await real(o.file.path)) ? "same" : i.file.hash && i.file.hash === o.file.hash ? "copy" : "different";
    i.twin = { agent, relation, path: o.file.path };
  }
}

/** `name` and `description` read line by line, for frontmatter that isn't valid YAML. */
function looseFields(text: string, endLine: number): { name?: string; description?: string } {
  const out: Record<string, string> = {};
  for (const l of text.split("\n").slice(1, Math.max(endLine - 1, 1))) {
    const m = /^(name|description):[ \t]*(.*?)\s*$/.exec(l);
    if (m && !(m[1] in out)) out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}
