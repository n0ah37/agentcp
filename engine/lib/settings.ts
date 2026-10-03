import fs from "node:fs/promises";
import path from "node:path";

import type {
  SettingControl,
  SettingRow,
  SettingScope,
  SettingValue,
  SettingsView,
  WritePlan,
} from "../../shared/types.ts";
import { docRef, docsInfo, pageText, plain } from "./docs.ts";
import { CLAUDE_DIR, MANAGED_DIR, tilde } from "./paths.ts";
import { planWrite } from "./write.ts";

/**
 * Every settings key comes from the settings reference page, parsed at
 * runtime: the index table gives key, description, topic and scope, and each
 * key's own section gives its type, default and per-session overrides. When
 * the documentation is refreshed, this list changes with it.
 */

export type CatalogEntry = {
  key: string;
  path: string[];
  description: string;
  topic: string;
  scopeText: string;
  allowed: SettingScope[];
  typeText: string;
  defaultText: string;
  overridesText: string | null;
  control: SettingControl;
  anchor: string;
  globalConfig: boolean;
};

let catalog: { at: string | null; entries: CatalogEntry[]; topics: string[] } | null = null;

/**
 * Keys most people want and reach only through a settings file or /config.
 * The documentation does not say which keys the desktop app exposes, so this
 * list makes no such claim; it is an ordering, nothing more.
 */
export const FEATURED = [
  "outputStyle",
  "autoMemoryEnabled",
  "autoCompactWindow",
  "effortLevel",
  "model",
  "includeGitInstructions",
  "attribution",
  "cleanupPeriodDays",
  "promptCacheTtl",
  "language",
  "alwaysThinkingEnabled",
  "claudeMdExcludes",
  "autoMemoryDirectory",
];

function allowedFor(scopeText: string): SettingScope[] {
  const s = scopeText.toLowerCase();
  if (s.includes("any file")) return ["user", "project", "local"];
  if (s.includes("global config") || s === "managed") return [];
  const out: SettingScope[] = [];
  if (s.includes("user")) out.push("user");
  if (s.includes("project")) out.push("project");
  if (s.includes("local")) out.push("local");
  return out;
}

function controlFor(typeText: string, body: string): SettingControl {
  const t = typeText.toLowerCase();
  if (t.startsWith("boolean")) return { type: "boolean" };
  const options: { value: string; label: string }[] = [];
  const typeBlock = /\* \*\*Type\*\*:[^\n]*\n((?:\s{2,}\*[^\n]*\n)+)/.exec(body);
  if (typeBlock) {
    for (const line of typeBlock[1].split("\n")) {
      const m = /^\s+\*\s+`"([^"`]+)"`\s*:?\s*(.*)$/.exec(line);
      if (m) options.push({ value: m[1], label: plain(m[2]) });
    }
  }
  if (!options.length && /one of/.test(t)) {
    for (const m of typeText.matchAll(/`"([^"`]+)"`/g)) options.push({ value: m[1], label: "" });
  }
  if (options.length && t.startsWith("string")) return { type: "enum", options };
  if (/^(integer|number)/.test(t)) return { type: "number" };
  if (/^(array|object|list|map)/.test(t)) return { type: "json" };
  if (t.startsWith("string")) return { type: "string" };
  return { type: "json" };
}

function bullet(body: string, name: string): string | null {
  const m = new RegExp(`\\* \\*\\*${name}\\*\\*:\\s*([^\\n]*)`).exec(body);
  return m ? plain(m[1]) : null;
}

