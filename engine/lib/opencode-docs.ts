import type { DocRef, FieldSpec } from "../../shared/types.ts";
import { docRef, docSays, opencodeCliSchema, pageText, plain, section } from "./docs.ts";
import { parseJsonc } from "./jsonc.ts";

/**
 * Everything the app knows about OpenCode comes from OpenCode's own
 * documentation, captured beside the other agents' docs (docs-fetch.ts).
 * OpenCode 2 (GA 2026-09-11) is documented at opencode.ai/v2/docs; it still
 * reads OpenCode 1's config shape, which its "Migrate from V1" page maps onto
 * the new names, so that page is where the old names come from. Nothing is
 * learned from the OpenCode installed on this Mac: its files are read from
 * disk, because showing them is the point, but what they mean comes from here.
 * Each rule names the sentence it stands on; tests/opencode.test.ts fails when
 * a page stops saying it.
 */

export const OC = {
  instructions: "opencode/instructions",
  config: "opencode/config",
  migrate: "opencode/migrate-v1",
  agents: "opencode/agents",
  commands: "opencode/commands",
  skills: "opencode/skills",
  mcp: "opencode/mcp-servers",
  plugins: "opencode/plugins",
  permissions: "opencode/permissions",
  cli: "opencode/cli",
  cliConfig: "opencode/cli/config",
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
  globalThenUp: {
    slug: OC.instructions,
    anchor: "scope",
    says: "OpenCode loads the global file followed by every `AGENTS.md` from the current workspace directory toward the home directory.",
    shown: "OpenCode reads ~/.config/opencode/AGENTS.md, then every AGENTS.md from the project folder up to your home folder",
  },
  outsideHome: { slug: OC.instructions, anchor: "scope", says: "For workspaces outside the home directory, it stops at the project root." },
  combined: { slug: OC.instructions, anchor: "scope", says: "OpenCode combines the files and does not resolve conflicts between them." },
  agentsOnly: { slug: OC.instructions, anchor: "scope", says: "It does not use `CLAUDE.md` as a fallback.", shown: "OpenCode 2 reads AGENTS.md only; it doesn't use CLAUDE.md as a fallback" },
  disableProject: { slug: OC.instructions, anchor: "scope", says: "Set `OPENCODE_DISABLE_PROJECT_CONFIG=1` to skip project `AGENTS.md` discovery without disabling the global file." },
  nested: { slug: OC.instructions, anchor: "discovery", says: "Instruction files below the workspace are discovered as the agent explores the project." },
  nestedEdits: { slug: OC.instructions, anchor: "discovery", says: "Edits to a nested file are not detected automatically after it loads." },
  liveEdits: { slug: OC.instructions, anchor: "updates", says: "Edit a global or upward-discovered `AGENTS.md` while a session is running to update its guidance." },
  instructionsUnused: {
    slug: OC.instructions,
    anchor: "configuration",
    says: "The V2 config schema accepts an `instructions` array, but V2 does not currently resolve its files, glob patterns, or URLs.",
    shown: "OpenCode 2 accepts an instructions list in opencode.json but doesn't read its files, globs or URLs yet",
  },
  upToHome: { slug: OC.migrate, anchor: "instruction-files", says: "V2 discovers the global `~/.config/opencode/AGENTS.md` and ambient `AGENTS.md` files from the current directory up to home." },
  // Config
  formats: { slug: OC.config, anchor: "format", says: "OpenCode supports JSON and JSONC." },
  toRoot: { slug: OC.config, anchor: "locations", says: "OpenCode searches from the current directory to the filesystem root." },
  directThenDot: {
    slug: OC.config,
    anchor: "locations",
    says: "It first merges direct `opencode.json(c)` files from the farthest directory to the closest, then merges files inside `.opencode` directories in the same order.",
    shown: "OpenCode merges every opencode.json from the farthest folder to the closest, then every .opencode/opencode.json in the same order",
  },
  dotWins: { slug: OC.config, anchor: "locations", says: "This means every discovered `.opencode` config overrides every direct config." },
  preserved: { slug: OC.config, anchor: "locations", says: "Settings that do not conflict are preserved." },
  updateGlobal: { slug: OC.config, anchor: "updates", says: "Project-level values are ignored." },
  v1Read: { slug: OC.migrate, anchor: "use-your-existing-configuration", says: "It normalizes supported V1 and native V2 fields in memory without rewriting the source file." },
  v2Wins: { slug: OC.migrate, anchor: "ask-opencode-to-migrate", says: "When both forms set the same canonical value, a valid native V2 value takes precedence regardless of JSON key order." },
  ignored: { slug: OC.migrate, anchor: "accepted-but-unsupported-fields", says: "V2 ignores these values and emits a warning so they are not mistaken for active configuration" },
  lspIdle: { slug: OC.migrate, anchor: "supported-fields-without-direct-native-equivalents", says: "V2 accepts and preserves `lsp` configuration, but it does not run language servers, expose LSP tools, or produce LSP diagnostics." },
  cliJson: { slug: OC.migrate, anchor: "breaking-changes", says: "moves from layered `tui.json(c)` files to one global `cli.json` file (auto migrated)." },
  cliOnly: { slug: OC.cliConfig, anchor: "configuration-file", says: "There is no project-local CLI settings file." },
  cliSeparate: { slug: OC.cliConfig, says: "They are separate from the server and project settings in `opencode.json(c)`." },
  // Agents
  agentPlaces: { slug: OC.agents, anchor: "locations", says: "Save Markdown agents globally for all projects or inside a project:" },
  agentWalk: { slug: OC.agents, anchor: "locations", says: "OpenCode discovers project `.opencode` directories from the current directory up to the project root." },
  agentNested: { slug: OC.agents, anchor: "locations", says: "A nested path becomes part of the agent ID:" },
  agentBody: { slug: OC.agents, anchor: "markdown", says: "The Markdown body becomes the agent's `system` prompt:" },
  agentJson: { slug: OC.agents, anchor: "jsonc", says: "Define agents under `agents` in any" },
  modeDefault: { slug: OC.agents, anchor: "mode", says: "When omitted on a new custom agent, it defaults to `primary`:" },
  descForSubagents: { slug: OC.agents, anchor: "description", says: "Add it to subagents because OpenCode shows it to the model choosing which agent to launch:" },
  builtIns: { slug: OC.agents, anchor: "builtins", says: "OpenCode includes these visible agents:" },
  hiddenAgents: { slug: OC.agents, anchor: "builtins", says: "Hidden `compaction`, `title`, and `summary` agents perform maintenance and cannot be selected directly." },
  overrideBuiltin: { slug: OC.agents, anchor: "builtins", says: "Override a built-in by using the same ID:" },
  agentMerge: { slug: OC.agents, anchor: "merging", says: "Agent definitions merge in configuration order." },
  agentLegacy: {
    slug: OC.agents,
    anchor: "request",
    says: "Do not use legacy top-level fields such as `temperature`, `top_p`, `prompt`, `permission`, `tools`, `disable`, or `maxSteps` in new V2 agent configuration.",
  },
  agentV1Dirs: { slug: OC.migrate, anchor: "agent-files", says: "V2 still discovers all four directories." },
  modeDirs: { slug: OC.migrate, anchor: "agent-files", says: "Files under a V1 `mode/` or `modes/` directory represent primary agents." },
  // Commands
  commandPlaces: { slug: OC.commands, anchor: "markdown", says: "Put global commands in `~/.config/opencode/commands/` and project commands in `.opencode/commands/`." },
  commandNested: { slug: OC.commands, anchor: "markdown", says: "Nested paths become command names with `/` separators:" },
  commandLegacyDir: { slug: OC.commands, anchor: "markdown", says: "The legacy singular directories `command/` are also discovered," },
  commandJson: { slug: OC.commands, anchor: "json", says: "Each command requires a `template`." },
  commandNoTemplate: { slug: OC.commands, anchor: "fields", says: "Do not put `template` in Markdown frontmatter; the body supplies it." },
  commandSubtask: { slug: OC.commands, anchor: "fields", says: "Deprecated alias for `subagent`." },
  commandLater: { slug: OC.commands, anchor: "loading", says: "Later sources replace earlier commands with the same name." },
  commandNearer: { slug: OC.commands, anchor: "loading", says: "Project sources take precedence over global sources, and nearer project sources take precedence over ancestor sources." },
  // Skills
  skillPlaces: { slug: OC.skills, anchor: "discovery", says: "OpenCode automatically searches these locations:" },
  skillEveryLevel: { slug: OC.skills, anchor: "discovery", says: "For project sources, OpenCode searches from the current directory up to the project root and includes matching directories at every level." },
  skillRootMd: { slug: OC.skills, anchor: "discovery", says: "Markdown files must be at the source root, such as `skills/review.md`." },
  skillAnyDepth: { slug: OC.skills, anchor: "discovery", says: "Files named exactly `SKILL.md` can be at any depth, such as `skills/git-release/SKILL.md`." },
  skillArrays: { slug: OC.skills, anchor: "sources", says: "`skills` arrays are combined rather than replaced." },
  skillId: { slug: OC.skills, anchor: "ids", says: "The file path determines the skill ID. The frontmatter `name` is only a display label." },
  skillPortable: { slug: OC.skills, anchor: "ids", says: "For portable skills, use a unique lowercase kebab-case ID of 1–64 characters and keep it aligned with the directory name:" },
  skillLater: { slug: OC.skills, anchor: "precedence", says: "the source registered later supplies the skill that OpenCode loads" },
  skillOrder: { slug: OC.skills, anchor: "precedence", says: "Sources are registered from lower to higher precedence:" },
  skillNoDesc: { slug: OC.skills, anchor: "frontmatter", says: "skills without one are not advertised." },
  skillAutoinvoke: { slug: OC.skills, anchor: "frontmatter", says: "`opencode/autoinvoke: false` only hides the skill from the model's available list." },
  skillV1Dir: { slug: OC.migrate, anchor: "skill-files", says: "V2 discovers skills from both `.opencode/skill/` and `.opencode/skills/`." },
  // MCP
  mcpServers: { slug: OC.mcp, anchor: "config", says: "To configure a server by hand, give it a unique name under `mcp.servers`. V2 does not place server names directly under `mcp`." },
  mcpAuto: { slug: OC.mcp, anchor: "config", says: "Servers connect automatically." },
  mcpDisabled: { slug: OC.mcp, anchor: "config", says: "Use `disabled`, not an `enabled` field, to keep one configured without connecting it:" },
  mcpReplace: { slug: OC.mcp, anchor: "config", says: "A higher-precedence project config replaces the entire server object with the same name." },
  mcpLocal: { slug: OC.mcp, anchor: "local", says: "A local server is a command that OpenCode starts over the MCP stdio transport." },
  mcpRemote: { slug: OC.mcp, anchor: "remote", says: "A remote server uses the MCP Streamable HTTP transport and requires an absolute URL:" },
  mcpOauth: { slug: OC.mcp, anchor: "oauth", says: "OAuth is enabled for remote servers unless `oauth` is `false`." },
  mcpV1: { slug: OC.migrate, anchor: "mcp-servers", says: "V2 groups servers under `mcp.servers`, replaces `enabled` with the inverse `disabled`, and separates timeout purposes:" },
  // Plugins
  pluginRelative: { slug: OC.plugins, anchor: "configure", says: "Relative paths resolve from the config file containing the entry." },
  pluginArrays: { slug: OC.plugins, anchor: "configure", says: "Plugin arrays from applicable config files are applied from lowest to highest precedence instead of replacing one another." },
  pluginDiscover: { slug: OC.plugins, anchor: "discover", says: "OpenCode also loads direct `.ts` and `.js` files and immediate plugin package directories from every discovered `.opencode/plugins/` directory." },
  pluginGlobal: { slug: OC.plugins, anchor: "discover", says: "Global plugins use the same discovery layout under the OpenCode config directory." },
  pluginBeside: { slug: OC.plugins, anchor: "discover", says: "A `plugins/` directory beside a project-root `opencode.json(c)` is not discovered automatically;" },
  pluginOff: { slug: OC.plugins, anchor: "control", says: "Prefix an ID or wildcard with `-` to disable it," },
  pluginV1Dir: { slug: OC.migrate, anchor: "plugins", says: "V2 discovers local plugins from both `.opencode/plugin/` and `.opencode/plugins/`;" },
  pluginV1Code: { slug: OC.migrate, anchor: "plugins", says: "V1 plugin implementations do not run in V2." },
  // Sessions
  dbPath: { slug: OC.cli, anchor: "paths", says: "The database path respects the release channel and `OPENCODE_DB`;" },
} satisfies Record<string, OpencodeCite>;

