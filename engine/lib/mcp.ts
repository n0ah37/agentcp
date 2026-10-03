import fs from "node:fs/promises";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

import type { Finding, McpServer, McpView, ProjectRef } from "../../shared/types.ts";
import { finding, type Cite } from "./checks.ts";
import { trustFor } from "./codex.ts";
import { docRef, docSays, section } from "./docs.ts";
import { exists, readText } from "./fsx.ts";
import { CLAUDE_DIR, CODEX_DIR, HOME, MANAGED_DIR, tilde } from "./paths.ts";
import { listPlugins } from "./plugins.ts";
import { readScopes } from "./settings.ts";
import { removeTomlTable, setTomlKeys } from "./toml-edit.ts";

/**
 * The MCP servers each agent connects to, read from the files its docs name.
 * Claude Code: this project's entry in ~/.claude.json (local), the project's
 * .mcp.json (project), the top of ~/.claude.json (user), enabled plugins, and
 * your organization's managed-mcp.json or managedMcpServers. Codex: the
 * [mcp_servers] tables in your config.toml and a trusted project's.
 *
 * ~/.claude.json also holds the sign-in session, so the engine reads only the
 * MCP keys out of it, and no value of an environment variable, header or
 * token ever leaves this module: those are listed by name.
 */

const C = {
  precedence: { slug: "mcp", anchor: "scope-hierarchy-and-precedence", says: "using the definition from the highest-precedence source" },
  reserved: { slug: "mcp", anchor: "configuration-warnings", says: "Claude Code skips it at load time" },
  whitespace: { slug: "mcp", anchor: "configuration-warnings", says: "Claude Code doesn't trim the whitespace and uses the values exactly as written" },
  sameName: { slug: "mcp", anchor: "configuration-warnings", says: "if you define the same server name in more than one" },
  approval: { slug: "mcp", anchor: "project-scope", says: "Claude Code prompts for approval in interactive sessions before using project-scoped servers" },
  rejected: { slug: "mcp", anchor: "project-server-approvals-and-workspace-trust", says: "A `disabledMcpjsonServers` entry in any settings file still rejects the server." },
  toggled: { slug: "mcp", anchor: "disable-a-server-without-removing-it", says: "Claude Code records your choice per project in `~/.claude.json`" },
  empty: { slug: "mcp", anchor: "server-status-detail", says: "A remote server whose configuration has an empty `url` shows as `not configured`" },
  exclusive: { slug: "managed-mcp", anchor: "exclusive-control-with-managed-mcp-json", says: "When you deploy a `managed-mcp.json` file, Claude Code loads only these MCP servers" },
  codexTable: { slug: "codex/extend/mcp", anchor: "configure-with-configtoml", says: "Configure each MCP server with a `[mcp_servers.<server-name>]` table in the configuration file." },
  codexOff: { slug: "codex/extend/mcp", anchor: "other-configuration-options", says: "Set `false` to disable a server without deleting it." },
} satisfies Record<string, Cite>;

export const MCP_CITES: Cite[] = Object.values(C);

/** Claude Code keeps ~/.claude.json in your home folder, or in CLAUDE_CONFIG_DIR when that's set. */
export const claudeJson = () => (process.env.CLAUDE_CONFIG_DIR ? path.join(CLAUDE_DIR, ".claude.json") : path.join(HOME, ".claude.json"));

type Raw = Record<string, unknown> & { type?: string; command?: string; args?: unknown; url?: string; env?: unknown; headers?: unknown };
type Entry = { name: string; scope: McpServer["scope"]; where: string; file: string; raw: Raw };

/** Files that are there but couldn't be parsed, so the agent reads no servers from them (path → why). */
const broken = new Map<string, string>();

async function json(p: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await fs.readFile(p, "utf8");
  } catch {
    broken.delete(p);
    return null;
  }
  try {
    const v = JSON.parse(text) as unknown;
    broken.delete(p);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    if (text.trim()) broken.set(p, "isn't valid JSON");
    return null;
  }
}

const servers = (o: unknown): Record<string, Raw> => {
  const m = (o as { mcpServers?: unknown })?.mcpServers;
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, Raw>) : {};
};

