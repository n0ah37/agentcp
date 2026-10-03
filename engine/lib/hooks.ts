import path from "node:path";

import { parse as parseToml } from "smol-toml";

import type { HookEntry, HookEvent, HookFile, HooksView } from "../../shared/types.ts";
import { CX, RULES, cite, hookEvents as codexHookEvents } from "./codex-docs.ts";
import { projectRoot, trustFor } from "./codex.ts";
import { anchorFor, docRef, pageText, plain, section } from "./docs.ts";
import { readText } from "./fsx.ts";
import { CODEX_DIR, tilde } from "./paths.ts";
import { listPlugins } from "./plugins.ts";
import { readScopes } from "./settings.ts";

/**
 * Hooks: commands an agent runs itself at fixed points in a session.
 *
 * Claude Code keeps them under `hooks` in its settings files (managed, this
 * project's local and shared settings, your own). Codex keeps them in
 * hooks.json beside each config layer, or under [hooks] in config.toml, in
 * the same shape: event → matcher groups → hooks. What each event is, what
 * its matcher is tested against and whether a hook can stop it all come from
 * each agent's own hooks page, so the list follows the agents as they change.
 * The app writes settings.json and hooks.json; hooks inside a config.toml are
 * shown, and edited there.
 */

/** The cells of a markdown table's body rows, backticks kept. */
function tableRows(md: string): string[][] {
  return md
    .split("\n")
    .filter((l) => /^\|/.test(l) && !/^\|\s*:?-/.test(l))
    .map((l) =>
      l
        .replace(/^\|/, "")
        .replace(/\|\s*$/, "")
        .split(/(?<!\\)\|/)
        .map((c) => c.trim()),
    )
    .slice(1);
}

const eventNames = (cell: string) => [...cell.matchAll(/`(\w+)`/g)].map((m) => m[1]);
const sentences = (s: string) => s.split(/(?<=[.!?])\s/);

/**
 * Claude Code's hook events, from the hooks reference: the `### Name`
 * sections under "Hook events", the "When it fires" table, the "What the
 * matcher filters" table and the "Exit code 2 behavior per event" table.
 */
export function claudeEvents(): HookEvent[] {
  const text = pageText("hooks") ?? "";
  const start = text.indexOf("\n## Hook events");
  if (start === -1) return [];
  const end = text.indexOf("\n## ", start + 5);
  const body = text.slice(start, end === -1 ? undefined : end);

  const when = new Map<string, string>();
  for (const [ev, w] of tableRows(section("hooks", "hook-lifecycle") ?? "")) for (const n of eventNames(ev ?? "")) when.set(n, plain((w ?? "").replace(/`/g, "")));
  const matchers = new Map<string, { on: string; examples: string[] }>();
  for (const [ev, on, ex] of tableRows(section("hooks", "matcher-patterns") ?? "")) {
    if (!on || ex === undefined) continue;
    for (const n of eventNames(ev)) matchers.set(n, { on: plain(on.replace(/`/g, "")), examples: [...ex.matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/\\\|/g, "|")) });
  }
  const blocks = new Map<string, { can: boolean; what: string }>();
  for (const [ev, can, what] of tableRows(section("hooks", "exit-code-2-behavior-per-event") ?? "")) {
    for (const n of eventNames(ev ?? "")) blocks.set(n, { can: /^yes/i.test(can ?? ""), what: plain((what ?? "").replace(/`/g, "")) });
  }

  const out: HookEvent[] = [];
  for (const m of body.matchAll(/\n### ([A-Za-z]+)\s*\n+([\s\S]*?)(?=\n### |$)/g)) {
    const name = m[1];
    const paras = m[2]
      .split(/\n\n/)
      .map((p) => p.trim())
      .filter((p) => p && !/^(\||<|```|#)/.test(p));
    const first = plain((paras[0] ?? "").replace(/`/g, ""));
    const w = when.get(name);
    const mt = matchers.get(name);
    out.push({
      name,
      summary: w ? w.split(/\.\s/)[0].replace(/\.?$/, ".") : (sentences(first)[0] ?? ""),
      detail: [w && w.split(/\.\s/).length > 1 ? w.split(/\.\s/).slice(1).join(". ").replace(/\.?$/, ".") : "", sentences(first).slice(0, 2).join(" ")].filter((d) => d && d !== w),
      matcher: mt && !/no matcher support/i.test(mt.on) ? { on: mt.on, examples: mt.examples, note: "" } : null,
      block: blocks.get(name) ?? null,
      doc: docRef("hooks", anchorFor(name)),
    });
  }
  return out;
}

type Groups = Record<string, { matcher?: string; hooks?: Record<string, unknown>[] }[]>;

function entriesFrom(groups: unknown, file: HookFile): HookEntry[] {
  if (!groups || typeof groups !== "object") return [];
  const out: HookEntry[] = [];
  for (const [event, list] of Object.entries(groups as Groups)) {
    if (!Array.isArray(list)) continue;
    list.forEach((g, gi) => {
      // A group or a hook in the wrong shape is skipped; the indexes stay the file's own.
      if (!g || typeof g !== "object" || !Array.isArray(g.hooks)) return;
      g.hooks.forEach((h, hi) => {
        if (!h || typeof h !== "object") return;
        const type = String(h.type ?? "command");
        const run = String(h.command ?? h.url ?? h.prompt ?? h.server ?? "");
        out.push({
          id: `${file.path}#${event}.${gi}.${hi}`,
          event,
          matcher: typeof g.matcher === "string" && g.matcher ? g.matcher : null,
          type,
          run,
          timeout: typeof h.timeout === "number" ? h.timeout : null,
          file: file.path,
          fileDisplay: file.display,
          fileLabel: file.label,
          group: gi,
          index: hi,
        });
      });
    });
  }
  return out;
}

