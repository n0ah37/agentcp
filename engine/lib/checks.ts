import fs from "node:fs";
import path from "node:path";

import type { FieldSpec, FileKind, Finding, InstructionsMode, Severity } from "../../shared/types.ts";
import { docRef, docSays } from "./docs.ts";
import { splitFrontmatter } from "./frontmatter.ts";
import { expandHome } from "./paths.ts";

/**
 * Every check cites the documentation it enforces, and names the sentence it
 * relies on. When a refresh of the docs drops that sentence, the finding says
 * the documentation changed instead of repeating a rule that may be gone.
 */

export type Cite = { slug: string; anchor?: string; says: string };

export function finding(
  id: string,
  severity: Severity,
  title: string,
  detail: string,
  cite: Cite,
  extra: Partial<Finding> = {},
): Finding {
  return {
    id,
    severity,
    title,
    detail,
    doc: docRef(cite.slug, cite.anchor),
    docCurrent: docSays(cite.slug, cite.says),
    ...extra,
  };
}

const C = {
  size: { slug: "memory", anchor: "write-effective-instructions", says: "target under 200 lines per CLAUDE.md file" },
  maxSize: { slug: "memory", anchor: "how-it-works", says: "skips a larger file" },
  structure: { slug: "memory", anchor: "write-effective-instructions", says: "use markdown headers and bullets" },
  imports: { slug: "memory", anchor: "import-additional-files", says: "Relative paths resolve relative to the file containing the import" },
  importQuoted: { slug: "memory", anchor: "import-additional-files", says: "A path wrapped in quotes isn't imported at all" },
  importSpace: { slug: "memory", anchor: "import-additional-files", says: "put a backslash before each space" },
  importDepth: { slug: "memory", anchor: "import-additional-files", says: "maximum depth of four hops" },
  localIgnore: { slug: "memory", anchor: "import-additional-files", says: "Add `CLAUDE.local.md` to your `.gitignore`" },
  agentsShadow: { slug: "memory", anchor: "when-claude-code-reads-agents-md", says: "By default, Claude reads `AGENTS.md` only when you have no `CLAUDE.md`" },
  agentsWords: { slug: "memory", anchor: "remove-an-earlier-agents-md-workaround", says: "tells Claude in words to read `AGENTS.md`" },
  agentsLink: { slug: "memory", anchor: "share-one-file-with-other-coding-tools", says: "refuse to write through a symlink" },
  refs: { slug: "memory", anchor: "write-effective-instructions", says: "references to files or commands that don't exist" },
  ruleFm: { slug: "memory", anchor: "rule-frontmatter-reference", says: "`paths` is the only field Claude Code reads from a rule" },
  ruleYaml: { slug: "memory", anchor: "rule-frontmatter-reference", says: "If the YAML between the markers doesn't parse" },
  hooks: { slug: "memory", anchor: "claude-isnt-following-my-claude-md", says: "Hooks execute as shell commands at fixed lifecycle events" },
  memLimit: { slug: "memory", anchor: "how-it-works", says: "The first 200 lines of `MEMORY.md`, or the first 25KB" },
  memIndex: { slug: "memory", anchor: "storage-location", says: "`MEMORY.md` acts as an index of the memory directory" },
  memType: { slug: "memory", anchor: "auto-memory", says: "Claude records the kind as a `type` field" },
  skillFm: { slug: "skills", anchor: "frontmatter-reference", says: "Claude Code reads the frontmatter only when the opening `---` is the file's first line" },
  skillField: { slug: "skills", anchor: "frontmatter-reference", says: "A field name must match the table exactly" },
  skillDesc: { slug: "skills", anchor: "frontmatter-reference", says: "truncated at 1,536 characters" },
  skillYaml: { slug: "skills", anchor: "frontmatter-reference", says: "If the YAML between the markers doesn't parse, the skill still loads with no fields set" },
  agentFm: { slug: "sub-agents", anchor: "frontmatter-reference", says: "Only `name` and `description` are required" },
  agentField: { slug: "sub-agents", anchor: "frontmatter-reference", says: "Claude Code ignores a field it doesn't recognize without reporting an error" },
  agentColon: { slug: "sub-agents", anchor: "frontmatter-reference", says: "Names can't contain `:`" },
  styleField: { slug: "output-styles", anchor: "frontmatter-reference", says: "A misspelled field is ignored without an error" },
} satisfies Record<string, Cite>;

