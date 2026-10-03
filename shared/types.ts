// The contract between the engine and any client (the web UI today, a desktop
// shell later). Everything the engine returns is described here, and nothing
// else crosses the boundary.

export type DocRef = {
  /** Page path under vendor/docs/claude-code, e.g. "memory" or "agent-sdk/skills". */
  slug: string;
  /** Heading anchor on that page, without the leading #. */
  anchor?: string;
  /** Heading text the anchor resolved to in the vendored copy, if it still exists. */
  heading?: string;
  /** Public URL of the section. */
  url: string;
};

export type Severity = "problem" | "warning" | "note";

export type Fix =
  | { kind: "replace"; label: string; line: number; from: string; to: string }
  | { kind: "insert"; label: string; line: number; text: string }
  | { kind: "gitignore"; label: string; repo: string; entry: string }
  | { kind: "setting"; label: string; scope: SettingScope; path: string[]; value: unknown };

export type Finding = {
  id: string;
  severity: Severity;
  /** One sentence: what is wrong. */
  title: string;
  /** One or two sentences: what it means and what to do. */
  detail: string;
  /** 1-based line range in the file, when the finding points at text. */
  line?: number;
  endLine?: number;
  doc: DocRef;
  /**
   * False when the documentation this check is built on no longer contains the
   * sentence it relies on. The check still runs, and says so.
   */
  docCurrent: boolean;
  fix?: Fix;
  /** Findings that share this label and explanation are shown as one item: "5 paths don't exist". */
  group?: string;
  /** What the finding is about, shown in a grouped item's list (a path, an import). */
  subject?: string;
};

export type FileKind =
  | "managed"
  | "user-claude-md"
  | "user-rule"
  | "claude-md"
  | "local"
  | "rule"
  | "agents-md"
  | "import"
  | "memory-index"
  | "memory"
  | "agent"
  | "style"
  | "skill"
  | "settings"
  | "codex-instructions"
  | "codex-config"
  | "codex-agent"
  | "codex-skill"
  | "codex-rules"
  | "codex-hooks"
  | "codex-memory"
  | "opencode-instructions"
  | "opencode-config"
  | "opencode-agent"
  | "opencode-skill";

export type Loads = "launch" | "on-demand" | "not-read";

export type FileInfo = {
  path: string;
  display: string;
  name: string;
  kind: FileKind;
  exists: boolean;
  bytes: number;
  lines: number;
  modified: string | null;
  isSymlink: boolean;
  linkTarget: string | null;
  /** Content hash, used to refuse a save when the disk copy moved. */
  hash: string | null;
  editable: boolean;
  /** Why the file cannot be edited, when it cannot. */
  lockedBecause: string | null;
  /** There, but the app isn't allowed to read it (no permission, or macOS refused): nothing about it is known. */
  unreadable: boolean;
};

export type StackEntry = {
  id: string;
  file: FileInfo;
  /** Key of the folder level the file belongs to (see InstructionsView.levels). */
  level: string;
  /** Short label for where the file sits: "Everywhere", "This project", "Only you", ... */
  where: string;
  loads: Loads;
  /** Why a file loads later or not at all. */
  reason: string | null;
  /** For imports: the entry that imports this one. */
  parent: string | null;
  depth: number;
  /** Bytes Claude receives from this file after comments are stripped. */
  sentBytes: number;
  counts: Record<Severity, number>;
};

export type MissingSlot = {
  id: string;
  level: string;
  path: string;
  display: string;
  label: string;
  hint: string;
  template: string;
};

export type InstructionsMode =
  | "claude-md-or-agents-md"
  | "claude-md-and-agents-md"
  | "claude-md"
  | "managed-only";

/**
 * One step of the folder hierarchy Claude walks: your organization, your own
 * ~/.claude, each folder from the top of the disk down to the project, the
 * project's subfolders, and auto memory. Files at a level add to the levels
 * above it; nothing replaces anything.
 */
export type Level = {
  key: string;
  kind: "org" | "user" | "folder" | "project" | "subfolder" | "memory";
  /** Short name, relative to the level above: "~/Dev", "Work/storefront", "app/". */
  label: string;
  /** What it covers, in words: "Every project under ~/Dev". */
  covers: string;
  path: string | null;
  depth: number;
};

/** A file OpenAI's Codex reads for a project, in its order. */
export type CodexEntry = {
  id: string;
  file: FileInfo;
  level: string;
  /** read: in full · cut: partly, the rest is over Codex's budget · dropped: over budget · not-read: another file in the folder wins, or it's empty. */
  loads: "read" | "cut" | "dropped" | "not-read";
  reason: string | null;
  /** How much of it Codex reads. */
  bytesRead: number;
};

