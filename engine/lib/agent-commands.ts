import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import type { AgentCommand, AgentCommandResult, AvailablePlugin, ProjectRef } from "../../shared/types.ts";
import { claudeBinary } from "./claude.ts";
import { CLAUDE_DIR, HOME } from "./paths.ts";
import { scopePaths } from "./settings.ts";
import { WriteError, withHistory } from "./write.ts";

/**
 * Managing plugins and Claude Code's own MCP servers by running Claude Code's
 * commands, the ones its plugin and MCP references document: `claude plugin
 * install | uninstall | enable | disable | update` and `claude mcp add | remove`.
 * Claude Code owns installed_plugins.json, its plugin cache and ~/.claude.json,
 * so the app never writes them itself.
 *
 * Each command is built here from a fixed shape, with every name and address
 * checked, and run without a shell. The person sees it first, with the values
 * of environment variables and headers hidden. Settings files and a project's
 * .mcp.json that a command changes are recorded in History; ~/.claude.json,
 * which holds the sign-in session, never is.
 */

const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const PLUGIN_ID = /^[A-Za-z0-9._-]{1,100}@[A-Za-z0-9._-]{1,100}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const HEADER = /^[A-Za-z0-9-]{1,100}$/;
const SCOPES = ["user", "project", "local"] as const;

const bad = (message: string): never => {
  throw new WriteError(message, 400, "refused");
};

function checkScope(s: unknown): (typeof SCOPES)[number] {
  return (SCOPES as readonly unknown[]).includes(s) ? (s as (typeof SCOPES)[number]) : bad("Pick where it goes: you, this project for everyone, or this project just for you.");
}

function checkUrl(u: unknown): string {
  try {
    const x = new URL(String(u));
    if (x.protocol === "https:" || x.protocol === "http:") return x.toString();
  } catch {
    /* fall through */
  }
  return bad("The address has to start with https:// or http://.");
}

const plain = (s: unknown, what: string): string => (typeof s === "string" && s.length > 0 && s.length < 4000 && !/[\0\n\r]/.test(s) ? s : bad(`${what} can't be empty or span lines.`));

/** The arguments to run, the same arguments as shown (secrets hidden), and how to undo it. */
type Built = { args: string[]; shown: string[]; undo: string | null; touches: string[]; needsProject: boolean };

const quote = (a: string) => (/^[A-Za-z0-9._@:/=+,•-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

export function build(cmd: AgentCommand, project: ProjectRef | null): Built {
  const settings = scopePaths(project?.path ?? null).filter((s) => s.scope !== "managed").map((s) => s.path);
  if (cmd.kind === "plugin") {
    if (!PLUGIN_ID.test(cmd.id)) bad("That isn't a plugin id (name@marketplace).");
    const scope = cmd.scope ? checkScope(cmd.scope) : null;
    const args = ["plugin", cmd.action, cmd.id, ...(scope ? ["--scope", scope] : [])];
    const undo =
      cmd.action === "enable" ? `claude plugin disable ${cmd.id}${scope ? ` --scope ${scope}` : ""}`
      : cmd.action === "disable" ? `claude plugin enable ${cmd.id}${scope ? ` --scope ${scope}` : ""}`
      : cmd.action === "install" ? `claude plugin uninstall ${cmd.id}${scope ? ` --scope ${scope}` : ""}`
      : cmd.action === "uninstall" ? `claude plugin install ${cmd.id}${scope ? ` --scope ${scope}` : ""}`
      : null;
    return { args, shown: args, undo, touches: settings, needsProject: scope === "project" || scope === "local" };
  }
  if (cmd.kind === "mcp-remove") {
    if (!NAME.test(cmd.name)) bad("That isn't a server name.");
    const scope = checkScope(cmd.scope);
    const args = ["mcp", "remove", cmd.name, "--scope", scope];
    return { args, shown: args, undo: null, touches: scope === "project" && project ? [path.join(project.path, ".mcp.json")] : [], needsProject: scope !== "user" };
  }
  // mcp-add. --header and --env take several values each, so they come first and a one-value
  // flag (--scope, --transport) closes them; otherwise they swallow the name and the address.
  if (!NAME.test(cmd.name)) bad("Give the server a name of letters, numbers, dots, dashes or underscores.");
  const scope = checkScope(cmd.scope);
  const args = ["mcp", "add"];
  const shown = ["mcp", "add"];
  if (cmd.transport === "http") {
    for (const [k, v] of cmd.headers ?? []) {
      if (!HEADER.test(k)) bad(`${k} isn't a header name.`);
      args.push("--header", `${k}: ${plain(v, `The ${k} header`)}`);
      shown.push("--header", `${k}: ••••`);
    }
  } else {
    for (const [k, v] of cmd.env ?? []) {
      if (!ENV_KEY.test(k)) bad(`${k} isn't an environment variable name.`);
      args.push("--env", `${k}=${plain(v, k)}`);
      shown.push("--env", `${k}=••••`);
    }
  }
  for (const a of [args, shown]) a.push("--scope", scope, "--transport", cmd.transport);
  if (cmd.transport === "http") {
    const url = checkUrl(cmd.url);
    args.push(cmd.name, url);
    shown.push(cmd.name, url.split("?")[0]);
  } else {
    const command = plain(cmd.command, "The command");
    const rest = (cmd.args ?? []).map((a) => plain(a, "An argument"));
    args.push(cmd.name, "--", command, ...rest);
    shown.push(cmd.name, "--", command, ...rest);
  }
  return {
    args,
    shown,
    undo: `claude mcp remove ${cmd.name} --scope ${scope}`,
    touches: scope === "project" && project ? [path.join(project.path, ".mcp.json")] : [],
    needsProject: scope !== "user",
  };
}

/** What running the command will do, in words, before it runs. */
export function describe(cmd: AgentCommand, project: ProjectRef | null): AgentCommandResult {
  const b = build(cmd, project);
  if (b.needsProject && !project) bad("Open a project first.");
  const history = b.touches.length
    ? "History keeps the files it changes as they were."
    : cmd.kind === "mcp-add" || cmd.kind === "mcp-remove"
      ? "It changes ~/.claude.json, which holds your sign-in, so History doesn't keep a copy."
      : "";
  return { command: `claude ${b.shown.map(quote).join(" ")}`, history, undo: b.undo ? `To undo it, run ${b.undo}.` : null, ok: null, output: null };
}

function run(bin: string, args: string[], cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    // No terminal: a plugin that would ask to run its own install command is refused, and says so.
    const child = execFile(bin, args, { cwd, timeout: 180_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, out: `${stdout}\n${stderr}`.trim() });
    });
    child.stdin?.end();
  });
}

