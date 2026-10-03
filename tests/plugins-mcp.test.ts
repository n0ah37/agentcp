import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import type { ProjectRef } from "../shared/types.ts";
import { docSays } from "../engine/lib/docs.ts";
import { forget } from "../engine/lib/git.ts";
import { MCP_CITES, claudeJson, claudeMcp, cleanUrl, codexMcp, maskArgs } from "../engine/lib/mcp.ts";
import { CLAUDE_DIR, CODEX_DIR, HOME } from "../engine/lib/paths.ts";
import { listPlugins } from "../engine/lib/plugins.ts";

const write = (p: string, text: string | object) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof text === "string" ? text : JSON.stringify(text, null, 2));
};
const ref = (p: string): ProjectRef => ({ path: p, display: p, name: path.basename(p), group: "", lastActive: null, isWorktree: false, exists: true });

const SECRET = "sk-live-9f8e7d6c5b4a39281706f5e4d3c2b1a0";
let project = "";

beforeAll(() => {
  expect(HOME).toContain("acp-test-home");
  project = path.join(HOME, "Code", "shop");
  fs.mkdirSync(project, { recursive: true });
  execFileSync("git", ["init", "-q", project]);
  forget();
});

describe("plugins", () => {
  it("finds marketplace, synced and skills-folder plugins, whether each loads, and what it adds", async () => {
    const root = path.join(CLAUDE_DIR, "plugins");
    const cached = path.join(root, "cache", "acme", "deploy", "1.2.0");
    write(path.join(cached, ".claude-plugin", "plugin.json"), { name: "deploy", version: "1.2.0", description: "Ship it", author: { name: "Acme" } });
    write(path.join(cached, "skills", "release", "SKILL.md"), "---\nname: release\ndescription: Cut a release\n---\n");
    write(path.join(cached, "agents", "checker.md"), "---\nname: checker\ndescription: Checks\n---\n");
    write(path.join(cached, "hooks", "hooks.json"), { hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "lint" }] }] } });
    write(path.join(cached, ".mcp.json"), { mcpServers: { deploydb: { command: "deploy-db" } } });
    const off = path.join(root, "cache", "acme", "old", "0.1.0");
    write(path.join(off, ".claude-plugin", "plugin.json"), { name: "old" });
    write(path.join(root, "installed_plugins.json"), { version: 2, plugins: { "deploy@acme": [{ scope: "user", installPath: cached, version: "1.2.0" }], "old@acme": [{ scope: "user", installPath: off }] } });
    write(path.join(root, "synced", "acct", "notes", ".claude-plugin", "plugin.json"), { name: "notes", description: "Take notes" });
    write(path.join(CLAUDE_DIR, "skills", "kit", ".claude-plugin", "plugin.json"), { name: "kit", defaultEnabled: true });
    write(path.join(CLAUDE_DIR, "settings.json"), { enabledPlugins: { "deploy@acme": true } });

    const plugins = await listPlugins(null);
    const by = Object.fromEntries(plugins.map((p) => [p.id, p]));
    expect(by["deploy@acme"]).toMatchObject({ on: true, origin: "marketplace", marketplace: "acme", version: "1.2.0", author: "Acme", installedFor: "user" });
    expect(by["deploy@acme"].adds).toMatchObject({ skills: [{ name: "release", path: path.join(cached, "skills", "release", "SKILL.md") }], agents: [{ name: "checker" }], hooks: 1, mcp: ["deploydb"] });
    expect(by["old@acme"]).toMatchObject({ on: false, why: "Installed, but no settings file turns it on." });
    expect(by["notes@synced"]).toMatchObject({ on: true, origin: "synced" });
    expect(by["kit@skills-dir"]).toMatchObject({ on: true, origin: "skills-dir" });

    write(path.join(CLAUDE_DIR, "settings.json"), { enabledPlugins: { "deploy@acme": true, "notes@synced": false } });
    expect((await listPlugins(null)).find((p) => p.id === "notes@synced")?.on).toBe(false);
  });
});