/** What Codex reads for a project, beside what Claude Code reads there. */
export type CodexView = {
  installed: boolean;
  home: string;
  config: { path: string; display: string; maxBytes: number; fallbacks: string[]; exists: boolean };
  levels: Level[];
  entries: CodexEntry[];
  missing: MissingSlot[];
  totals: { files: number; bytes: number; budget: number };
  /** Instruction files Claude Code reads here that Codex never will (Codex doesn't read CLAUDE.md). */
  claudeOnly: { path: string; display: string; lines: number }[];
  /** When the project's CLAUDE.md can be shared with Codex through an AGENTS.md. */
  share: { from: string; to: string; imports: number; finish: boolean } | null;
  /** The reading rules this view applies, each with the docs sentence it rests on. */
  rules: DocRule[];
};

/** A rule the app applies, quoted from the agent's docs; docCurrent is false when the page stopped saying it. */
export type DocRule = { text: string; doc: DocRef; docCurrent: boolean };

/** One of OpenCode's config files, in the order OpenCode merges them. */
export type OpencodeLayer = {
  path: string;
  display: string;
  label: string;
  kind: "user" | "custom" | "project" | "managed";
  exists: boolean;
  /** Why it couldn't be read, such as "isn't valid JSON". */
  broken: string | null;
  /** When it's read only in some cases ("only when OPENCODE_CONFIG names it"). */
  note: string | null;
};

/** What OpenCode reads for a project: one instructions file per kind, then the files opencode.json adds. */
export type OpencodeView = {
  home: string;
  levels: Level[];
  /** loads is "read" or "not-read"; OpenCode has no size limit, so nothing is cut. */
  entries: CodexEntry[];
  missing: MissingSlot[];
  /** instructions entries that are web addresses: OpenCode fetches them; the app only lists them. */
  remote: { url: string; from: string }[];
  layers: OpencodeLayer[];
  rules: DocRule[];
};

/** OpenCode's settings: every top-level key of opencode.json from its schema, with the value in force and the file that set it. */
export type OpencodeSettingsView = {
  project: ProjectRef | null;
  layers: OpencodeLayer[];
  rows: { key: string; type: string; description: string; options: string[] | null; deprecated: boolean; value: string | null; setIn: string | null; alsoIn: string[] }[];
  /** Keys a file sets that the schema doesn't have. */
  unknown: { key: string; file: string }[];
  capturedAt: string | null;
  doc: DocRef;
  rules: DocRule[];
};

export type CodexMemoriesView = {
  dir: string;
  files: { path: string; display: string; name: string; lines: number; bytes: number; modified: string | null; count: number | null }[];
  /** features.memories in your config, when it's set. */
  enabled: boolean | null;
  enabledByDefault: boolean;
  doc: DocRef;
  rules: DocRule[];
};

/** Codex's .rules files and the prefix rules in each. */
export type CodexRulesView = {
  files: {
    path: string;
    display: string;
    label: string;
    scope: "user" | "project";
    exists: boolean;
    /** False for a project's rules while the project isn't trusted. */
    used: boolean;
    rules: { pattern: string[]; decision: "allow" | "prompt" | "forbidden"; justification: string | null; line: number }[];
  }[];
  doc: DocRef;
  rules: DocRule[];
  template: string;
};

/** The writes that share a CLAUDE.md with Codex, each reviewed on its own. */
export type SharePlan = { steps: { path: string; content: string; baseHash: string | null; title: string }[]; note: string | null };

export type CombinedView = {
  sections: { path: string; display: string; name: string; where: string; level: string; lines: number; text: string }[];
  totals: { lines: number; bytes: number; tokens: number };
};

export type InstructionsView = {
  project: ProjectRef | null;
  levels: Level[];
  mode: InstructionsMode;
  modeSetIn: string | null;
  claudeVersion: string | null;
  agentsMdSupported: boolean;
  entries: StackEntry[];
  missing: MissingSlot[];
  totals: { files: number; lines: number; bytes: number; tokens: number };
};

export type ProjectRef = {
  path: string;
  display: string;
  name: string;
  group: string;
  lastActive: string | null;
  isWorktree: boolean;
  exists: boolean;
  counts?: Record<Severity, number>;
};

