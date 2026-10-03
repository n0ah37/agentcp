import fs from "node:fs/promises";
import path from "node:path";

import type { DocRef, PluginInfo, PluginsView, ProjectRef } from "../../shared/types.ts";
import { docRef } from "./docs.ts";
import { exists, walk } from "./fsx.ts";
import { CLAUDE_DIR, tilde } from "./paths.ts";
import { readScopes, resolveValue } from "./settings.ts";

/**
 * Claude Code's plugins, the way the plugin loading reference describes them:
 * an id `<name>@<origin>`; marketplace installs recorded in
 * installed_plugins.json and turned on by `enabledPlugins`; plugins synced
 * from claude.ai (`@synced`, on unless turned off); and plugin folders saved
 * under a skills folder (`@skills-dir`, on when the manifest says so). What
 * each one adds comes from its folder: the default component folders, plus
 * the paths its manifest names.
 */

const ROOT = () => process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR ?? path.join(CLAUDE_DIR, "plugins");

type Manifest = Record<string, unknown> & { name?: string; version?: string; description?: string; author?: { name?: string } | string; defaultEnabled?: boolean };

async function json<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

const list = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const inside = (root: string, rel: string) => {
  const p = path.resolve(root, rel);
  return p === root || p.startsWith(root + path.sep) ? p : null;
};

type Named = { name: string; path: string };

async function names(dir: string, kind: "skill" | "md"): Promise<Named[]> {
  if (!(await exists(dir))) return [];
  if (kind === "skill") {
    if (await exists(path.join(dir, "SKILL.md"))) return [{ name: path.basename(dir), path: path.join(dir, "SKILL.md") }];
    return (await walk(dir, { maxDepth: 1, match: (n) => n === "SKILL.md" })).map((f) => ({ name: path.basename(path.dirname(f)), path: f }));
  }
  const st = await fs.stat(dir).catch(() => null);
  if (st?.isFile()) return [{ name: path.basename(dir, ".md"), path: dir }];
  return (await walk(dir, { maxDepth: 6, match: (n) => n.endsWith(".md") })).map((f) => ({ name: path.basename(f, ".md"), path: f }));
}

/** Server names from `.mcp.json` and the manifest's `mcpServers` (a path, an inline map, or a list of either). */
async function mcpNames(root: string, m: Manifest | null): Promise<string[]> {
  const out = new Set<string>();
  const add = (o: unknown) => {
    const servers = (o as { mcpServers?: unknown })?.mcpServers ?? o;
    if (servers && typeof servers === "object" && !Array.isArray(servers)) for (const k of Object.keys(servers)) out.add(k);
  };
  add(await json(path.join(root, ".mcp.json")));
  for (const v of Array.isArray(m?.mcpServers) ? m.mcpServers : m?.mcpServers ? [m.mcpServers] : []) {
    if (typeof v === "string") {
      const p = inside(root, v);
      if (p && p.endsWith(".json")) add(await json(p));
      else if (p) out.add(path.basename(p).replace(/\.(mcpb|dxt)$/, ""));
    } else add(v);
  }
  return [...out];
}

async function hookCount(root: string, m: Manifest | null): Promise<number> {
  let n = 0;
  const count = (o: unknown) => {
    const hooks = (o as { hooks?: unknown })?.hooks ?? o;
    if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return;
    for (const groups of Object.values(hooks as Record<string, unknown>)) {
      if (Array.isArray(groups)) for (const g of groups) n += Array.isArray((g as { hooks?: unknown[] })?.hooks) ? (g as { hooks: unknown[] }).hooks.length : 0;
    }
  };
  count(await json(path.join(root, "hooks", "hooks.json")));
  for (const v of Array.isArray(m?.hooks) ? m.hooks : m?.hooks ? [m.hooks] : []) {
    if (typeof v === "string") {
      const p = inside(root, v);
      if (p) count(await json(p));
    } else count(v);
  }
  return n;
}

/** What a plugin adds: skills and output styles add to or replace the default folders, as the manifest reference says. */
export async function components(root: string, m: Manifest | null): Promise<PluginInfo["adds"]> {
  const from = async (key: string, folder: string, kind: "skill" | "md", replaces: boolean) => {
    const declared = list(m?.[key]).map((r) => inside(root, r)).filter((p): p is string => !!p);
    const dirs = replaces && declared.length ? declared : [path.join(root, folder), ...declared];
    const all = (await Promise.all(dirs.map((d) => names(d, kind)))).flat();
    return [...new Map(all.map((x) => [x.name, x])).values()].sort((a, b) => a.name.localeCompare(b.name));
  };
  const commands = m?.commands && typeof m.commands === "object" && !Array.isArray(m.commands) ? Object.keys(m.commands).sort() : (await from("commands", "commands", "md", true)).map((c) => c.name);
  const lsp = await json<Record<string, unknown>>(path.join(root, ".lsp.json"));
  return {
    skills: await from("skills", "skills", "skill", false),
    agents: await from("agents", "agents", "md", true),
    commands,
    styles: await from("outputStyles", "output-styles", "md", true),
    hooks: await hookCount(root, m),
    mcp: (await mcpNames(root, m)).sort(),
    lsp: lsp ? Object.keys(lsp).sort() : [],
  };
}

function authorOf(m: Manifest | null): string | null {
  if (!m?.author) return null;
  return typeof m.author === "string" ? m.author : (m.author.name ?? null);
}

type Install = { scope?: string; projectPath?: string; installPath?: string; version?: string; lastUpdated?: string; installedAt?: string };

