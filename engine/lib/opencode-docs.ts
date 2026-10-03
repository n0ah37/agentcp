import type { DocRef, FieldSpec } from "../../shared/types.ts";
import { docRef, docSays, opencodeSchema, pageText, plain, section } from "./docs.ts";

/**
 * Everything the app knows about OpenCode comes from OpenCode's own
 * documentation (opencode.ai/docs) and the config schema it points to,
 * captured beside the other agents' docs (docs-fetch.ts). Nothing is learned
 * from the OpenCode installed on this Mac: its files are read from disk,
 * because showing them is the point, but what they mean comes from here.
 * Each rule names the sentence it stands on; tests/opencode.test.ts fails when
 * a page stops saying it.
 */

export const OC = {
  rules: "opencode/rules",
  config: "opencode/config",
  agents: "opencode/agents",
  commands: "opencode/commands",
  skills: "opencode/skills",
  mcp: "opencode/mcp-servers",
  plugins: "opencode/plugins",
  permissions: "opencode/permissions",
  cli: "opencode/cli",
  troubleshooting: "opencode/troubleshooting",
  intro: "opencode/index",
} as const;

export type OpencodeCite = { slug: string; anchor?: string; says: string; shown?: string };

/** A rule as the app prints it: the docs' sentence, without code marks, as a full sentence. */
export function ocRuleText(r: OpencodeCite): string {
  const t = (r.shown ?? r.says).replace(/`/g, "").replace(/\*\*/g, "");
  return /[.!?:]$/.test(t) ? t.replace(/:$/, ".") : t + ".";
}

export const OC_RULES = {
  // Instructions
  globalAgents: { slug: OC.rules, anchor: "global", says: "You can also have global rules in a `~/.config/opencode/AGENTS.md` file." },
  projectAgents: { slug: OC.rules, anchor: "project", says: "Place an `AGENTS.md` in your project root for project-specific rules." },
  projectScope: { slug: OC.rules, anchor: "project", says: "These only apply when you are working in this directory or its sub-directories." },
  walkUp: { slug: OC.rules, anchor: "precedence", says: "by traversing up from the current directory (`AGENTS.md`, `CLAUDE.md`)", shown: "OpenCode looks for AGENTS.md, then CLAUDE.md, from the project folder up" },
  firstWins: { slug: OC.rules, anchor: "precedence", says: "The first matching file wins in each category." },
  agentsOverClaude: { slug: OC.rules, anchor: "precedence", says: "For example, if you have both `AGENTS.md` and `CLAUDE.md`, only `AGENTS.md` is used." },
  globalOverClaude: { slug: OC.rules, anchor: "precedence", says: "Similarly, `~/.config/opencode/AGENTS.md` takes precedence over `~/.claude/CLAUDE.md`." },
  claudeProject: { slug: OC.rules, anchor: "claude-code-compatibility", says: "`CLAUDE.md` in your project directory (used if no `AGENTS.md` exists)" },
  claudeGlobal: { slug: OC.rules, anchor: "claude-code-compatibility", says: "`~/.claude/CLAUDE.md` (used if no `~/.config/opencode/AGENTS.md` exists)" },
  disableAll: { slug: OC.rules, anchor: "claude-code-compatibility", says: "export OPENCODE_DISABLE_CLAUDE_CODE=1        # Disable all .claude support" },
  disablePrompt: { slug: OC.rules, anchor: "claude-code-compatibility", says: "export OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1 # Disable only ~/.claude/CLAUDE.md" },
  disableSkills: { slug: OC.rules, anchor: "claude-code-compatibility", says: "export OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1 # Disable only .claude/skills" },
  instructionsCombined: { slug: OC.rules, anchor: "custom-instructions", says: "All instruction files are combined with your `AGENTS.md` files." },
  remoteTimeout: { slug: OC.rules, anchor: "custom-instructions", says: "Remote instructions are fetched with a 5 second timeout." },
  noImports: { slug: OC.rules, anchor: "referencing-external-files", says: "While opencode doesn't automatically parse file references in `AGENTS.md`", shown: "OpenCode doesn't follow file references such as @path in AGENTS.md" },
  // Config
  formats: { slug: OC.config, anchor: "format", says: "OpenCode supports both **JSON** and **JSONC** (JSON with Comments) formats." },
  merged: { slug: OC.config, anchor: "locations", says: "Configuration files are merged together, not replaced." },
  conflictOnly: { slug: OC.config, anchor: "locations", says: "Later configs override earlier ones only for conflicting keys." },
  globalConfig: { slug: OC.config, anchor: "global", says: "Place your global OpenCode config in `~/.config/opencode/opencode.json`." },
  projectWalk: { slug: OC.config, anchor: "per-project", says: "When OpenCode starts up, it first looks for a config file in the current directory, then traverses up to the nearest Git directory." },
  customConfig: { slug: OC.config, anchor: "custom-path", says: "Custom config is loaded between global and project configs in the precedence order." },
  managedDir: { slug: OC.config, anchor: "file-based", says: "`/Library/Application Support/opencode/`" },
  managedWins: { slug: OC.config, anchor: "macos-managed-preferences", says: "All managed preference keys appear in the resolved config and cannot be overridden by user or project configuration." },
  schema: { slug: OC.config, anchor: "schema", says: "The server/runtime config schema is defined in" },
  tuiLegacy: { slug: OC.config, anchor: "tui", says: "Legacy `theme`, `keybinds`, and `tui` keys in `opencode.json` are deprecated and automatically migrated when possible." },
  permissiveDefault: { slug: OC.config, anchor: "permissions", says: "By default, opencode **allows all operations** without requiring explicit approval." },
  defaultAgentPrimary: { slug: OC.config, anchor: "default-agent", says: "The default agent must be a primary agent (not a subagent)." },
  instructionsGlobs: { slug: OC.config, anchor: "instructions", says: "This takes an array of paths and glob patterns to instruction files." },
  // Agents
  agentDirsGlobal: { slug: OC.agents, anchor: "markdown", says: "Global: `~/.config/opencode/agents/`" },
  agentDirsProject: { slug: OC.agents, anchor: "markdown", says: "Per-project: `.opencode/agents/`" },
  agentName: { slug: OC.agents, anchor: "markdown", says: "The markdown file name becomes the agent name." },
  descRequired: { slug: OC.agents, anchor: "description", says: "This is a **required** config option." },
  modeDefault: { slug: OC.agents, anchor: "mode", says: "If no `mode` is specified, it defaults to `all`." },
  maxStepsDeprecated: { slug: OC.agents, anchor: "max-steps", says: "The legacy `maxSteps` field is deprecated. Use `steps` instead." },
  agentToolsDeprecated: { slug: OC.agents, anchor: "tools-deprecated", says: "`tools` is **deprecated**." },
  hiddenSubagentOnly: { slug: OC.agents, anchor: "hidden", says: "Only applies to `mode: subagent` agents." },
  builtIns: { slug: OC.agents, anchor: "built-in", says: "OpenCode comes with two built-in primary agents and three built-in subagents." },
  // Skills
  skillWalk: { slug: OC.skills, anchor: "understand-discovery", says: "For project-local paths, OpenCode walks up from your current working directory until it reaches the git worktree." },
  skillUnknown: { slug: OC.skills, anchor: "write-frontmatter", says: "Unknown frontmatter fields are ignored." },
  skillNameRegex: { slug: OC.skills, anchor: "validate-names", says: "^[a-z0-9]+(-[a-z0-9]+)*$" },
  skillNameDir: { slug: OC.skills, anchor: "validate-names", says: "Match the directory name that contains `SKILL.md`" },
  skillDescLen: { slug: OC.skills, anchor: "follow-length-rules", says: "`description` must be 1-1024 characters." },
  skillUnique: { slug: OC.skills, anchor: "troubleshoot-loading", says: "Ensure skill names are unique across all locations" },
  // MCP
  mcpLocal: { slug: OC.mcp, anchor: "local", says: 'Add local MCP servers using `type` to `"local"` within the MCP object.' },
  mcpRemote: { slug: OC.mcp, anchor: "remote", says: 'Add remote MCP servers by setting `type` to `"remote"`.' },
  mcpDisable: { slug: OC.mcp, anchor: "enable", says: "You can also disable a server by setting `enabled` to `false`." },
  mcpAuthFile: { slug: OC.mcp, anchor: "authenticating", says: "OpenCode will store the tokens securely in `~/.local/share/opencode/mcp-auth.json`." },
  // Sessions
  storageDir: { slug: OC.troubleshooting, anchor: "storage", says: "opencode stores session data and other application data on disk at:" },
  dbPath: { slug: OC.cli, says: "Print the database path." },
} satisfies Record<string, OpencodeCite>;

/** A citation and whether the page still says it. */
export function ocCite(c: OpencodeCite): { doc: DocRef; docCurrent: boolean } {
  return { doc: docRef(c.slug, c.anchor), docCurrent: docSays(c.slug, c.says) };
}

/** A rule for a "From OpenCode's docs" list. */
export const ocRule = (r: OpencodeCite) => ({ text: ocRuleText(r), ...ocCite(r) });

/**
 * The skill folders, from the skills page's list ("OpenCode searches these
 * locations"): each line names a place and a path pattern.
 */
export function ocSkillPlaces(): { label: string; pattern: string; scope: "project" | "user" }[] {
  const s = section(OC.skills, "place-files") ?? "";
  return [...s.matchAll(/^- ([^:]+): `([^`]+)\/<name>\/SKILL\.md`$/gm)].map((m) => ({
    label: m[1].trim(),
    pattern: m[2],
    scope: m[2].startsWith("~/") ? "user" : "project",
  }));
}

/** The built-in agents under "Built-in": each `### Use <name>` heading, its mode and first sentence. Hidden system agents are left out. */
export function ocBuiltinAgents(): { name: string; mode: string; description: string }[] {
  const s = section(OC.agents, "built-in") ?? "";
  const out: { name: string; mode: string; description: string }[] = [];
  for (const m of s.matchAll(/^### Use (\w+)\s*\n+_Mode_: `(\w+)`\s*\n+([^\n]+)/gm)) {
    if (/^Hidden system agent/.test(m[3])) continue;
    out.push({ name: m[1], mode: m[2], description: plain(m[3]).split(/(?<=\.)\s/)[0] });
  }
  return out;
}

/** The frontmatter keys an agent file can set: the headings under "Options". */
export function ocAgentFields(): FieldSpec[] {
  const s = section(OC.agents, "options") ?? "";
  const required = docSays(OC.agents, OC_RULES.descRequired.says);
  return [...s.matchAll(/^### ([\w ]+?)(?: \(deprecated\))?\s*$/gm)]
    .map((m) => m[1].trim().toLowerCase().replace(/ /g, "_"))
    .filter((n) => n !== "additional" && n !== "task_permissions")
    .map((n) => (n === "max_steps" ? "steps" : n === "permissions" ? "permission" : n))
    .map((name) => ({ name, required: name === "description" && required ? "yes" : "no", description: "" }) as FieldSpec);
}

export type OcKey = { key: string; type: string; description: string; enum: string[] | null; deprecated: boolean };

/** Every top-level key of opencode.json, from the captured schema: its type, description and allowed values. */
export function ocConfigKeys(): OcKey[] {
  const s = opencodeSchema() as (SchemaNode & { properties?: Record<string, SchemaNode>; $defs?: Record<string, SchemaNode>; definitions?: Record<string, SchemaNode> }) | null;
  if (!s) return [];
  const defs = { ...(s.definitions ?? {}), ...(s.$defs ?? {}) };
  const resolve = (n: SchemaNode | undefined): SchemaNode => {
    let cur = n ?? {};
    for (let i = 0; i < 5 && cur.$ref; i++) cur = defs[cur.$ref.replace(/^#\/(\$defs|definitions)\//, "")] ?? {};
    return cur;
  };
  // The schema's root is a reference to its Config definition.
  const root = resolve(s) as SchemaNode & { properties?: Record<string, SchemaNode> };
  return Object.entries(root.properties ?? s.properties ?? {})
    .filter(([k]) => k !== "$schema")
    .map(([key, raw]) => {
      const n = resolve(raw);
      const type = typeOf(n, resolve);
      return { key, type, description: plain(raw.description ?? n.description ?? ""), enum: Array.isArray(n.enum) ? n.enum.map(String) : null, deprecated: !!(raw.deprecated ?? n.deprecated) || /deprecated/i.test(raw.description ?? "") };
    });
}

type SchemaNode = { $ref?: string; type?: string | string[]; description?: string; enum?: unknown[]; anyOf?: SchemaNode[]; oneOf?: SchemaNode[]; deprecated?: boolean; items?: SchemaNode };

function typeOf(n: SchemaNode, resolve: (n: SchemaNode | undefined) => SchemaNode): string {
  if (n.enum) return "one of the listed values";
  if (Array.isArray(n.type)) return n.type.join(" or ");
  if (n.type === "array") return `list${n.items ? ` of ${typeOf(resolve(n.items), resolve)}` : ""}`;
  if (n.type) return n.type;
  const alts = n.anyOf ?? n.oneOf;
  if (alts) return [...new Set(alts.map((a) => typeOf(resolve(a), resolve)))].join(" or ");
  return "value";
}

/** The page text, for tests that read a list straight off it. */
export const ocPage = (slug: string) => pageText(slug);