export const LIMITS = {
  claudeMdLines: 200,
  claudeMdMaxBytes: 4 * 1024 * 1024,
  memoryLines: 200,
  memoryBytes: 25 * 1000,
  skillListing: 1536,
  importHops: 4,
};

/* ---------------------------------------------------------------- imports */

export type ImportRef = {
  line: number;
  raw: string;
  target: string;
  quoted: boolean;
};

/**
 * `@path` imports, skipping fenced blocks and code spans as Claude Code does.
 * An import starts at `@` at the start of a line or after whitespace or `(`.
 */
export function findImports(text: string): ImportRef[] {
  const out: ImportRef[] = [];
  let fence = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      return;
    }
    if (fence) return;
    const stripped = line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
    const re = /(^|[\s(])@(?:"([^"]+)"|'([^']+)'|((?:\\ |[^\s)`])+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped))) {
      const quoted = m[2] ?? m[3];
      const bare = m[4];
      if (!quoted && !bare) continue;
      let target = (quoted ?? bare).replace(/\\ /g, " ");
      if (!quoted) target = target.replace(/[.,;:!?]+$/, "");
      // Handles and emails are not paths: `@claude`, `name@host`.
      if (!quoted && !/[./~]/.test(target) && !/^[A-Z][A-Za-z0-9_-]*$/.test(target)) continue;
      out.push({ line: i + 1, raw: m[0].trim(), target, quoted: !!quoted });
    }
  });
  return out;
}

export function resolveImport(from: string, target: string): string {
  const t = expandHome(target);
  return path.isAbsolute(t) ? t : path.resolve(path.dirname(from), t);
}

/* ----------------------------------------------------------- shared bits */

function lineOf(text: string, re: RegExp): number | undefined {
  const i = text.split("\n").findIndex((l) => re.test(l));
  return i === -1 ? undefined : i + 1;
}

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

function closest(name: string, known: string[]): string | null {
  let best: string | null = null;
  let score = Infinity;
  for (const k of known) {
    const s = lev(name.toLowerCase(), k.toLowerCase());
    if (s < score) {
      score = s;
      best = k;
    }
  }
  return best && score <= Math.max(2, Math.floor(best.length / 4)) ? best : null;
}

/** Backticked relative paths that do not exist in the repository. */
function missingRefs(text: string, file: string, repoRoot: string | null): Finding[] {
  if (!repoRoot) return [];
  const out: Finding[] = [];
  const seen = new Set<string>();
  let fence = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      return;
    }
    if (fence) return;
    for (const m of line.matchAll(/`([^`\s]+)`/g)) {
      const ref = m[1];
      // Only things that read as repository paths: a slash, no scheme, no glob,
      // no placeholder, not a home or absolute path, not a command.
      if (!ref.includes("/") || /[*?<>{}$|=:@]/.test(ref) || ref.startsWith("~") || ref.startsWith("/") || ref.startsWith("-")) continue;
      if (!/^(\.{1,2}\/)?[\w.-]+(\/[\w.-]+)*\/?$/.test(ref)) continue;
      // A bare folder name (`src/`) is usually prose about a layout; only a
      // path with two segments or a file extension is checked.
      const segments = ref.replace(/^\.{1,2}\//, "").replace(/\/$/, "").split("/");
      if (segments.length < 2 && !/\.[a-z0-9]{1,6}$/i.test(ref)) continue;
      if (!/\.[a-z0-9]{1,6}$/i.test(ref) && !ref.endsWith("/") && segments.length < 2) continue;
      if (seen.has(ref)) continue;
      seen.add(ref);
      const bases = [path.dirname(file)];
      if (file.startsWith(repoRoot + path.sep)) bases.push(repoRoot);
      if (bases.some((b) => fs.existsSync(path.resolve(b, ref)))) continue;
      // Without a file extension, `owner/repo`, `feature/branch` and `@scope/pkg`
      // read the same as a folder path; only a path into a folder that exists
      // here is taken for one.
      const first = ref.replace(/^\.{1,2}\//, "").split("/")[0];
      if (!/\.[a-z0-9]{1,6}$/i.test(ref) && !bases.some((b) => fs.existsSync(path.resolve(b, first)))) continue;
      out.push(
        finding(
          `ref:${ref}`,
          "warning",
          `\`${ref}\` doesn't exist.`,
          "Instructions that point at a missing path send Claude looking for something that isn't there. Update the path or remove the line.",
          C.refs,
          { line: i + 1, group: "paths don't exist", subject: ref },
        ),
      );
    }
  });
  return out.slice(0, 20);
}