/** What a command said, for a person: its JSON result's message (plugin commands), or its summary line. */
function said(out: string): { text: string; json: { outcome?: string; message?: string; alreadyInGoalState?: boolean } | null } {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const l of [...lines].reverse()) {
    if (!l.startsWith("{")) continue;
    try {
      const j = JSON.parse(l) as { outcome?: string; message?: string; alreadyInGoalState?: boolean };
      if (j.message || j.outcome) return { text: String(j.message ?? j.outcome), json: j };
    } catch {
      /* not JSON */
    }
  }
  // Colour codes, in case a command ignores NO_COLOR, and the JSON it echoes back.
  const clean = lines.map((l) => l.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "")).filter((l) => !/^[{}"\][]/.test(l));
  const summary = clean.find((l) => /^(Added|Removed|Successfully|No MCP|Failed|error|✘)/i.test(l)) ?? clean[clean.length - 1] ?? "";
  return { text: summary.replace(/ File modified: .*$/, "").replace(/^✘\s*/, ""), json: null };
}

export async function runCommand(cmd: AgentCommand, project: ProjectRef | null): Promise<AgentCommandResult> {
  const desc = describe(cmd, project);
  const bin = claudeBinary();
  if (!bin) bad("Claude Code isn't installed, so its commands can't run.");
  const b = build(cmd, project);
  const args = cmd.kind === "plugin" ? [...b.args, "--json"] : b.args;
  const { code, out } = await withHistory(b.touches, () => run(bin!, args, project?.path ?? HOME));
  const r = said(out);
  // Already in the state asked for counts as done, as the plugin reference suggests for scripts.
  const ok = r.json ? r.json.outcome !== "failed" || r.json.alreadyInGoalState === true : code === 0;
  return { ...desc, ok, output: r.text || (ok ? "Done." : "It didn't work, and Claude Code didn't say why.") };
}

/** Plugins the marketplaces you've added offer, from each one's marketplace.json, with whether each is installed. */
export async function availablePlugins(): Promise<AvailablePlugin[]> {
  const root = process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR ?? path.join(CLAUDE_DIR, "plugins");
  const read = async <T>(p: string): Promise<T | null> => {
    try {
      return JSON.parse(await fs.readFile(p, "utf8")) as T | null;
    } catch {
      return null; // missing, or not JSON: Claude Code rewrites these files itself
    }
  };
  const known = (await read<Record<string, { installLocation?: string }>>(path.join(root, "known_marketplaces.json"))) ?? {};
  const installedFile = await read<{ plugins?: Record<string, unknown> }>(path.join(root, "installed_plugins.json"));
  const installed = new Set(Object.keys(installedFile?.plugins && typeof installedFile.plugins === "object" ? installedFile.plugins : {}));
  const out: AvailablePlugin[] = [];
  for (const [marketplace, m] of Object.entries(known && typeof known === "object" ? known : {})) {
    if (!m || typeof m.installLocation !== "string") continue;
    const manifest = await read<{ plugins?: { name?: string; description?: string; version?: string; category?: string; source?: unknown }[] }>(path.join(m.installLocation, ".claude-plugin", "marketplace.json"));
    for (const p of Array.isArray(manifest?.plugins) ? manifest.plugins : []) {
      if (!p || typeof p.name !== "string" || !NAME.test(p.name)) continue;
      const id = `${p.name}@${marketplace}`;
      const source = p.source as { source?: string } | string | undefined;
      out.push({
        id,
        name: p.name,
        marketplace,
        description: typeof p.description === "string" ? p.description : "",
        version: typeof p.version === "string" ? p.version : null,
        category: typeof p.category === "string" ? p.category : null,
        installed: installed.has(id),
        runsCommand: typeof source === "object" && source?.source === "command",
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
