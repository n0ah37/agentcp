import type { DocRef, HookEvent } from "../../shared/types.ts";
import { codexAnchorFor, docRef, docSays, pageText, plain, section } from "./docs.ts";

/**
 * Everything the app knows about Codex comes from Codex's own documentation,
 * captured beside Claude Code's (docs-fetch.ts). This module reads it: the
 * rules other modules rely on, each with the sentence it stands on, and the
 * reference tables (settings, hook events, skill folders) parsed from the
 * pages. When a refresh drops a sentence, the finding built on it says so,
 * and when a table changes, the app follows it.
 */

export const CX = {
  agentsMd: "codex/agent-configuration/agents-md",
  configRef: "codex/config-file/config-reference",
  configBasic: "codex/config-file/config-basic",
  configAdvanced: "codex/config-file/config-advanced",
  hooks: "codex/hooks",
  skills: "codex/build-skills",
  subagents: "codex/agent-configuration/subagents",
  memories: "codex/customization/memories",
} as const;

/** `says` is the docs' exact words; `shown`, when the words are a fragment, is how the app prints them. */
export type CodexCite = { slug: string; anchor?: string; says: string; shown?: string };

/** A rule as the app prints it: the docs' sentence, without code marks, as a full sentence. */
export function ruleText(r: CodexCite): string {
  const t = (r.shown ?? r.says).replace(/`/g, "");
  return /[.!?]$/.test(t) ? t : t + ".";
}

export const RULES = {
  globalOne: { slug: CX.agentsMd, anchor: "how-codex-discovers-guidance", says: "Codex uses only the first non-empty file at this level." },
  perFolder: { slug: CX.agentsMd, anchor: "how-codex-discovers-guidance", says: "Codex includes at most one file per directory." },
  budget: { slug: CX.agentsMd, anchor: "how-codex-discovers-guidance", says: "stops adding files once the combined size reaches the limit defined by `project_doc_max_bytes`", shown: "Codex stops adding files once the combined size reaches the limit defined by `project_doc_max_bytes`" },
  empty: { slug: CX.agentsMd, anchor: "how-codex-discovers-guidance", says: "Codex skips empty files" },
  rootMarkers: { slug: CX.configAdvanced, anchor: "project-root-detection", says: "By default, Codex treats a directory containing `.git` as the project root." },
  trust: { slug: CX.configAdvanced, anchor: "project-config-files-codexconfigtoml", says: "Codex loads project-scoped config files only when the project is trusted." },
  projectIgnored: { slug: CX.configAdvanced, anchor: "project-config-files-codexconfigtoml", says: "Codex ignores the following keys in project-local `.codex/config.toml`" },
  profileFiles: { slug: CX.configAdvanced, anchor: "profiles", says: "When you pass `--profile profile-name`, Codex loads `~/.codex/config.toml`, then overlays `~/.codex/profile-name.config.toml`." },
  profileTables: { slug: CX.configAdvanced, anchor: "profiles", says: "`--profile` no longer reads `[profiles.profile-name]` from `config.toml`" },
  profileSelector: { slug: CX.configAdvanced, anchor: "profiles", says: 'the top-level `profile = "profile-name"` selector is no longer supported' },
  systemConfig: { slug: CX.configBasic, anchor: "configuration-precedence", says: "`/etc/codex/config.toml` on Unix" },
  untrusted: { slug: CX.configRef, anchor: "configtoml", says: 'Codex and ChatGPT Work no longer support `approval_policy = "untrusted"`.' },
  onFailure: { slug: CX.configRef, anchor: "configtoml", says: "`on-failure` is deprecated" },
  sandboxBoth: { slug: CX.configRef, anchor: "configtoml", says: "Don't combine with `sandbox_mode` or `[sandbox_workspace_write]`." },
  instructionsFile: { slug: CX.configRef, anchor: "configtoml", says: "Rename `experimental_instructions_file` to `model_instructions_file`." },
  hooksOn: { slug: CX.hooks, anchor: "turn-hooks-off", says: "Hooks are enabled by default." },
  hooksAlias: { slug: CX.hooks, anchor: "turn-hooks-off", says: "`codex_hooks` still works as a deprecated alias" },
  hooksBoth: { slug: CX.hooks, anchor: "where-codex-looks-for-hooks", says: "If a single layer contains both `hooks.json` and inline `[hooks]`, Codex merges them and warns at startup." },
  hooksTrust: { slug: CX.hooks, anchor: "review-and-trust-hooks", says: "Before a non-managed hook can run, Codex requires you to review and trust the exact hook definition." },
  agentFiles: { slug: CX.subagents, anchor: "custom-agents", says: "`~/.codex/agents/` for personal agents or `.codex/agents/` for project-scoped" },
  memoryDir: { slug: CX.memories, anchor: "local-memory-storage", says: "The main memory files live under `~/.codex/memories/`" },
  memoryGenerated: { slug: CX.memories, anchor: "local-memory-storage", says: "Treat these files as generated state." },
} satisfies Record<string, CodexCite>;

/** A citation and whether the page still says it. */
export function cite(c: CodexCite): { doc: DocRef; docCurrent: boolean } {
  return { doc: docRef(c.slug, c.anchor), docCurrent: docSays(c.slug, c.says) };
}

export const doc = (slug: string, anchor?: string): DocRef => docRef(slug, anchor);

/** `project_doc_max_bytes`'s default, as the AGENTS.md guide states it ("32 KiB by default"). */
export function defaultBudget(): number {
  const m = /`project_doc_max_bytes`\s*\((\d+)\s*KiB by default\)/.exec(pageText(CX.agentsMd) ?? "");
  return (m ? Number(m[1]) : 32) * 1024;
}

// --------------------------------------------------------------- settings

export type CodexKeySpec = { key: string; type: string; description: string };

let keysCache: { text: string; keys: CodexKeySpec[] } | null = null;

const unquote = (s: string): string => {
  const body = s.slice(1, -1);
  return s.startsWith("'") ? body.replace(/\\'/g, "'").replace(/\\\\/g, "\\") : (JSON.parse(`"${body}"`) as string);
};

/** Every `config.toml` key in the configuration reference: its first `<ConfigTable>`, before `requirements.toml`. */
export function configKeys(): CodexKeySpec[] {
  const text = pageText(CX.configRef) ?? "";
  if (keysCache?.text === text) return keysCache.keys;
  const end = text.indexOf("## `requirements.toml`");
  const part = end === -1 ? text : text.slice(0, end);
  const str = `("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`;
  const re = new RegExp(`key:\\s*${str},\\s*type:\\s*${str},\\s*description:\\s*${str}`, "g");
  const keys = [...part.matchAll(re)].map((m) => ({ key: unquote(m[1]), type: unquote(m[2]), description: plain(unquote(m[3]).replace(/`/g, "")) }));
  keysCache = { text, keys };
  return keys;
}

/** Keys Codex ignores in a project's `.codex/config.toml`, listed in the advanced config guide. */
export function projectIgnoredKeys(): string[] {
  const s = section(CX.configAdvanced, "project-config-files-codexconfigtoml") ?? "";
  const m = /Codex\s+ignores\s+the\s+following\s+keys[\s\S]*?:\s*([\s\S]*?)\.\s/.exec(s);
  return m ? [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]) : [];
}

// ------------------------------------------------------------------ hooks

/**
 * Codex's hook events: the `### Name` sections under `## Hooks` on the hooks
 * page. The summary is the section's own sentence about the event when it has
 * one ("`PreCompact` runs before Codex compacts the chat."), otherwise the
 * row of the page's opening table the event sits in ("When a session or
 * subagent starts"). The matcher comes from the "Matcher patterns" table, and
 * the detail is what the hook's output does.
 */
export function hookEvents(): HookEvent[] {
  const text = pageText(CX.hooks) ?? "";
  const matchers = new Map<string, { on: string; note: string }>();
  for (const row of (section(CX.hooks, "matcher-patterns") ?? "").split("\n")) {
    const m = /^\|\s*`(\w+)`\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|/.exec(row);
    if (m) matchers.set(m[1], { on: m[2].trim(), note: plain(m[3]) });
  }
  // The opening table: | When | Hooks |, one row per moment in a conversation.
  const when = new Map<string, string>();
  for (const row of text.slice(0, text.search(/^## /m)).split("\n")) {
    const m = /^\|\s*([^|`]+?)\s*\|\s*(.*?)\s*\|\s*$/.exec(row);
    if (!m || /^-+$|^When$/.test(m[1])) continue;
    for (const n of m[2].matchAll(/`(\w+)`/g)) when.set(n[1], m[1]);
  }
  const start = text.search(/^## Hooks\s*$/m);
  if (start === -1) return [];
  const rest = text.slice(start + 1);
  const stop = rest.search(/^## /m);
  const body = stop === -1 ? rest : rest.slice(0, stop);
  const out: HookEvent[] = [];
  for (const m of body.matchAll(/^### (\w+)\s*\n+([\s\S]*?)(?=^### |(?![\s\S]))/gm)) {
    const name = m[1];
    const paras = m[2].split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !/^(\||<|```|#)/.test(p));
    const own = paras.find((p) => p.startsWith("`" + name + "`") && !/^`\w+` expects/.test(p));
    const sentence = own ? plain(own.replace(/`/g, "")).split(/(?<=[.!?])\s/)[0] : when.has(name) ? when.get(name)!.replace(/\s*\(.*\)$/, "") + "." : "";
    const output = paras.find((p) => /stdout|Plain text output/.test(p) && !p.startsWith("JSON on"));
    const mt = matchers.get(name);
    out.push({
      name,
      summary: sentence,
      detail: [own ? plain(own.replace(/`/g, "")).split(/(?<=[.!?])\s/).slice(1, 3).join(" ") : "", output ? plain(output.replace(/`/g, "")) : ""].filter(Boolean),
      matcher: mt && !/not supported/i.test(mt.on) ? { on: mt.on, examples: [...mt.note.matchAll(/`([^`]+)`/g)].map((x) => x[1]), note: plain(mt.note.replace(/`/g, "")) } : null,
      block: null,
      doc: docRef(CX.hooks, codexAnchorFor(name)),
    });
  }
  return out;
}

// ----------------------------------------------------------------- skills

export type SkillPlace = { scope: string; pattern: string };

/** The folders in "Where Codex loads local skills", as `$CWD/.agents/skills`-style patterns. */
export function skillPlaces(): SkillPlace[] {
  const s = section(CX.skills, "where-codex-loads-local-skills") ?? "";
  const out: SkillPlace[] = [];
  for (const row of s.split("\n")) {
    const m = /^\|\s*`(\w+)`\s*\|\s*`([^`]+)`/.exec(row);
    if (m) out.push({ scope: m[1], pattern: m[2] });
  }
  return out;
}