describe("MCP servers", () => {
  it("still finds every sentence the MCP screens rely on", () => {
    for (const c of MCP_CITES) expect(docSays(c.slug, c.says), `${c.slug}#${c.anchor}: "${c.says}"`).toBe(true);
  });

  it("hides secrets in command lines and addresses", () => {
    expect(maskArgs(["-y", "@acme/server", "--api-key", SECRET, `TOKEN=${SECRET}`, SECRET])).toEqual(["-y", "@acme/server", "--api-key", "••••", "TOKEN=••••", "••••"]);
    expect(cleanUrl(`https://user:pw@mcp.acme.dev/mcp?key=${SECRET}#x`)).toBe("https://mcp.acme.dev/mcp");
  });

  it("orders Claude Code's servers the way its docs do, and says why each one is or isn't used", async () => {
    write(claudeJson(), {
      oauthAccount: { emailAddress: "someone@example.com" },
      mcpServers: {
        github: { type: "http", url: "https://api.github.com/mcp", headers: { Authorization: `Bearer ${SECRET}` } },
        workspace: { command: "ws" },
        search: { command: "search-mcp", env: { API_KEY: `${SECRET}\n` } },
      },
      projects: { [project]: { hasTrustDialogAccepted: false, disabledMcpServers: ["search"], mcpServers: { github: { type: "http", url: "https://ghe.acme.dev/mcp" } } } },
    });
    write(path.join(project, ".mcp.json"), { mcpServers: { db: { command: "db-mcp", args: ["--password", SECRET] }, docs: { type: "http", url: "https://docs.acme.dev/mcp" }, legacy: { command: "legacy" } } });
    write(path.join(CLAUDE_DIR, "settings.json"), { enabledPlugins: { "deploy@acme": true }, enabledMcpjsonServers: ["docs"], disabledMcpjsonServers: ["legacy"] });
    // A project's own approvals don't count until the folder is trusted.
    write(path.join(project, ".claude", "settings.json"), { enabledMcpjsonServers: ["db"] });

    const v = await claudeMcp(ref(project));
    const by = (name: string, scope: string) => v.servers.find((s) => s.name === name && s.scope === scope)!;
    expect(by("github", "local")).toMatchObject({ status: "on", where: "This project (just you)" });
    expect(by("github", "user")).toMatchObject({ status: "replaced" });
    expect(by("github", "user").findings.map((f) => f.id)).toContain("mcp:same-name");
    expect(by("github", "user").secrets).toEqual(["Authorization header"]);
    expect(by("workspace", "user")).toMatchObject({ status: "skipped" });
    expect(by("search", "user")).toMatchObject({ status: "off" });
    expect(by("search", "user").findings.map((f) => f.id)).toContain("mcp:whitespace");
    expect(by("db", "project")).toMatchObject({ status: "pending", endpoint: "db-mcp --password ••••" });
    expect(by("docs", "project")).toMatchObject({ status: "on" });
    expect(by("legacy", "project")).toMatchObject({ status: "off" });
    expect(by("plugin:deploy:deploydb", "plugin")).toMatchObject({ status: "on", where: "deploy plugin" });
    // Nothing secret, and nothing else from ~/.claude.json, leaves the engine.
    const out = JSON.stringify(v);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("someone@example.com");
  });

  it("reads Codex's [mcp_servers] tables, names the secrets it sets, and honours enabled = false", async () => {
    write(path.join(CODEX_DIR, "config.toml"), [
      "[mcp_servers.docs]",
      'url = "https://docs.acme.dev/mcp?token=abc"',
      'bearer_token_env_var = "DOCS_TOKEN"',
      "",
      "[mcp_servers.local]",
      'command = "local-mcp"',
      "enabled = false",
      `env = { API_KEY = "${SECRET}" }`,
      "",
    ].join("\n"));
    const v = await codexMcp(null);
    expect(v.servers.map((s) => [s.name, s.status, s.endpoint])).toEqual([
      ["docs", "on", "https://docs.acme.dev/mcp"],
      ["local", "off", "local-mcp"],
    ]);
    expect(v.servers[0].secrets).toEqual(["DOCS_TOKEN"]);
    expect(JSON.stringify(v)).not.toContain(SECRET);
  });
});