async function json(p: string): Promise<{ data: Record<string, unknown> | null; exists: boolean; hash: string | null; error: string | null }> {
  const t = await readText(p);
  if (!t) return { data: null, exists: false, hash: null, error: null };
  try {
    const d = t.text.trim() ? (JSON.parse(t.text) as unknown) : {};
    return typeof d === "object" && d && !Array.isArray(d) ? { data: d as Record<string, unknown>, exists: true, hash: t.hash, error: null } : { data: null, exists: true, hash: t.hash, error: "Not a JSON object." };
  } catch (e) {
    return { data: null, exists: true, hash: t.hash, error: (e as Error).message };
  }
}

/** The scope pickers' names (app/ui/scopes.ts): the place first, then who it's for. */
export const SCOPE_LABEL = { managed: "Organization", local: "This project (just you)", project: "This project (everyone)", user: "User" } as const;

export async function hooksView(agent: "claude" | "codex", project: string | null): Promise<HooksView> {
  const files: HookFile[] = [];
  const entries: HookEntry[] = [];
  if (agent === "claude") {
    for (const s of await readScopes(project)) {
      const f: HookFile = { path: s.path, display: tilde(s.path), label: SCOPE_LABEL[s.scope], scope: s.scope, exists: s.exists, writable: s.scope !== "managed", error: s.error };
      files.push(f);
      entries.push(...entriesFrom(s.data?.hooks, f));
    }
    // Plugins you've turned on: hooks/hooks.json in each, plus any hook files its manifest names.
    const ref = project ? { path: project, display: tilde(project), name: path.basename(project), group: "", lastActive: null, isWorktree: false, exists: true } : null;
    for (const pl of (await listPlugins(ref)).filter((x) => x.on && x.adds.hooks > 0)) {
      const manifest = (await json(path.join(pl.path, ".claude-plugin", "plugin.json"))).data;
      const declared = (Array.isArray(manifest?.hooks) ? manifest.hooks : manifest?.hooks ? [manifest.hooks] : []) as unknown[];
      const sources: { p: string; hooks: unknown }[] = [{ p: path.join(pl.path, "hooks", "hooks.json"), hooks: (await json(path.join(pl.path, "hooks", "hooks.json"))).data?.hooks }];
      for (const d of declared) {
        if (typeof d === "string") sources.push({ p: path.join(pl.path, d), hooks: (await json(path.join(pl.path, d))).data?.hooks });
        else sources.push({ p: path.join(pl.path, ".claude-plugin", "plugin.json"), hooks: (d as { hooks?: unknown })?.hooks ?? d });
      }
      for (const src of sources.filter((x) => x.hooks)) {
        const f: HookFile = { path: src.p, display: tilde(src.p), label: `${pl.name} plugin`, scope: "plugin", exists: true, writable: false, error: null };
        files.push(f);
        entries.push(...entriesFrom(src.hooks, f));
      }
    }
    const lead = plain((section("hooks", "hook-locations") ?? "").split("\n\n")[1] ?? "");
    return {
      agent,
      events: claudeEvents(),
      files,
      entries,
      enabled: null,
      sources: "your settings, this project's shared and local settings, your organization's settings, and plugins you've turned on.",
      doc: docRef("hooks", "hook-locations"),
      notes: lead ? [{ text: lead, doc: docRef("hooks", "hook-locations") }] : [],
    };
  }

  // Codex: hooks.json next to your config and a trusted project's .codex, and [hooks] in either config.toml.
  const root = project ? await projectRoot(project) : null;
  const trusted = project ? (await trustFor(project)).level === "trusted" : false;
  const places: { p: string; label: string; scope: HookFile["scope"]; used: boolean }[] = [];
  if (root) places.push({ p: path.join(root, ".codex", "hooks.json"), label: "This project", scope: "project", used: trusted });
  places.push({ p: path.join(CODEX_DIR, "hooks.json"), label: "User", scope: "user", used: true });
  for (const pl of places) {
    const j = await json(pl.p);
    const f: HookFile = { path: pl.p, display: tilde(pl.p), label: pl.used ? pl.label : `${pl.label} (not trusted, so not read)`, scope: pl.scope, exists: j.exists, writable: true, error: j.error };
    files.push(f);
    entries.push(...entriesFrom(j.data?.hooks ?? j.data, f));
  }
  let enabled: boolean | null = null;
  const tomls: [string, string, HookFile["scope"]][] = [[path.join(CODEX_DIR, "config.toml"), "User config.toml", "user"], ...(root ? [[path.join(root, ".codex", "config.toml"), "This project's config.toml", "project"] as [string, string, HookFile["scope"]]] : [])];
  for (const [p, label, scope] of tomls) {
    const t = await readText(p);
    if (!t) continue;
    try {
      const cfg = parseToml(t.text) as { hooks?: unknown; features?: { hooks?: boolean; codex_hooks?: boolean } };
      const flag = cfg.features?.hooks ?? cfg.features?.codex_hooks;
      if (scope === "user" && typeof flag === "boolean") enabled = flag;
      if (cfg.hooks) {
        const f: HookFile = { path: p, display: tilde(p), label, scope, exists: true, writable: false, error: null };
        files.push(f);
        entries.push(...entriesFrom(cfg.hooks, f));
      }
    } catch {
      /* a config.toml that doesn't parse is reported on the Settings screen */
    }
  }
  const note = (r: (typeof RULES)[keyof typeof RULES]) => ({ text: r.says.replace(/`/g, ""), doc: cite(r).doc });
  return {
    agent,
    events: codexHookEvents(),
    files,
    entries,
    enabled,
    sources: "hooks.json and [hooks] in config.toml, in ~/.codex and in a trusted project's .codex folder, plus hooks from plugins.",
    doc: docRef(CX.hooks, "where-codex-looks-for-hooks"),
    notes: [note(RULES.hooksTrust), note(RULES.hooksBoth)],
  };
}

/**
 * The new text of a settings.json or hooks.json with one hook added or taken
 * out. Everything else in the file is kept; the write goes through the normal
 * review, diff and snapshot. Nothing is written here.
 */
export async function planHook(input: { file: string; event: string; add?: { matcher: string | null; command: string; timeout: number | null }; remove?: { group: number; index: number } }): Promise<{ path: string; content: string; baseHash: string | null }> {
  const j = await json(input.file);
  if (j.error) throw new Error(`${tilde(input.file)} isn't valid JSON: ${j.error}`);
  const data = j.data ?? {};
  // A hooks.json may hold the events at the top or under "hooks"; settings.json always under "hooks".
  const isHooksFile = path.basename(input.file) === "hooks.json";
  const holder = isHooksFile && !("hooks" in data) && Object.keys(data).length ? data : ((data.hooks ??= {}) as Record<string, unknown>);
  const groups = ((holder as Groups)[input.event] ??= []);
  if (input.add) {
    const h: Record<string, unknown> = { type: "command", command: input.add.command };
    if (input.add.timeout) h.timeout = input.add.timeout;
    const same = groups.find((g) => (g.matcher ?? null) === (input.add!.matcher || null));
    if (same) (same.hooks ??= []).push(h);
    else groups.push({ ...(input.add.matcher ? { matcher: input.add.matcher } : {}), hooks: [h] });
  }
  if (input.remove) {
    const g = groups[input.remove.group];
    if (!g?.hooks?.[input.remove.index]) throw new Error("That hook isn't in the file any more.");
    g.hooks.splice(input.remove.index, 1);
    if (!g.hooks.length) groups.splice(input.remove.group, 1);
    if (!groups.length) delete (holder as Groups)[input.event];
  }
  return { path: input.file, content: JSON.stringify(data, null, 2) + "\n", baseHash: j.hash };
}