export type FileView = {
  file: FileInfo;
  text: string;
  findings: Finding[];
  /** What the documentation says this kind of file is for. */
  about: { summary: string; doc: DocRef } | null;
  frontmatter: Frontmatter | null;
};

export type Frontmatter = {
  /** Documented fields for this kind of file, parsed from the docs. */
  fields: FieldSpec[];
  values: Record<string, unknown>;
  error: string | null;
};

export type FieldSpec = {
  name: string;
  required: "yes" | "no" | "recommended";
  description: string;
};

export type WritePlan = {
  path: string;
  display: string;
  exists: boolean;
  changed: boolean;
  patch: string;
  added: number;
  removed: number;
  /** The file on disk no longer matches the version the client opened. */
  conflict: boolean;
  /** Hash of what is on disk now, for an explicit "save anyway". */
  diskHash: string | null;
  refusal: string | null;
  /** When the path is a link, the file that is actually written. */
  writesTo: string;
};

export type WriteResult = {
  path: string;
  hash: string;
  historyId: string | null;
};

/** A rename, checked before anything moves. */
export type RenamePlan = {
  from: string;
  to: string;
  display: string;
  /** Why it can't be renamed to this, or null when it can. */
  refusal: string | null;
  /** Other files the rename rewrites, such as the MEMORY.md line that links to it. */
  alsoUpdates: string[];
};

export type HistoryEntry = {
  id: string;
  at: string;
  action: "save" | "create" | "delete" | "restore";
  path: string;
  display: string;
  bytesBefore: number;
  bytesAfter: number;
  snapshot: string | null;
};

export type MemoryItem = {
  file: FileInfo;
  title: string;
  description: string;
  type: string | null;
  indexed: boolean;
  indexLine: number | null;
};

export type MemoryView = {
  project: ProjectRef | null;
  dir: string;
  dirDisplay: string;
  dirSetBy: string | null;
  enabled: boolean;
  enabledSetBy: string;
  index: FileInfo | null;
  limits: { lines: number; bytes: number };
  used: { lines: number; bytes: number };
  /** 1-based line after which MEMORY.md stops loading, or null when it all loads. */
  cutAfterLine: number | null;
  items: MemoryItem[];
  broken: { line: number; target: string; title: string }[];
  findings: Finding[];
};

/** One folder Claude keeps memory for: a project, or any folder sessions ran in, such as the home folder. */
export type MemoryFolder = {
  dir: string;
  /** The folder the memory belongs to, from its sessions or the disk; a best reading of the name when it's gone. */
  project: string;
  display: string;
  name: string;
  exists: boolean;
  memories: number;
  modified: string | null;
};

export type Definition = {
  file: FileInfo;
  name: string;
  description: string;
  where: string;
  source: "user" | "project" | "plugin" | "managed" | "builtin";
  plugin: string | null;
  counts: Record<Severity, number>;
  active?: boolean;
  shadowedBy?: string | null;
  /** Skills only: the other agent's skill by the same name, and how it relates to this one. */
  twin?: { agent: "claude" | "codex"; relation: "same" | "copy" | "different"; path: string };
  /** Built-ins only: what the docs say about it, as markdown. */
  body?: string;
};

export type DefinitionsView = {
  project: ProjectRef | null;
  kind: "agent" | "style" | "skill";
  items: Definition[];
  /** Output styles only: the style in force and the file that chose it. */
  active?: { name: string; setIn: string | null };
  locations: { label: string; path: string; display: string; exists: boolean }[];
  fields: FieldSpec[];
  doc: DocRef;
  /** Findings about the whole list rather than one file, such as Codex's budget for skill descriptions. */
  findings?: Finding[];
};

export type SettingScope = "user" | "project" | "local";

export type SettingControl =
  | { type: "boolean" }
  | { type: "enum"; options: { value: string; label: string }[] }
  | { type: "number" }
  | { type: "string" }
  | { type: "json" };

export type SettingValue = {
  scope: SettingScope | "managed";
  file: string;
  value: unknown;
  /** The layer's name, where it isn't one of Claude Code's scopes ("Profile: fast"). */
  label?: string;
  /** Set in a file that doesn't apply now, such as a Codex profile used only with --profile. */
  inactive?: boolean;
};

export type SettingRow = {
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
  doc: DocRef;
  values: SettingValue[];
  /** The value in force, from the highest-precedence file that sets it. */
  effective: SettingValue | null;
  merges: boolean;
};

