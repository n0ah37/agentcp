import path from "node:path";

import type { DocRef, FileKind, FileView, Finding, ProjectRef } from "../../shared/types.ts";
import { definitionFindings, fieldsFor, kindOfDefinition } from "./definitions.ts";
import { docRef } from "./docs.ts";
import { fileInfo, readText } from "./fsx.ts";
import { splitFrontmatter } from "./frontmatter.ts";
import { findingsFor, guessKind, resolveStack } from "./instructions.ts";
import { lockFor } from "./locks.ts";
import { memoryDir, memoryView } from "./memory.ts";
import { CLAUDE_DIR, expandHome, isInside, tilde } from "./paths.ts";
import { checkMemoryFile } from "./checks.ts";
import { CODEX_ABOUT, codexFindings, codexKindFor } from "./codex.ts";
import { OPENCODE_ABOUT, opencodeFindings, opencodeKindFor } from "./opencode.ts";

/** One sentence per kind of file, in plain words, with the section that says more. */
export const ABOUT: Record<FileKind, { summary: string; doc: () => DocRef }> = {
  ...(CODEX_ABOUT as Record<FileKind, { summary: string; doc: () => DocRef }>),
  ...(OPENCODE_ABOUT as Record<FileKind, { summary: string; doc: () => DocRef }>),
  managed: { summary: "Set by your organization. It loads before your own files and can't be excluded.", doc: () => docRef("memory", "deploy-organization-wide-claude-md") },
  "user-claude-md": { summary: "Your instructions for every project on this Mac. Claude reads them at the start of every session.", doc: () => docRef("memory", "choose-where-to-put-claude-md-files") },
  "user-rule": { summary: "A rule that applies in every project. Without paths in its frontmatter it loads every session; with paths, only when Claude reads a matching file.", doc: () => docRef("memory", "user-level-rules") },
  "claude-md": { summary: "Instructions for this project, usually shared through git. Claude reads them when a session starts here or in any folder below.", doc: () => docRef("memory", "set-up-a-project-claude-md") },
  local: { summary: "Your own notes for this project. Claude reads them right after CLAUDE.md. Keep this file out of git.", doc: () => docRef("memory", "import-additional-files") },
  rule: { summary: "A project rule. Without paths in its frontmatter it loads every session; with paths, only when Claude reads a matching file.", doc: () => docRef("memory", "organize-rules-with-claude/rules/") },
  "agents-md": { summary: "Instructions any coding agent can read. Claude Code reads this file when no CLAUDE.md is on the path, or next to CLAUDE.md if Project instructions says so.", doc: () => docRef("memory", "agents-md") },
  import: { summary: "Pulled in by an @ import, and read together with the file that imports it.", doc: () => docRef("memory", "import-additional-files") },
  "memory-index": { summary: "Claude's index of what it remembers about this project. The first 200 lines or 25 KB are read at the start of every session.", doc: () => docRef("memory", "how-it-works") },
  memory: { summary: "One thing Claude remembered. Claude opens it when the index says it's relevant.", doc: () => docRef("memory", "auto-memory") },
  agent: { summary: "A subagent. The frontmatter tells Claude when to hand work to it; the text below is its entire system prompt.", doc: () => docRef("sub-agents", "write-subagent-files") },
  style: { summary: "An output style. It replaces the part of Claude Code's system prompt that sets tone and format, from your next message on.", doc: () => docRef("output-styles", "create-a-custom-output-style") },
  skill: { summary: "A skill. Claude loads it when its description matches what you asked, or when you type its name after a slash.", doc: () => docRef("skills", "frontmatter-reference") },
  settings: { summary: "A settings file.", doc: () => docRef("settings") },
};

async function kindFor(abs: string, project: ProjectRef | null, agent: string | null): Promise<FileKind> {
  // On OpenCode's screens a shared file (AGENTS.md, a skill in .claude/skills) is described as OpenCode reads it.
  const opencode = opencodeKindFor(abs, agent);
  if (opencode) return opencode;
  const codex = codexKindFor(abs, agent);
  if (codex) return codex;
  if (project) {
    const stack = await resolveStack(project);
    const hit = stack.entries.find((e) => e.file.path === abs);
    if (hit) return hit.file.kind;
    const mem = await memoryDir(project.path);
    if (isInside(abs, mem.dir)) return path.basename(abs) === "MEMORY.md" ? "memory-index" : "memory";
  }
  if (isInside(abs, path.join(CLAUDE_DIR, "projects")) && abs.includes(`${path.sep}memory${path.sep}`)) {
    return path.basename(abs) === "MEMORY.md" ? "memory-index" : "memory";
  }
  const def = kindOfDefinition(abs);
  if (def) return def;
  if (path.extname(abs) === ".json") return "settings";
  return guessKind(abs);
}

export async function fileView(p: string, project: ProjectRef | null, text?: string, agent: string | null = null): Promise<FileView> {
  const abs = path.resolve(expandHome(p));
  const kind = await kindFor(abs, project, agent);
  const extra = project && (kind === "memory" || kind === "memory-index") ? [(await memoryDir(project.path)).dir] : [];
  const lock = kind === "memory" || kind === "memory-index" ? lockFor(abs, extra.length ? extra : [path.dirname(abs)]) : lockFor(abs);
  const info = await fileInfo(abs, kind, lock);
  const t = await readText(abs);
  const body = text ?? t?.text ?? "";

  let findings: Finding[] = [];
  let frontmatter: FileView["frontmatter"] = null;
  if (kind.startsWith("opencode-")) {
    findings = opencodeFindings(kind, abs, body);
    if (kind === "opencode-skill" || kind === "opencode-agent") {
      const fm = splitFrontmatter(body);
      frontmatter = fm.present ? { fields: [], values: fm.data, error: fm.error } : null;
    }
  } else if (kind.startsWith("codex-")) {
    findings = codexFindings(kind, body);
    if (kind === "codex-skill") {
      const fm = splitFrontmatter(body);
      frontmatter = fm.present ? { fields: [], values: fm.data, error: fm.error } : null;
    }
  } else if (kind === "agent" || kind === "style" || kind === "skill") {
    findings = await definitionFindings(kind, abs, body);
    const fm = splitFrontmatter(body);
    frontmatter = { fields: fieldsFor(kind), values: fm.data, error: fm.error };
  } else if (kind === "memory") {
    const fm = splitFrontmatter(body);
    const meta = (fm.data.metadata ?? {}) as Record<string, unknown>;
    findings = checkMemoryFile(fm.data.type ?? meta.type);
    frontmatter = fm.present ? { fields: [], values: fm.data, error: fm.error } : null;
  } else if (kind === "memory-index") {
    findings = project ? (await memoryView(project)).findings.filter((f) => !f.id.startsWith("mem:type")) : [];
  } else if (kind !== "settings") {
    findings = await findingsFor(project, abs, text);
  }

  const about = ABOUT[kind];
  let summary = about.summary;
  if (project && (kind === "claude-md" || kind === "local" || kind === "agents-md")) {
    const dir = path.dirname(abs).replace(/\/\.claude$/, "");
    const rel = path.relative(project.path, dir);
    if (rel.startsWith("..")) {
      summary = `Instructions for everything under ${tilde(dir)}. Claude reads them in any session started there or below, before the project's own files.`;
    } else if (rel) {
      summary = `Instructions for ${rel}/. Claude reads them when it opens a file in that folder.`;
    }
  }
  return { file: info, text: body, findings, about: { summary, doc: about.doc() }, frontmatter };
}