export function settingsCatalog(): { entries: CatalogEntry[]; topics: string[] } {
  const info = docsInfo();
  if (catalog && catalog.at === info.capturedAt) return catalog;
  const text = pageText("settings-reference") ?? "";
  const lines = text.split("\n");

  // Index table: | [`key`](#anchor) | Description | Topic | Scope |
  const index = new Map<string, { anchor: string; description: string; topic: string; scope: string }>();
  for (const l of lines) {
    const m = /^\|\s*\[`([^`]+)`\]\(#([^)]+)\)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/.exec(l);
    if (m) index.set(m[1], { anchor: m[2], description: plain(m[3]), topic: plain(m[4]), scope: plain(m[5]) });
  }

  // Per-key sections: ### `key` ... up to the next heading of level ≤ 3.
  const bodies = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const m = /^###\s+`([^`]+)`\s*$/.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !/^#{2,3}\s/.test(lines[j])) j++;
    bodies.set(m[1], lines.slice(i + 1, j).join("\n"));
  }

  const topics: string[] = [];
  const entries: CatalogEntry[] = [];
  for (const [key, ix] of index) {
    if (!topics.includes(ix.topic)) topics.push(ix.topic);
    const body = bodies.get(key) ?? "";
    const typeText = bullet(body, "Type") ?? "";
    entries.push({
      key,
      path: key.split("."),
      description: ix.description,
      topic: ix.topic,
      scopeText: ix.scope,
      allowed: allowedFor(ix.scope),
      typeText,
      defaultText: bullet(body, "Default") ?? "",
      overridesText: bullet(body, "Per-session overrides"),
      control: controlFor(typeText, body),
      anchor: ix.anchor,
      globalConfig: ix.scope.toLowerCase().includes("global config"),
    });
  }
  catalog = { at: info.capturedAt, entries, topics };
  return catalog;
}

export type ScopeFile = { scope: SettingScope | "managed"; path: string; data: Record<string, unknown> | null; exists: boolean; error: string | null };

export function scopePaths(project: string | null): { scope: SettingScope | "managed"; path: string }[] {
  const out: { scope: SettingScope | "managed"; path: string }[] = [
    { scope: "managed", path: path.join(MANAGED_DIR, "managed-settings.json") },
  ];
  if (project) {
    out.push({ scope: "local", path: path.join(project, ".claude", "settings.local.json") });
    out.push({ scope: "project", path: path.join(project, ".claude", "settings.json") });
  }
  out.push({ scope: "user", path: path.join(CLAUDE_DIR, "settings.json") });
  return out;
}

/** Highest precedence first: managed, local, project, user. */
export async function readScopes(project: string | null): Promise<ScopeFile[]> {
  return Promise.all(
    scopePaths(project).map(async ({ scope, path: p }) => {
      let raw: string;
      try {
        raw = await fs.readFile(p, "utf8");
      } catch {
        return { scope, path: p, data: null, exists: false, error: null };
      }
      try {
        const data = raw.trim() ? (JSON.parse(raw) as unknown) : {};
        if (typeof data !== "object" || data === null || Array.isArray(data)) {
          return { scope, path: p, data: null, exists: true, error: "The file is not a JSON object." };
        }
        return { scope, path: p, data: data as Record<string, unknown>, exists: true, error: null };
      } catch (e) {
        return { scope, path: p, data: null, exists: true, error: `Not valid JSON: ${(e as Error).message}` };
      }
    }),
  );
}

export function getPath(obj: unknown, keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (typeof cur !== "object" || cur === null || !(k in (cur as object))) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export function setPath(obj: Record<string, unknown>, keys: string[], value: unknown): Record<string, unknown> {
  const out = structuredClone(obj);
  let cur: Record<string, unknown> = out;
  for (const k of keys.slice(0, -1)) {
    const next = cur[k];
    if (typeof next !== "object" || next === null || Array.isArray(next)) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  const last = keys[keys.length - 1];
  if (value === undefined || value === null) delete cur[last];
  else cur[last] = value;
  // Drop objects the removal left empty, so unsetting a nested key leaves no residue.
  const prune = (o: Record<string, unknown>, path: string[]) => {
    if (!path.length) return;
    const child = o[path[0]];
    if (typeof child === "object" && child !== null && !Array.isArray(child)) {
      prune(child as Record<string, unknown>, path.slice(1));
      if (!Object.keys(child).length) delete o[path[0]];
    }
  };
  if (value === undefined || value === null) prune(out, keys.slice(0, -1));
  return out;
}

export function resolveValue(scopes: ScopeFile[], keys: string[]): { values: SettingValue[]; effective: SettingValue | null } {
  const values: SettingValue[] = [];
  for (const s of scopes) {
    if (!s.data) continue;
    const v = getPath(s.data, keys);
    if (v !== undefined) values.push({ scope: s.scope, file: tilde(s.path), value: v });
  }
  return { values, effective: values[0] ?? null };
}

export async function settingsView(project: string | null): Promise<Omit<SettingsView, "project">> {
  const { entries, topics } = settingsCatalog();
  const scopes = await readScopes(project);
  const rows: SettingRow[] = entries.map((e) => {
    const { values, effective } = resolveValue(scopes, e.path);
    return {
      key: e.key,
      path: e.path,
      description: e.description,
      topic: e.topic,
      scopeText: e.scopeText,
      allowed: e.allowed,
      typeText: e.typeText,
      defaultText: e.defaultText,
      overridesText: e.overridesText,
      control: e.control,
      doc: docRef("settings-reference", e.anchor),
      values,
      effective,
      merges: e.control.type === "json" && /array|list/i.test(e.typeText),
    };
  });
  return {
    files: scopes.map((s) => ({ scope: s.scope, path: s.path, display: tilde(s.path), exists: s.exists, error: s.error })),
    topics,
    featured: FEATURED.filter((k) => entries.some((e) => e.key === k)),
    rows,
    capturedAt: docsInfo().capturedAt,
  };
}

export async function planSetting(
  project: string | null,
  scope: SettingScope,
  keys: string[],
  value: unknown,
  baseHash: string | null,
): Promise<{ plan: WritePlan; content: string }> {
  const target = scopePaths(project).find((s) => s.scope === scope);
  if (!target) throw new Error("A project is needed for project and local settings.");
  const entry = settingsCatalog().entries.find((e) => e.path.join(".") === keys.join("."));
  let current: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(target.path, "utf8");
    current = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${tilde(target.path)} is not valid JSON, so it can't be edited safely.`, { cause: e });
  }
  const next = setPath(current, keys, value);
  const content = JSON.stringify(next, null, 2) + "\n";
  const plan = await planWrite({ path: target.path, content, baseHash });
  if (entry && !entry.allowed.includes(scope) && value !== null && value !== undefined) {
    plan.refusal = `${entry.key} is read only from ${entry.scopeText.toLowerCase()} settings. Claude Code ignores it in this file.`;
  }
  return { plan, content };
}