/** The built-in names Claude Code reserves, as its docs list them. */
function reservedNames(): string[] {
  const text = section("mcp", "configuration-warnings") ?? "";
  const line = text.split("\n").find((l) => l.includes("**Reserved names**")) ?? "";
  const upTo = line.split("If your configuration")[0];
  return [...upTo.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

const SECRET_FLAG = /(key|token|secret|password|passwd|auth|bearer|credential)/i;
const LOOKS_SECRET = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9_\-+/=.]{24,}$/;

/** A command line with values that look like secrets hidden: after a --token-like flag, in KEY=value, or a long random string. */
export function maskArgs(args: string[]): string[] {
  return args.map((a, i) => {
    const prev = args[i - 1] ?? "";
    if (/^--?[\w-]+$/.test(prev) && SECRET_FLAG.test(prev)) return "••••";
    const kv = /^(--?[\w-]+|[A-Z_][A-Z0-9_]*)=(.+)$/.exec(a);
    if (kv && SECRET_FLAG.test(kv[1])) return `${kv[1]}=••••`;
    if (LOOKS_SECRET.test(a) && !a.includes("/") && !a.startsWith("@")) return "••••";
    return a;
  });
}

/** An address without its query, fragment or sign-in part, which can carry a token. */
export function cleanUrl(u: string): string {
  try {
    const x = new URL(u.trim());
    return `${x.protocol}//${x.host}${x.pathname === "/" ? "" : x.pathname}`;
  } catch {
    return u.split(/[?#]/)[0].trim();
  }
}

/** A command line as the app shows it: paths in your home folder start with ~, and secret-looking values are hidden. */
const commandLine = (command: string, args: string[]) => [command, ...maskArgs(args)].filter(Boolean).map((a) => (a.startsWith(HOME + "/") ? tilde(a) : a)).join(" ");

const keysOf = (o: unknown): string[] => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o as object) : []);

function describe(raw: Raw): Pick<McpServer, "transport" | "endpoint" | "secrets"> {
  const t = String(raw.type ?? (raw.url !== undefined ? "http" : "stdio")).toLowerCase();
  const transport = (["stdio", "http", "sse", "ws"].includes(t) ? t : t === "streamable-http" ? "http" : "stdio") as McpServer["transport"];
  const args = Array.isArray(raw.args) ? raw.args.map(String) : [];
  const endpoint = transport === "stdio" ? commandLine(String(raw.command ?? ""), args) : cleanUrl(String(raw.url ?? ""));
  return { transport, endpoint, secrets: [...keysOf(raw.env), ...keysOf(raw.headers).map((h) => `${h} header`)] };
}

/** Fields with a space or line break at either end, which Claude Code uses as written. */
function whitespace(raw: Raw): string[] {
  const bad = (v: unknown) => typeof v === "string" && v !== v.trim();
  const out: string[] = [];
  if (bad(raw.command)) out.push("command");
  if (bad(raw.url)) out.push("url");
  (Array.isArray(raw.args) ? raw.args : []).forEach((a, i) => bad(a) && out.push(`args[${i}]`));
  for (const k of ["env", "headers"] as const) {
    for (const [name, v] of Object.entries((raw[k] as Record<string, unknown>) ?? {})) if (bad(name) || bad(v)) out.push(`${k}.${name.trim()}`);
  }
  return out;
}

const endpointKey = (raw: Raw) => {
  const d = describe(raw);
  return d.transport === "stdio" ? `stdio:${d.endpoint}` : `url:${d.endpoint.toLowerCase().replace(/:443(?=\/|$)/, "").replace(/\/$/, "")}`;
};

const WHERE = { local: "This project (just you)", project: "This project (everyone)", user: "User", managed: "Organization" } as const;

export async function claudeMcp(project: ProjectRef | null): Promise<McpView> {
  const P = project?.path ?? null;
  const real = P ? await fs.realpath(P).catch(() => P) : null;
  const cj = (await json(claudeJson())) ?? {};
  const projects = (cj.projects ?? {}) as Record<string, Record<string, unknown>>;
  const mine = (P && (projects[P] ?? (real ? projects[real] : undefined))) || {};
  const scopes = await readScopes(P);
  const managedFile = path.join(MANAGED_DIR, "managed-mcp.json");
  const managed = await json(managedFile);
  const mcpJson = P ? path.join(P, ".mcp.json") : null;

  const entries: Entry[] = [];
  const add = (scope: Entry["scope"], file: string, where: string, map: Record<string, Raw>) => {
    for (const [name, raw] of Object.entries(map)) entries.push({ name, scope, where, file, raw: raw ?? {} });
  };
  const managedSettings = scopes.find((s) => s.scope === "managed")?.data;
  add("managed", tilde(scopes.find((s) => s.scope === "managed")?.path ?? ""), WHERE.managed, servers({ mcpServers: managedSettings?.managedMcpServers }));
  if (managed) add("managed", tilde(managedFile), WHERE.managed, servers(managed));
  if (P) add("local", "~/.claude.json", WHERE.local, servers(mine));
  if (mcpJson) add("project", tilde(mcpJson), WHERE.project, servers(await json(mcpJson)));
  add("user", "~/.claude.json", WHERE.user, servers(cj));
  for (const pl of (await listPlugins(project)).filter((p) => p.on)) {
    for (const file of [path.join(pl.path, ".mcp.json"), path.join(pl.path, ".claude-plugin", "plugin.json")]) {
      // Two plugins can share a name (one from a marketplace, one synced from claude.ai); say which.
      const where = pl.origin === "synced" ? `${pl.name} plugin (claude.ai)` : `${pl.name} plugin`;
      for (const [name, raw] of Object.entries(servers(await json(file)))) entries.push({ name: `plugin:${pl.name}:${name}`, scope: "plugin", where, file: tilde(file), raw: raw ?? {} });
    }
  }

  // Approvals for the project's .mcp.json; a project file's own approvals count only once the folder is trusted.
  const trusted = mine.hasTrustDialogAccepted === true;
  const approvalScopes = scopes.filter((s) => s.data && (s.scope !== "project" || trusted));
  const listIn = (key: string) => approvalScopes.flatMap((s) => (Array.isArray(s.data?.[key]) ? (s.data![key] as unknown[]).map((n) => ({ name: String(n), file: tilde(s.path) })) : []));
  const approved = listIn("enabledMcpjsonServers");
  const rejected = scopes.flatMap((s) => (Array.isArray(s.data?.disabledMcpjsonServers) ? (s.data!.disabledMcpjsonServers as unknown[]).map((n) => ({ name: String(n), file: tilde(s.path) })) : []));
  const allFrom = approvalScopes.find((s) => s.data?.enableAllProjectMcpServers === true);
  const toggledOff = new Set(Array.isArray(mine.disabledMcpServers) ? (mine.disabledMcpServers as unknown[]).map(String) : []);
  const reserved = new Set(reservedNames());

  const used = new Map<string, Entry>();
  const usedEndpoints = new Map<string, Entry>();
  const out: McpServer[] = [];
  for (const e of entries) {
    const d = describe(e.raw);
    const findings: Finding[] = [];
    const ws = whitespace(e.raw);
    if (ws.length) findings.push(finding("mcp:whitespace", "warning", `${ws.join(", ")} ${ws.length === 1 ? "has" : "have"} a space or line break at the start or end.`, "Claude Code uses the value exactly as written, so a pasted token with a trailing line break doesn't work. Remove it in the file.", C.whitespace));
    const base = { name: e.name, scope: e.scope, where: e.where, file: e.file, ...d, findings };
    const short = e.name.replace(/^plugin:[^:]+:/, "");
    let status: McpServer["status"] = "on";
    let note = "Claude Code connects to it.";
    const earlier = e.scope === "plugin" ? usedEndpoints.get(endpointKey(e.raw)) : used.get(e.name);
    if (managed && !(e.scope === "managed")) {
      status = "off";
      note = "Your organization's managed-mcp.json allows only its own servers.";
    } else if (reserved.has(short)) {
      status = "skipped";
      note = `${short} is a name Claude Code keeps for a built-in server, so it skips this one. Rename it.`;
      findings.push(finding("mcp:reserved", "problem", `Claude Code skips a server named ${short}.`, "The name belongs to one of its built-in servers. Rename the server.", C.reserved));
    } else if (earlier) {
      status = "replaced";
      note = `Not used: the server in ${earlier.where} ${e.scope === "plugin" ? "points at the same place" : "has the same name"}, and it comes first.`;
      if (e.scope !== "plugin" && endpointKey(earlier.raw) !== endpointKey(e.raw)) {
        findings.push(finding("mcp:same-name", "note", `${e.name} is set in more than one place, with different addresses.`, `Claude Code uses the one in ${earlier.where}. Sign-ins are kept per address, so remove the one you don't want.`, C.sameName));
      }
    } else if (e.scope === "project" && rejected.some((r) => r.name === e.name)) {
      status = "off";
      note = `Turned off in ${rejected.find((r) => r.name === e.name)!.file}.`;
    } else if (toggledOff.has(e.name) || toggledOff.has(short)) {
      status = "off";
      note = "Turned off for this project in Claude Code's /mcp.";
    } else if (e.scope === "project" && !approved.some((a) => a.name === e.name) && !allFrom) {
      status = "pending";
      note = "Claude Code asks you to approve it the first time it starts here.";
    } else if (e.scope === "project") {
      note = `Approved in ${approved.find((a) => a.name === e.name)?.file ?? tilde(allFrom!.path)}.`;
    } else if (d.transport !== "stdio" && !String(e.raw.url ?? "").trim()) {
      status = "empty";
      note = "It has no address yet, so Claude Code doesn't connect to it.";
    }
    if (status === "on" || status === "pending" || status === "empty") {
      used.set(e.name, e);
      usedEndpoints.set(endpointKey(e.raw), e);
    }
    out.push({ ...base, status, note });
  }

  const files = [
    ...(managed ? [{ label: WHERE.managed, display: tilde(managedFile), exists: true, broken: null }] : []),
    ...(P ? [{ label: WHERE.local, display: `~/.claude.json, this project's entry`, exists: Object.keys(servers(mine)).length > 0, broken: null }] : []),
    ...(mcpJson ? [{ label: WHERE.project, display: tilde(mcpJson), exists: await exists(mcpJson), broken: broken.get(mcpJson) ?? null }] : []),
    { label: WHERE.user, display: "~/.claude.json", exists: Object.keys(servers(cj)).length > 0, broken: broken.get(claudeJson()) ?? null },
  ];
  return { project, agent: "claude", servers: out, files, doc: docRef("mcp", "mcp-installation-scopes") };
}

export async function codexMcp(project: ProjectRef | null): Promise<McpView> {
  const read = async (p: string) => {
    let text: string;
    try {
      text = await fs.readFile(p, "utf8");
    } catch {
      broken.delete(p);
      return null;
    }
    try {
      const data = parseToml(text) as Record<string, unknown>;
      broken.delete(p);
      return data;
    } catch {
      if (text.trim()) broken.set(p, "isn't valid TOML");
      return null;
    }
  };
  const userFile = path.join(CODEX_DIR, "config.toml");
  const layers: { label: string; file: string; data: Record<string, unknown> | null; trusted: boolean }[] = [{ label: "User", file: userFile, data: await read(userFile), trusted: true }];
  if (project) {
    const file = path.join(project.path, ".codex", "config.toml");
    const trust = await trustFor(project.path);
    layers.push({ label: "This project", file, data: await read(file), trusted: trust.level === "trusted" });
  }
  const out: McpServer[] = [];
  const names = new Map<string, string>();
  for (const l of layers) {
    for (const [name, raw] of Object.entries((l.data?.mcp_servers ?? {}) as Record<string, Raw>)) {
      const r = raw ?? {};
      const transport = r.url !== undefined ? "http" : "stdio";
      const args = Array.isArray(r.args) ? r.args.map(String) : [];
      const envVars = Array.isArray(r.env_vars) ? r.env_vars.map((v) => (typeof v === "string" ? v : String((v as { name?: string })?.name ?? ""))).filter(Boolean) : [];
      const secrets = [
        ...keysOf(r.env),
        ...envVars,
        ...(typeof r.bearer_token_env_var === "string" ? [r.bearer_token_env_var] : []),
        ...keysOf(r.http_headers).map((h) => `${h} header`),
        ...keysOf(r.env_http_headers).map((h) => `${h} header`),
      ];
      let status: McpServer["status"] = "on";
      let note = "Codex connects to it.";
      if (!l.trusted) {
        status = "off";
        note = "This project isn't trusted in Codex, so Codex doesn't read its config.";
      } else if (r.enabled === false) {
        status = "off";
        note = "Turned off with enabled = false.";
      } else if (names.has(name)) {
        note = `Also set in ${names.get(name)}; this project's values win where both set one.`;
      }
      if (l.trusted) names.set(name, l.label === "User" ? "your Codex config" : "this project");
      out.push({
        name,
        scope: l.label === "User" ? "user" : "project",
        where: l.label,
        file: tilde(l.file),
        transport,
        endpoint: transport === "stdio" ? commandLine(String(r.command ?? ""), args) : cleanUrl(String(r.url ?? "")),
        secrets,
        status,
        note,
        findings: [],
      });
    }
  }
  return {
    project,
    agent: "codex",
    servers: out,
    files: layers.map((l) => ({ label: l.label, display: tilde(l.file), exists: !!l.data || broken.has(l.file), broken: broken.get(l.file) ?? null })),
    doc: docRef(C.codexTable.slug, C.codexTable.anchor),
  };
}

/** True when every sentence the MCP screens rely on is still in the docs (the tests check this). */
export const mcpDocsCurrent = () => MCP_CITES.every((c) => docSays(c.slug, c.says));

// ------------------------------------------------------------- changes

export type McpChange =
  | { agent: "claude"; kind: "approve" | "reject"; name: string }
  | { agent: "codex"; kind: "enable" | "disable" | "remove"; name: string; scope: "user" | "project" }
  | { agent: "codex"; kind: "add"; name: string; scope: "user" | "project"; transport: "http" | "stdio"; url?: string; tokenVar?: string; command?: string; args?: string[]; envVars?: string[] };

const CODEX_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const VAR = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

/**
 * A change to a file the app writes itself, planned for review like any save:
 * approving or turning off a project's .mcp.json server in this project's local
 * settings (the docs: an untracked .claude/settings.local.json approves, and a
 * disabledMcpjsonServers entry anywhere rejects), or a [mcp_servers] table in
 * Codex's config.toml. Codex servers take secrets from environment variables
 * by name, so no secret is written into the file.
 */
export async function planMcp(project: ProjectRef | null, change: McpChange): Promise<{ path: string; content: string; baseHash: string | null }> {
  if (change.agent === "claude") {
    if (!project) throw new Error("Open the project first.");
    const file = path.join(project.path, ".claude", "settings.local.json");
    const t = await readText(file);
    let data: Record<string, unknown> = {};
    try {
      data = t?.text.trim() ? (JSON.parse(t.text) as Record<string, unknown>) : {};
    } catch {
      throw new Error(`${tilde(file)} isn't valid JSON, so it can't be edited safely.`);
    }
    const list = (k: string) => (Array.isArray(data[k]) ? (data[k] as unknown[]).map(String) : []);
    const [add, drop] = change.kind === "approve" ? ["enabledMcpjsonServers", "disabledMcpjsonServers"] : ["disabledMcpjsonServers", "enabledMcpjsonServers"];
    data[add] = [...new Set([...list(add), change.name])];
    const rest = list(drop).filter((n) => n !== change.name);
    if (rest.length) data[drop] = rest;
    else delete data[drop];
    return { path: file, content: JSON.stringify(data, null, 2) + "\n", baseHash: t?.hash ?? null };
  }
  if (!CODEX_NAME.test(change.name)) throw new Error("Give the server a name of letters, numbers, dashes or underscores.");
  const file = change.scope === "project" ? (project ? path.join(project.path, ".codex", "config.toml") : null) : path.join(CODEX_DIR, "config.toml");
  if (!file) throw new Error("Open the project first.");
  const t = await readText(file);
  const text = t?.text ?? "";
  const key = (k: string) => `mcp_servers.${change.name}.${k}`;
  let content: string;
  if (change.kind === "remove") content = removeTomlTable(text, `mcp_servers.${change.name}`);
  else if (change.kind === "enable") content = setTomlKeys(text, [{ key: key("enabled"), value: null }]);
  else if (change.kind === "disable") content = setTomlKeys(text, [{ key: key("enabled"), value: false }]);
  else if (change.kind === "add") {
    const sets: { key: string; value: unknown }[] = [];
    if (change.transport === "http") {
      const url = new URL(String(change.url ?? ""));
      if (!/^https?:$/.test(url.protocol)) throw new Error("The address has to start with https:// or http://.");
      sets.push({ key: key("url"), value: url.toString() });
      if (change.tokenVar) {
        if (!VAR.test(change.tokenVar)) throw new Error(`${change.tokenVar} isn't an environment variable name.`);
        sets.push({ key: key("bearer_token_env_var"), value: change.tokenVar });
      }
    } else {
      if (!change.command?.trim()) throw new Error("Give the command that starts the server.");
      sets.push({ key: key("command"), value: change.command.trim() });
      if (change.args?.length) sets.push({ key: key("args"), value: change.args });
      const vars = (change.envVars ?? []).filter(Boolean);
      const badVar = vars.find((v) => !VAR.test(v));
      if (badVar) throw new Error(`${badVar} isn't an environment variable name.`);
      if (vars.length) sets.push({ key: key("env_vars"), value: vars });
    }
    content = setTomlKeys(text, sets);
  } else throw new Error("That change isn't one AgentCP makes.");
  return { path: file, content, baseHash: t?.hash ?? null };
}