export type SettingsView = {
  project: ProjectRef | null;
  files: { scope: SettingScope | "managed"; path: string; display: string; exists: boolean; error: string | null }[];
  topics: string[];
  featured: string[];
  rows: SettingRow[];
  capturedAt: string | null;
  agent?: "claude" | "codex";
  /** Codex only: its config layers, this project's trust, MCP servers, findings per file, and the permission presets its docs list. */
  codex?: {
    layers: { path: string; display: string; label: string; kind: "user" | "profile" | "project" | "system"; exists: boolean; used: boolean; problems: number; note: string | null }[];
    trust: { path: string; level: string | null } | null;
    mcp: { name: string; run: string; enabled: boolean; from: string }[];
    findings: Record<string, Finding[]>;
    projectFile: string | null;
    doc: DocRef;
    /** `byDefault`: the docs say it needs no flags, so it's what Codex does when none of the three is set. */
    permissions: { name: string; effect: string; sets: { sandbox_mode: string; approval_policy: string; approvals_reviewer: string | null }; byDefault: boolean }[];
  };
};

export type DocsInfo = {
  /** Null until the documentation has been downloaded once. */
  capturedAt: string | null;
  pages: number;
  ageDays: number | null;
  /** Which copy is in use: the one downloaded here, the one shipped with the app, or none. */
  where: "downloaded" | "shipped" | "none";
  /** Codex's documentation, captured beside Claude Code's. */
  codex: { capturedAt: string | null; pages: number; ageDays: number | null };
  /** OpenCode's documentation and its config schema, captured beside the others. */
  opencode: { capturedAt: string | null; pages: number; ageDays: number | null };
};

export type DocSearchHit = { slug: string; title: string; heading: string | null; anchor: string | null; snippet: string };

export type DocPage = { slug: string; title: string; url: string; markdown: string; fetchedAt: string };

export type Preferences = {
  allowEdits: boolean;
  appearance: "system" | "light" | "dark";
  projectRoots: string[];
  /** Folders the project search and the project list leave out, such as an archive. */
  skipFolders: string[];
  showWorktrees: boolean;
  lastProject: string | null;
  /** When first-run setup was finished; null shows setup on launch. */
  setupDone: string | null;
  /** Show the "Did you know?" card. */
  showTips: boolean;
  /** Show instruction files and skills formatted rather than as text (Text | Formatted above the file). */
  formatted: boolean;
  /** Show the Sessions screen. */
  sessions: boolean;
  /** Look for a new version on GitHub once a day, and download it. */
  checkUpdates: boolean;
  /**
   * The agents the app shows. Null until setup or Preferences sets it; until
   * then every agent that's installed or has its folder is shown.
   */
  agents: AgentId[] | null;
};

/** The coding agents the app knows. */
export type AgentId = "claude" | "codex" | "opencode";

/** An agent on this Mac, and whether the app shows it. */
export type AgentStatus = {
  id: AgentId;
  name: string;
  /** The app shows this agent's files, sessions and usage. */
  on: boolean;
  /** Its command was found. */
  found: boolean;
  /** Its folder exists (~/.claude, ~/.codex), so it has run here even if its command isn't found. */
  used: boolean;
  version: string | null;
  path: string | null;
  /** Its folder, as ~/… */
  folder: string;
};

/** The desktop app's updater, as the About page shows it. */
export type UpdateState = {
  status: "unavailable" | "idle" | "checking" | "current" | "downloading" | "ready" | "error";
  /** The new version, when there is one. */
  version?: string;
  /** Why updates can't run, or what went wrong. */
  message?: string;
  checkedAt?: string;
};

export type AppState = {
  version: string;
  /** The build number (CFBundleVersion). */
  build: string | null;
  prefs: Preferences;
  docs: DocsInfo;
  /** Every agent the app knows, in its order, with whether it's shown. */
  agents: AgentStatus[];
  home: string;
  /** Where the app keeps its preferences and history (~/.agentcp), as a full path. */
  appDir: string;
  watching: number;
};

export type SessionSource = "claude_code" | "codex" | "opencode";

export type SessionSummary = {
  id: string;
  source: SessionSource;
  title: string;
  project: string | null;
  projectDisplay: string | null;
  startedAt: string | null;
  endedAt: string | null;
  model: string | null;
  /** Where it ran: "claude-desktop", "cli", "vscode"… */
  entry: string | null;
  prompts: number;
  preview: string;
  /** The matching text, when the list is a search. */
  match: string | null;
};

export type StepKind = "read" | "edit" | "run" | "search" | "web" | "agent" | "skill" | "plan" | "other";