describe("managing plugins and MCP servers", () => {
  it("builds Claude Code's own commands from fixed shapes, and hides secret values in what it shows", async () => {
    const { build, describe: describeCmd } = await import("../engine/lib/agent-commands.ts");
    const p = ref(project);
    expect(build({ kind: "plugin", action: "disable", id: "deploy@acme", scope: "user" }, p).args).toEqual(["plugin", "disable", "deploy@acme", "--scope", "user"]);
    const add = build({ kind: "mcp-add", name: "gh", scope: "user", transport: "http", url: "https://api.github.com/mcp", headers: [["Authorization", `Bearer ${SECRET}`]] }, p);
    expect(add.args).toEqual(["mcp", "add", "--header", `Authorization: Bearer ${SECRET}`, "--scope", "user", "--transport", "http", "gh", "https://api.github.com/mcp"]);
    expect(add.shown.join(" ")).not.toContain(SECRET);
    const local = build({ kind: "mcp-add", name: "db", scope: "project", transport: "stdio", command: "npx", args: ["-y", "db-mcp"], env: [["DB_PASSWORD", SECRET]] }, p);
    expect(local.args).toEqual(["mcp", "add", "--env", `DB_PASSWORD=${SECRET}`, "--scope", "project", "--transport", "stdio", "db", "--", "npx", "-y", "db-mcp"]);
    expect(local.touches).toEqual([path.join(project, ".mcp.json")]);
    expect(describeCmd({ kind: "mcp-add", name: "db", scope: "project", transport: "stdio", command: "npx", env: [["DB_PASSWORD", SECRET]] }, p).command).toBe("claude mcp add --env DB_PASSWORD=•••• --scope project --transport stdio db -- npx");
    expect(() => build({ kind: "plugin", action: "install", id: "x; rm -rf ~", scope: "user" }, p)).toThrow(/plugin id/);
    expect(() => build({ kind: "mcp-add", name: "bad name", scope: "user", transport: "http", url: "https://x.dev" }, p)).toThrow(/name/);
    expect(() => build({ kind: "mcp-add", name: "x", scope: "user", transport: "http", url: "file:///etc/passwd" }, p)).toThrow(/https/);
  });

  it("approves or turns off a project's server in its local settings, and edits Codex's [mcp_servers] tables", async () => {
    const { planMcp } = await import("../engine/lib/mcp.ts");
    const p = ref(project);
    const approve = await planMcp(p, { agent: "claude", kind: "approve", name: "db" });
    expect(approve.path).toBe(path.join(project, ".claude", "settings.local.json"));
    expect(JSON.parse(approve.content)).toEqual({ enabledMcpjsonServers: ["db"] });
    write(approve.path, { enabledMcpjsonServers: ["db"], disabledMcpjsonServers: ["old"] });
    expect(JSON.parse((await planMcp(p, { agent: "claude", kind: "reject", name: "db" })).content)).toEqual({ disabledMcpjsonServers: ["old", "db"] });

    write(path.join(CODEX_DIR, "config.toml"), 'model = "gpt-5"\n\n[mcp_servers.docs]\nurl = "https://docs.acme.dev/mcp"\n\n[mcp_servers.docs.tools.search]\napproval_mode = "auto"\n\n[features]\nhooks = true\n');
    const off = await planMcp(null, { agent: "codex", kind: "disable", name: "docs", scope: "user" });
    expect(off.content).toContain("[mcp_servers.docs]\nurl = \"https://docs.acme.dev/mcp\"\nenabled = false");
    const gone = await planMcp(null, { agent: "codex", kind: "remove", name: "docs", scope: "user" });
    expect(gone.content).toBe('model = "gpt-5"\n\n[features]\nhooks = true\n');
    const added = await planMcp(null, { agent: "codex", kind: "add", name: "gh", scope: "user", transport: "http", url: "https://api.github.com/mcp", tokenVar: "GITHUB_TOKEN" });
    expect(added.content).toContain('[mcp_servers.gh]\nurl = "https://api.github.com/mcp"\nbearer_token_env_var = "GITHUB_TOKEN"');
  });

  it("records in History the files an agent's command changes", async () => {
    const { withHistory, listHistory } = await import("../engine/lib/write.ts");
    const { setPrefs } = await import("../engine/lib/prefs.ts");
    const file = path.join(CLAUDE_DIR, "settings.json");
    write(file, { enabledPlugins: { "deploy@acme": true } });
    await setPrefs({ allowEdits: false });
    await expect(withHistory([file], async () => {})).rejects.toThrow(/Editing is turned off/);
    await setPrefs({ allowEdits: true });
    await withHistory([file], async () => write(file, { enabledPlugins: { "deploy@acme": false } }));
    const last = (await listHistory())[0];
    expect(last).toMatchObject({ action: "save", path: file });
    expect(fs.readFileSync(last.snapshot!, "utf8")).toContain('"deploy@acme": true');
  });
});