/* ------------------------------------------------------ instruction files */

export type InstructionContext = {
  path: string;
  kind: FileKind;
  text: string;
  bytes: number;
  isSymlink: boolean;
  linkTarget: string | null;
  repoRoot: string | null;
  mode: InstructionsMode;
  /** For CLAUDE.local.md: whether git ignores it (null outside a repo). */
  ignored?: boolean | null;
  /** For CLAUDE.local.md: whether git already tracks it. */
  tracked?: boolean;
  /** For AGENTS.md that is not read: the CLAUDE.md files that stop it loading. */
  shadowedBy?: string[];
  /** Imports that go deeper than four hops, by line. */
  tooDeep?: number[];
};

export function checkInstruction(ctx: InstructionContext): Finding[] {
  const out: Finding[] = [];
  const { text } = ctx;
  const lines = text.split("\n");
  const count = text.endsWith("\n") ? lines.length - 1 : lines.length;
  const name = path.basename(ctx.path);

  if (ctx.bytes > LIMITS.claudeMdMaxBytes) {
    out.push(finding("size:max", "problem", "Claude Code skips this file: it is over 4 MiB.", "Nothing in it reaches Claude. Split it, or move reference material into files Claude reads when it needs them.", C.maxSize));
  } else if (count > LIMITS.claudeMdLines && ctx.kind !== "rule" && ctx.kind !== "user-rule") {
    out.push(
      finding(
        "size:lines",
        "warning",
        `${count} lines, over the 200-line target.`,
        "Longer files take more context and are followed less reliably. Move instructions that only matter for some files into path-scoped rules, and multi-step procedures into skills.",
        C.size,
        { line: LIMITS.claudeMdLines + 1 },
      ),
    );
  }

  if (count > 40 && !lines.some((l) => /^#{1,6}\s/.test(l))) {
    out.push(finding("structure", "note", "No headings in a long file.", "Group related instructions under Markdown headings; Claude scans structure the way a reader does.", C.structure));
  }

  for (const imp of findImports(text)) {
    const abs = resolveImport(ctx.path, imp.target);
    if (imp.quoted) {
      out.push(
        finding(`import:quoted:${imp.line}`, "warning", `${imp.raw} is not imported: the path is in quotes.`, "Claude Code ignores a quoted import. Remove the quotes, and put a backslash before each space in the path.", C.importQuoted, {
          line: imp.line,
          fix: { kind: "replace", label: "Remove the quotes", line: imp.line, from: imp.raw.replace(/^[\s(]/, ""), to: "@" + imp.target.replace(/ /g, "\\ ") },
        }),
      );
      continue;
    }
    if (fs.existsSync(abs)) continue;
    const rest = lines[imp.line - 1].slice(lines[imp.line - 1].indexOf(imp.raw.replace(/^[\s(]/, "")) + imp.raw.replace(/^[\s(]/, "").length);
    const nextWord = /^ ([^\s)]+)/.exec(rest)?.[1];
    const joined = nextWord ? resolveImport(ctx.path, `${imp.target} ${nextWord}`) : null;
    if (joined && fs.existsSync(joined)) {
      const fixed = "@" + `${imp.target} ${nextWord}`.replace(/ /g, "\\ ");
      out.push(
        finding(`import:space:${imp.line}`, "warning", `The import stops at the space after ${imp.raw.trim()}.`, "A path with a space needs a backslash before the space, or Claude Code reads only the part before it.", C.importSpace, {
          line: imp.line,
          fix: { kind: "replace", label: "Escape the space", line: imp.line, from: `@${imp.target} ${nextWord}`, to: fixed },
        }),
      );
      continue;
    }
    out.push(
      finding(`import:missing:${imp.line}`, "problem", `${imp.raw.trim()} points at a file that doesn't exist.`, "Claude Code can't load it. Fix the path, or wrap the text in backticks if it isn't meant as an import.", C.imports, { line: imp.line }),
    );
  }
  for (const line of ctx.tooDeep ?? []) {
    out.push(finding(`import:depth:${line}`, "warning", "This import is more than four hops deep.", "Claude Code follows imports four levels down and stops there, so this file's own imports don't load.", C.importDepth, { line }));
  }

  if (ctx.kind === "local" && ctx.tracked) {
    out.push(
      finding("local:tracked", "warning", "CLAUDE.local.md is committed to git.", "It is meant for your own notes, and everyone who clones the repository gets it. Run git rm --cached CLAUDE.local.md, then add it to .gitignore.", C.localIgnore),
    );
  } else if (ctx.kind === "local" && ctx.ignored === false) {
    out.push(
      finding("local:ignore", "warning", "CLAUDE.local.md isn't in .gitignore.", "It holds your own notes for this project and would be committed with everyone else's instructions.", C.localIgnore, {
        fix: ctx.repoRoot ? { kind: "gitignore", label: "Add to .gitignore", repo: ctx.repoRoot, entry: "CLAUDE.local.md" } : undefined,
      }),
    );
  }

  if (ctx.kind === "agents-md" && ctx.shadowedBy?.length) {
    // Two folders' CLAUDE.md files name one file, not "CLAUDE.md and CLAUDE.md".
    const names = [...new Set(ctx.shadowedBy.map((p) => path.basename(p)))];
    out.push(
      finding("agents:shadowed", "warning", `Claude Code doesn't read this file: ${names.join(" and ")} ${names.length > 1 ? "are" : "is"} on the path.`, "By default Claude reads AGENTS.md only when no CLAUDE.md or CLAUDE.local.md exists here or above. Import it from your CLAUDE.md, or set Project instructions to read both.", C.agentsShadow, {
        fix: { kind: "setting", label: "Read CLAUDE.md and AGENTS.md", scope: "user", path: ["pluginConfigs", "agents-md@builtin", "options", "instructionFiles"], value: "claude-md-and-agents-md" },
      }),
    );
  }

  if ((ctx.kind === "claude-md" || ctx.kind === "local") && !findImports(text).some((i) => /AGENTS\.md$/.test(i.target))) {
    const line = lineOf(text, /\b(read|see|follow|consult|check)\b[^.\n]{0,40}\bAGENTS\.md\b/i);
    const sibling = path.join(path.dirname(ctx.path), "AGENTS.md");
    if (line && fs.existsSync(sibling)) {
      out.push(
        finding("agents:words", "warning", "This asks Claude in words to read AGENTS.md.", "Claude sees AGENTS.md only if it decides to open it. An @AGENTS.md import loads it every session.", C.agentsWords, {
          line,
          fix: { kind: "insert", label: "Add @AGENTS.md at the top", line: 1, text: "@AGENTS.md\n" },
        }),
      );
    }
  }

  if (name === "CLAUDE.md" && ctx.isSymlink && /AGENTS\.md$/.test(ctx.linkTarget ?? "")) {
    out.push(
      finding("agents:link", "note", "CLAUDE.md is a link to AGENTS.md.", "Claude reads it once, but its Edit and Write tools refuse to write through a link, and Windows clones check it out as a one-line text file. A CLAUDE.md containing @AGENTS.md avoids both.", C.agentsLink),
    );
  }

  if (ctx.kind === "rule" || ctx.kind === "user-rule") {
    const fm = splitFrontmatter(text);
    if (fm.error) {
      out.push(finding("rule:yaml", "warning", "The frontmatter doesn't parse, so the rule loads everywhere.", `Claude Code ignores frontmatter it can't read and treats the rule as having no paths. ${fm.error}`, C.ruleYaml, { line: 1 }));
    } else {
      for (const k of Object.keys(fm.data)) {
        if (k === "paths") continue;
        out.push(finding(`rule:field:${k}`, "note", `\`${k}\` does nothing in a rule.`, "paths is the only frontmatter field Claude Code reads from a rule.", C.ruleFm, { line: fm.lines[k] }));
      }
    }
  }

  const hookLine = lineOf(text, /\b(before|after)\s+(every|each)\s+(commit|push|edit|file (change|edit)|tool call)\b/i);
  if (hookLine) {
    out.push(
      finding("hook", "note", "This reads like something that must happen every time.", "Instructions are followed most of the time. A hook runs as a shell command at a fixed point, every time.", C.hooks, { line: hookLine }),
    );
  }

  out.push(...missingRefs(text, ctx.path, ctx.repoRoot));
  return out;
}

/* ------------------------------------------------------------- definitions */

export function checkDefinition(kind: "agent" | "style" | "skill", text: string, fields: FieldSpec[]): Finding[] {
  const out: Finding[] = [];
  const fm = splitFrontmatter(text);
  const cite = kind === "skill" ? C.skillField : kind === "agent" ? C.agentField : C.styleField;
  const known = fields.map((f) => f.name);

  if (!fm.present) {
    if (kind === "skill" && /^\s*\n*---\s*$/m.test(text.split("\n").slice(0, 5).join("\n"))) {
      out.push(finding("fm:first", "warning", "The frontmatter isn't on the first line, so it's read as text.", "Claude Code reads frontmatter only when --- is the file's first line.", C.skillFm, { line: 1 }));
    }
    if (kind === "agent") {
      out.push(finding("fm:none", "problem", "No frontmatter, so this subagent has no name or description.", "A subagent needs name and description in YAML frontmatter at the top of the file.", C.agentFm, { line: 1 }));
    }
    return out;
  }
  if (fm.error) {
    const colon = unquotedColon(text, fm.endLine);
    out.push(
      finding(
        "fm:yaml",
        "warning",
        colon ? `\`${colon.key}\` needs quotes: its text has a colon in it.` : "The frontmatter doesn't parse.",
        `When the frontmatter isn't valid YAML, the documentation says the file loads with no fields set, so it can lose its description. Other tools that read it are as strict. ${fm.error}`,
        kind === "skill" ? C.skillYaml : cite,
        { line: colon?.line ?? 1, fix: colon ? { kind: "replace", label: "Put it in quotes", line: colon.line, from: colon.value, to: JSON.stringify(colon.value) } : undefined },
      ),
    );
    return out;
  }
  if (known.length) {
    for (const k of Object.keys(fm.data)) {
      if (known.includes(k)) continue;
      const near = closest(k, known);
      out.push(
        finding(`fm:unknown:${k}`, "warning", `\`${k}\` isn't a field Claude Code reads.`, near ? `It is ignored without an error. Did you mean \`${near}\`?` : "It is ignored without an error.", cite, {
          line: fm.lines[k],
          fix: near ? { kind: "replace", label: `Rename to ${near}`, line: fm.lines[k], from: `${k}:`, to: `${near}:` } : undefined,
        }),
      );
    }
  }
  for (const f of fields.filter((x) => x.required === "yes")) {
    if (fm.data[f.name] === undefined || fm.data[f.name] === "") {
      out.push(finding(`fm:required:${f.name}`, "problem", `\`${f.name}\` is required and missing.`, f.description, C.agentFm, { line: 1 }));
    }
  }
  if (kind === "agent" && typeof fm.data.name === "string" && fm.data.name.includes(":")) {
    out.push(finding("agent:colon", "problem", "The name contains a colon, so Claude Code won't load this subagent.", "Colons are reserved for plugin-scoped names such as my-plugin:reviewer.", C.agentColon, { line: fm.lines.name }));
  }
  if (kind === "skill") {
    const desc = `${fm.data.description ?? ""}${fm.data.when_to_use ? " " + fm.data.when_to_use : ""}`;
    if (!fm.data.description) {
      out.push(finding("skill:desc", "warning", "No description.", "Claude decides when to use a skill from its description. Without one it uses the first line of the file.", C.skillDesc, { line: 1 }));
    } else if (desc.length > LIMITS.skillListing) {
      out.push(
        finding("skill:long", "warning", `The description is ${desc.length.toLocaleString()} characters; Claude sees the first 1,536.`, "Put the main use case first, and trim the rest.", C.skillDesc, { line: fm.lines.description }),
      );
    }
  }
  return out;
}

/* ------------------------------------------------------------------ memory */

export function checkMemoryIndex(lines: number, bytes: number, cutAfterLine: number | null): Finding[] {
  if (cutAfterLine !== null) {
    return [
      finding("mem:over", "problem", `Claude reads only the first ${cutAfterLine} lines of this index.`, `MEMORY.md loads up to 200 lines or 25 KB, whichever comes first. This one is ${lines} lines and ${(bytes / 1000).toFixed(1)} KB; everything after line ${cutAfterLine} is dropped each session. Keep one line per memory and move detail into the memory files.`, C.memLimit, { line: cutAfterLine + 1 }),
    ];
  }
  if (lines > LIMITS.memoryLines * 0.9 || bytes > LIMITS.memoryBytes * 0.9) {
    return [finding("mem:near", "warning", "This index is close to its load limit.", "MEMORY.md loads up to 200 lines or 25 KB. Merge or drop stale lines before new ones push old ones out.", C.memLimit)];
  }
  return [];
}

export function checkMemoryLinks(broken: { line: number; target: string }[], unindexed: string[]): Finding[] {
  const out: Finding[] = broken.map((b) =>
    finding(`mem:broken:${b.line}`, "warning", `Line ${b.line} points at ${b.target}, which doesn't exist.`, "Claude follows the index to find a memory. Remove the line, or restore the file from History.", C.memIndex, { line: b.line }),
  );
  if (unindexed.length) {
    out.push(
      finding("mem:unindexed", "note", `${unindexed.length} ${unindexed.length === 1 ? "memory isn't" : "memories aren't"} listed in the index.`, `Claude finds these only by listing the folder: ${unindexed.slice(0, 5).join(", ")}${unindexed.length > 5 ? ", …" : ""}.`, C.memIndex),
    );
  }
  return out;
}

export function checkMemoryFile(type: unknown): Finding[] {
  if (type === undefined || ["user", "feedback", "project", "reference"].includes(String(type))) return [];
  return [finding("mem:type", "note", `\`${String(type)}\` isn't one of the four memory types.`, "Claude records user, feedback, project or reference as a memory's type.", C.memType, { line: 1 })];
}

export function tally(findings: Finding[]): Record<Severity, number> {
  const t: Record<Severity, number> = { problem: 0, warning: 0, note: 0 };
  for (const f of findings) t[f.severity]++;
  return t;
}

/**
 * The first top-level field whose plain value has ": " in it, which YAML reads
 * as a second field and refuses: `description: Use it for: builds`.
 */
export function unquotedColon(text: string, endLine: number): { key: string; line: number; value: string } | null {
  const lines = text.split("\n").slice(1, Math.max(endLine - 1, 1));
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):[ \t]+(.+?)\s*$/.exec(lines[i]);
    if (!m || /^["'|>[{&*!]/.test(m[2])) continue;
    if (/:\s/.test(m[2]) || m[2].endsWith(":")) return { key: m[1], line: i + 2, value: m[2] };
  }
  return null;
}