export type SessionStep = { kind: StepKind; tool: string; target: string | null; at: string | null };

export type SessionEvent = { type: "say"; text: string; at: string | null } | ({ type: "step" } & SessionStep);

/** One prompt you typed, what the agent did about it, and what it answered. */
export type SessionTurn = {
  prompt: { text: string; at: string | null } | null;
  /** The work in order: short things the agent said along the way, and each tool it used. */
  events: SessionEvent[];
  /** The agent's last message in the turn. */
  answer: { text: string; at: string | null } | null;
  startedAt: string | null;
  endedAt: string | null;
  steps: number;
};

export type SessionView = SessionSummary & {
  branch: string | null;
  turns: SessionTurn[];
  files: { path: string; display: string; edits: number }[];
  commands: { command: string; count: number }[];
  skills: string[];
  subagents: { type: string; description: string }[];
  resume: string | null;
  steps: number;
};

export type SessionsView = {
  sessions: SessionSummary[];
  total: number;
  /** Why some agent's sessions can't be shown (OpenCode's database in a layout the app doesn't know), in a sentence. */
  problem?: string | null;
};

/** A point in a session where an agent can run a hook. */
/** One hook event, from the agent's own docs: when it fires, what its matcher filters, and whether a hook can stop what's happening. */
export type HookEvent = {
  name: string;
  /** When it fires, in one sentence. */
  summary: string;
  /** A sentence or two more from the event's section. */
  detail: string[];
  /** What the matcher is tested against, with example values; null when the event ignores matchers. */
  matcher: { on: string; examples: string[]; note: string } | null;
  /** Whether a hook can stop it (exit code 2), and what that does. */
  block: { can: boolean; what: string } | null;
  doc: DocRef;
};

/** A file hooks live in: a settings.json, a hooks.json, or a config.toml (shown, not written). */
export type HookFile = { path: string; display: string; label: string; scope: "managed" | "local" | "project" | "user" | "plugin"; exists: boolean; writable: boolean; error: string | null };

/** One configured hook: what it runs, on which event, for which tools. */
export type HookEntry = { id: string; event: string; matcher: string | null; type: string; run: string; timeout: number | null; file: string; fileDisplay: string; fileLabel: string; group: number; index: number };

export type HooksView = {
  agent: "claude" | "codex";
  events: HookEvent[];
  files: HookFile[];
  entries: HookEntry[];
  /** Codex only: features.hooks in config.toml, when it's set. */
  enabled: boolean | null;
  /** Where the agent reads hooks from, as its docs list them. */
  sources: string;
  doc: DocRef;
  /** Citations for `sources` and the rules this view applies. */
  notes: { text: string; doc: DocRef }[];
};

/** Tokens for one day, model or folder. Fresh input, output, and prompt-cache reads and writes are kept apart. */
export type UsageRow = { label: string; input: number; output: number; cacheRead: number; cacheWrite: number; sessions: number };

export type UsageView = {
  /** Why some agent's usage can't be counted, in a sentence. */
  problem?: string | null;
  days: number;
  totals: UsageRow;
  prompts: number;
  byDay: UsageRow[];
  /** Every day of the last 53 weeks, oldest first, for the activity grid. */
  year: { day: string; tokens: number }[];
  byModel: UsageRow[];
  byProject: (UsageRow & { project: string })[];
};

export type SetupView = {
  /** Every agent, with `on` as setup suggests it: the ones installed or used here, or all of them when none is. */
  agents: AgentStatus[];
  home: string;
  /** Folders Claude Code has run in, from ~/.claude/projects. */
  seen: number;
  docs: DocsInfo;
};

/** A folder the project search found code in, offered as a place to keep looking. */
export type ScanFolder = {
  path: string;
  display: string;
  /** Git repositories and folders with Claude Code files, found inside it. */
  projects: number;
  /** How many of those already have a CLAUDE.md, AGENTS.md or CLAUDE.local.md. */
  withInstructions: number;
  /** A few of the names, for the row. */
  names: string[];
};

/**
 * The project search setup runs. It looks through the home folder, never the
 * whole disk; the folders macOS asks about first are searched one at a time,
 * when the person asks.
 */
export type ScanState = {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  /** Folders looked in so far. */
  checked: number;
  /** The folder being looked in now, for the progress line. */
  current: string | null;
  folders: ScanFolder[];
  /** Folders macOS asks about before an app reads them, and whether each was searched. */
  askFirst: { name: string; path: string; display: string; state: "not-asked" | "searched" | "refused" | "missing" }[];
  /** True when the search stopped at its limit before looking everywhere. */
  capped: boolean;
  /** Why the last search failed, in a sentence. */
  error: string | null;
};