async function syncedDirs(): Promise<string[]> {
  const base = path.join(ROOT(), "synced");
  const out: string[] = [];
  for (const account of await fs.readdir(base, { withFileTypes: true }).catch(() => [])) {
    if (!account.isDirectory()) continue;
    for (const p of await fs.readdir(path.join(base, account.name), { withFileTypes: true }).catch(() => [])) {
      if (p.isDirectory() && (await exists(path.join(base, account.name, p.name, ".claude-plugin", "plugin.json")))) out.push(path.join(base, account.name, p.name));
    }
  }
  return out;
}

const SCOPE_LABEL: Record<string, string> = { user: "your user settings", project: "this project's shared settings", local: "this project's local settings", managed: "your organization's settings" };

export async function listPlugins(project: ProjectRef | null): Promise<PluginInfo[]> {
  const P = project?.path ?? null;
  const scopes = await readScopes(P);
  const setting = (id: string) => {
    const { effective } = resolveValue(scopes, ["enabledPlugins", id]);
    return effective && typeof effective.value === "boolean" ? { value: effective.value, from: SCOPE_LABEL[effective.scope] ?? effective.scope } : null;
  };
  const out: PluginInfo[] = [];
  const push = async (id: string, origin: PluginInfo["origin"], marketplace: string | null, root: string, inst: Install | null, enabled: { on: boolean; why: string }) => {
    const m = await json<Manifest>(path.join(root, ".claude-plugin", "plugin.json"));
    out.push({
      id,
      name: id.slice(0, id.lastIndexOf("@")),
      origin,
      marketplace,
      path: root,
      display: tilde(root),
      version: m?.version ?? inst?.version ?? null,
      description: typeof m?.description === "string" ? m.description : "",
      author: authorOf(m),
      on: enabled.on,
      why: enabled.why,
      installedFor: inst?.scope === "project" || inst?.scope === "local" || inst?.scope === "user" ? inst.scope : null,
      updated: inst?.lastUpdated ?? inst?.installedAt ?? null,
      adds: await components(root, m),
    });
  };

  // Marketplace installs: the record that applies here (yours, or this project's), turned on by enabledPlugins.
  const installed = (await json<{ plugins?: Record<string, Install[] | Install> }>(path.join(ROOT(), "installed_plugins.json")))?.plugins ?? {};
  for (const [id, v] of Object.entries(installed)) {
    const entries = Array.isArray(v) ? v : [v];
    const inst = entries.find((e) => (e.scope === "project" || e.scope === "local") && P && e.projectPath === P) ?? entries.find((e) => !e.scope || e.scope === "user") ?? null;
    if (!inst?.installPath || !(await exists(inst.installPath))) continue;
    const s = setting(id);
    await push(id, "marketplace", id.slice(id.lastIndexOf("@") + 1), inst.installPath, inst, s ? { on: s.value, why: `Turned ${s.value ? "on" : "off"} in ${s.from}.` } : { on: false, why: "Installed, but no settings file turns it on." });
  }

  // Synced from claude.ai: on unless a setting turns it, or all syncing, off.
  const syncOff = resolveValue(scopes, ["syncClaudeAiPlugins"]).effective?.value === false;
  const seen = new Set<string>();
  for (const root of await syncedDirs()) {
    const m = await json<Manifest>(path.join(root, ".claude-plugin", "plugin.json"));
    const name = typeof m?.name === "string" && m.name ? m.name : path.basename(root).replace(/~g\d+$/, "");
    if (seen.has(name)) continue;
    seen.add(name);
    const id = `${name}@synced`;
    const s = setting(id);
    const on = !syncOff && (s ? s.value : m?.defaultEnabled !== false);
    const why = syncOff ? "Plugin syncing from claude.ai is turned off (syncClaudeAiPlugins)." : s ? `Turned ${s.value ? "on" : "off"} in ${s.from}.` : m?.defaultEnabled === false ? "Its manifest leaves it off until you turn it on." : "On for your claude.ai account.";
    await push(id, "synced", null, root, null, { on, why });
  }

  // Plugin folders saved in a skills folder.
  for (const base of [path.join(CLAUDE_DIR, "skills"), ...(P ? [path.join(P, ".claude", "skills")] : [])]) {
    for (const d of await fs.readdir(base, { withFileTypes: true }).catch(() => [])) {
      const root = path.join(base, d.name);
      if (!d.isDirectory() || !(await exists(path.join(root, ".claude-plugin", "plugin.json")))) continue;
      const m = await json<Manifest>(path.join(root, ".claude-plugin", "plugin.json"));
      const id = `${typeof m?.name === "string" && m.name ? m.name : d.name}@skills-dir`;
      const s = setting(id);
      const on = s ? s.value : m?.defaultEnabled === true;
      await push(id, "skills-dir", null, root, null, { on, why: s ? `Turned ${s.value ? "on" : "off"} in ${s.from}.` : on ? "Its manifest turns it on." : "Its manifest leaves it off until a settings file turns it on." });
    }
  }
  return out.sort((a, b) => Number(b.on) - Number(a.on) || a.name.localeCompare(b.name));
}

export const PLUGINS_DOC: () => DocRef = () => docRef("plugins/loading", "find-where-a-plugin-came-from");

export async function pluginsView(project: ProjectRef | null): Promise<PluginsView> {
  const plugins = await listPlugins(project);
  const marketplaces = Object.keys((await json<Record<string, unknown>>(path.join(ROOT(), "known_marketplaces.json"))) ?? {}).sort();
  return { project, plugins, marketplaces, root: tilde(ROOT()), doc: PLUGINS_DOC() };
}