/** A citation and whether the page still says it. */
export function ocCite(c: OpencodeCite): { doc: DocRef; docCurrent: boolean } {
  return { doc: docRef(c.slug, c.anchor), docCurrent: docSays(c.slug, c.says) };
}

/** A rule for a "From OpenCode's docs" list. */
export const ocRule = (r: OpencodeCite) => ({ text: ocRuleText(r), ...ocCite(r) });

/**
 * The skill sources, from the Discovery table on the skills page ("Global",
 * "Project compatibility"…): each row names its scope and one or more folders.
 */
export function ocSkillPlaces(): { label: string; pattern: string; scope: "project" | "user" }[] {
  const s = section(OC.skills, "discovery") ?? "";
  const out: { label: string; pattern: string; scope: "project" | "user" }[] = [];
  for (const m of s.matchAll(/^\|\s*(Global|Global compatibility|Project|Project compatibility)\s*\|([^|]+)\|/gm)) {
    for (const p of m[2].matchAll(/`([^`]+)`/g)) out.push({ label: m[1], pattern: p[1], scope: m[1].startsWith("Global") ? "user" : "project" });
  }
  return out;
}

/** The visible built-in agents: the rows of the Builtins table, with their mode and purpose. */
export function ocBuiltinAgents(): { name: string; mode: string; description: string }[] {
  const s = section(OC.agents, "builtins") ?? "";
  return [...s.matchAll(/^\|\s*\*\*[^*]+\*\*\s*\(`([\w-]+)`\)\s*\|\s*`(\w+)`\s*\|\s*([^|]+)\|/gm)].map((m) => ({ name: m[1], mode: m[2], description: plain(m[3]).split(/(?<=\.)\s/)[0] }));
}

/** The hidden agents the Builtins section names, which you can change but not pick. */
export function ocHiddenAgents(): string[] {
  const s = section(OC.agents, "builtins") ?? "";
  const m = /Hidden ([^.]+?) agents perform maintenance/.exec(s);
  return m ? [...m[1].matchAll(/`([\w-]+)`/g)].map((x) => x[1]) : [];
}

/** The frontmatter keys an agent file can set: the headings under "Options". */
export function ocAgentFields(): FieldSpec[] {
  const s = section(OC.agents, "options") ?? "";
  return [...s.matchAll(/^### ([\w ]+?)\s*$/gm)].map((m) => ({ name: m[1].trim().toLowerCase().replace(/ /g, "_"), required: "no", description: "" }) as FieldSpec);
}

/** The fields a command can set: the rows of the commands page's Fields table. */
export function ocCommandFields(): FieldSpec[] {
  const s = section(OC.commands, "fields") ?? "";
  return [...s.matchAll(/^\|\s*`(\w+)`\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm)]
    .filter((m) => m[1] !== "template")
    .map((m) => ({ name: m[1], required: /^yes/i.test(m[2]) ? "yes" : "no", description: plain(m[3]) }) as FieldSpec);
}

export type OcKey = { key: string; type: string; description: string; enum: string[] | null; deprecated: boolean; heading: string; anchor: string };

/**
 * Every top-level key of opencode.json, from the config page: each section
 * under its settings headings (Shell, Model, Agent…) shows the key in its first
 * JSONC example, and its first paragraph says what it does.
 */
export function ocConfigKeys(): OcKey[] {
  const text = pageText(OC.config) ?? "";
  const out: OcKey[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/^### (.+)\n([\s\S]*?)(?=^#{2,3} |(?![\s\S]))/gm)) {
    const heading = m[1].trim();
    const body = m[2];
    const code = /```jsonc?(?:[^\n]*)\n([\s\S]*?)```/.exec(body)?.[1];
    if (!code) continue;
    const data = parseJsonc(code).data;
    if (!data) continue;
    const description = plain(body.split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith("```")) ?? "");
    for (const [key, v] of Object.entries(data)) {
      if (key === "$schema" || seen.has(key)) continue;
      seen.add(key);
      out.push({ key, type: kindOf(v), description, enum: null, deprecated: false, heading, anchor: heading.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-") });
    }
  }
  return out;
}

const kindOf = (v: unknown): string => (Array.isArray(v) ? "list" : v === null ? "value" : typeof v === "object" ? "object" : typeof v);

/**
 * OpenCode 1's names for settings OpenCode 2 reads under a new name, from the
 * "Migrate from V1" page. OpenCode 2 reads either; the new name wins when a
 * file sets both.
 */
export const OC_V1_NAMES: Record<string, string> = {
  provider: "providers",
  agent: "agents",
  mode: "agents",
  permission: "permissions",
  tools: "permissions",
  command: "commands",
  snapshot: "snapshots",
  attachment: "media",
  autoshare: "share",
  autoupdate: "update",
  reference: "references",
  plugin: "plugins",
  small_model: "agents",
  enabled_providers: "experimental",
  disabled_providers: "experimental",
};

/** Settings OpenCode 2 accepts but ignores, with a warning (the migration page's "Accepted but unsupported fields"). */
export const OC_IGNORED: Record<string, string> = {
  logLevel: "Set OPENCODE_LOG_LEVEL when starting OpenCode instead.",
  server: "OpenCode 2 runs a background service with its own options instead.",
  subagent_depth: "Use experimental.subagent_depth instead.",
  layout: "OpenCode always uses the stretch layout.",
};

/** Keys that belong to the terminal client now: OpenCode 2 moves them to cli.json. */
export const OC_TO_CLI = new Set(["theme", "keybinds", "tui"]);

export type CliKey = { key: string; type: string; description: string; options: string[] | null };

/** cli.json's settings, from the schema its settings page links to (opencode.ai/v2/cli.json). */
export function ocCliKeys(): CliKey[] {
  const s = opencodeCliSchema() as (Node & { properties?: Record<string, Node>; $defs?: Record<string, Node> }) | null;
  if (!s) return [];
  const defs = s.$defs ?? {};
  const resolve = (n: Node | undefined): Node => {
    let cur = n ?? {};
    for (let i = 0; i < 5 && cur.$ref; i++) cur = defs[cur.$ref.replace(/^#\/\$defs\//, "")] ?? {};
    return cur;
  };
  return Object.entries(s.properties ?? {})
    .filter(([k]) => k !== "$schema")
    .map(([key, raw]) => {
      const n = resolve(raw);
      return { key, type: typeOf(n, resolve), description: plain(raw.description ?? n.description ?? ""), options: Array.isArray(n.enum) ? n.enum.map(String) : null };
    });
}

type Node = { $ref?: string; type?: string | string[]; description?: string; enum?: unknown[]; anyOf?: Node[]; oneOf?: Node[]; items?: Node };

function typeOf(n: Node, resolve: (n: Node | undefined) => Node): string {
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