/** One "Did you know?" card: a fact from Claude Code's docs, shown on the screens it's about. */
export type Tip = {
  id: string;
  screens: string[];
  title: string;
  body: string;
  doc: DocRef;
};

export type SearchHit =
  | { kind: "file"; label: string; detail: string; path: string; route: string; agent?: AgentId }
  | { kind: "setting"; label: string; detail: string; key: string; route: string }
  | { kind: "doc"; label: string; detail: string; slug: string; anchor: string | null }
  | { kind: "session"; label: string; detail: string; id: string }
  | { kind: "project"; label: string; detail: string; path: string };

export type ChangeEvent = { paths: string[] };

/** A Claude Code plugin: where it came from, whether it loads, and what it adds. */
export type PluginInfo = {
  /** `<name>@<origin>`, the id settings files use. */
  id: string;
  name: string;
  origin: "marketplace" | "synced" | "skills-dir";
  marketplace: string | null;
  path: string;
  display: string;
  version: string | null;
  description: string;
  author: string | null;
  on: boolean;
  /** Which file decided `on`, in a sentence. */
  why: string;
  /** Who a marketplace install is for. */
  installedFor: "user" | "project" | "local" | null;
  updated: string | null;
  /** Skills, subagents and styles with the file each one opens; the rest by name. */
  adds: { skills: { name: string; path: string }[]; agents: { name: string; path: string }[]; commands: string[]; styles: { name: string; path: string }[]; hooks: number; mcp: string[]; lsp: string[] };
};

export type PluginsView = { project: ProjectRef | null; plugins: PluginInfo[]; marketplaces: string[]; root: string; doc: DocRef };

/** An MCP server one of the agents connects to, with the secrets left out. */
export type McpServer = {
  /** The name as written; a plugin's server is `plugin:<plugin>:<name>`. */
  name: string;
  scope: "local" | "project" | "user" | "plugin" | "managed";
  /** Where it's set, in words ("This project (everyone)", "figma plugin"). */
  where: string;
  /** The file that defines it, for display. */
  file: string;
  transport: "stdio" | "http" | "sse" | "ws";
  /** The command and its arguments, or the address without its query, with anything that looks like a secret hidden. */
  endpoint: string;
  /** Names of the environment variables and headers it sets; never their values. */
  secrets: string[];
  status: "on" | "off" | "pending" | "replaced" | "skipped" | "empty";
  /** What the status means, in a sentence. */
  note: string;
  findings: Finding[];
};

export type McpView = {
  project: ProjectRef | null;
  agent: AgentId;
  servers: McpServer[];
  /** The files the agent reads servers from here, in its order; `broken` says why one couldn't be read. */
  files: { label: string; display: string; exists: boolean; broken: string | null }[];
  doc: DocRef;
};

/** A Claude Code command the app runs for you: plugins, and its own MCP servers. */
export type AgentCommand =
  | { kind: "plugin"; action: "install" | "uninstall" | "enable" | "disable" | "update"; id: string; scope?: "user" | "project" | "local" }
  | { kind: "mcp-add"; name: string; scope: "user" | "project" | "local"; transport: "http" | "stdio"; url?: string; headers?: [string, string][]; command?: string; args?: string[]; env?: [string, string][] }
  | { kind: "mcp-remove"; name: string; scope: "user" | "project" | "local" };

export type AgentCommandResult = {
  /** The command as shown to the person, with secret values hidden. */
  command: string;
  /** What History keeps, in a sentence. */
  history: string;
  undo: string | null;
  /** Null until it has run. */
  ok: boolean | null;
  output: string | null;
};

/** A plugin a marketplace you've added offers. */
export type AvailablePlugin = { id: string; name: string; marketplace: string; description: string; version: string | null; category: string | null; installed: boolean; runsCommand: boolean };

// ---------------------------------------------------------------- OpenCode

/** Where OpenCode's sessions and usage are read from, and why they aren't shown when they aren't. */
export type OpenCodeStore = {
  /** Its session database (opencode.db), as a full path; null when OPENCODE_DB keeps sessions in memory. */
  path: string | null;
  display: string | null;
  exists: boolean;
  /** Why OpenCode's sessions and usage aren't shown, in a sentence; null when they are, or there's no database. */
  problem: string | null;
};
