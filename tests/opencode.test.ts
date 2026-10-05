import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { ProjectRef } from "../shared/types.ts";
import { fileView } from "../engine/lib/files.ts";
import { forget } from "../engine/lib/git.ts";
import { configLayers, opencodeAgents, opencodeCommands, opencodeKindFor, opencodeMcp, opencodePlugins, opencodeSettings, opencodeSkills, opencodeView, parseJsonc } from "../engine/lib/opencode.ts";
import { OC_RULES, ocBuiltinAgents, ocCite, ocCliKeys, ocCommandFields, ocConfigKeys, ocHiddenAgents, ocSkillPlaces } from "../engine/lib/opencode-docs.ts";
import { CLAUDE_DIR, HOME, OPENCODE_DIR } from "../engine/lib/paths.ts";

const write = (p: string, text: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const ref = (p: string): ProjectRef => ({ path: p, display: p, name: path.basename(p), group: "", lastActive: null, isWorktree: false, exists: true });
const repo = (name: string) => {
  const dir = path.join(HOME, "OpenCode", name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  forget();
  return dir;
};
const cleanup = (...paths: string[]) => {
  for (const p of paths) fs.rmSync(p, { recursive: true, force: true });
};

describe("what the app knows about OpenCode comes from OpenCode 2's docs", () => {
  it("still finds every sentence an OpenCode rule stands on, under the heading it names", () => {
    for (const [name, r] of Object.entries(OC_RULES)) {
      const c = ocCite(r);
      expect(c.docCurrent, `${name}: "${r.says}"`).toBe(true);
      if ("anchor" in r && r.anchor) expect(c.doc.heading, `${name}: #${r.anchor}`).toBeTruthy();
    }
  });

  it("reads the skill sources, the agents, the commands' fields and the settings from the pages", () => {
    expect(ocSkillPlaces().map((p) => p.pattern)).toEqual(["~/.config/opencode/skills", "~/.claude/skills", "~/.agents/skills", ".opencode/skills", ".claude/skills", ".agents/skills"]);
    expect(ocBuiltinAgents().map((a) => [a.name, a.mode])).toEqual([["build", "primary"], ["plan", "primary"], ["general", "subagent"], ["explore", "subagent"]]);
    expect(ocHiddenAgents()).toEqual(["compaction", "title", "summary"]);
    expect(ocCommandFields().map((f) => f.name)).toEqual(expect.arrayContaining(["description", "agent", "model", "subagent"]));
    const keys = ocConfigKeys().map((k) => k.key);
    expect(keys).toEqual(expect.arrayContaining(["model", "permissions", "agents", "mcp", "providers", "plugins", "skills", "commands", "warming", "websearch", "compaction"]));
    // OpenCode 1's names aren't OpenCode 2's settings.
    expect(keys).not.toContain("provider");
    expect(ocCliKeys().map((k) => k.key)).toEqual(expect.arrayContaining(["theme", "tabs", "keybinds"]));
  });
});

describe("OpenCode's JSON with comments", () => {
  it("reads comments and trailing commas, and leaves // inside strings alone", () => {
    const { data, error } = parseJsonc('{\n  // a note\n  "url": "https://example.com/x", /* more */\n  "list": [1, 2,],\n}\n');
    expect(error).toBeNull();
    expect(data).toEqual({ url: "https://example.com/x", list: [1, 2] });
    expect(parseJsonc("{ nope }").error).toMatch(/isn't valid JSON/);
  });
});

describe("what OpenCode reads for a project", () => {
  it("reads your AGENTS.md and every AGENTS.md up to your home folder, never CLAUDE.md, and the ones below when it works there", async () => {
    const dir = repo("shop");
    const parent = path.dirname(dir);
    write(path.join(OPENCODE_DIR, "AGENTS.md"), "# Mine\n");
    write(path.join(parent, "AGENTS.md"), "# Everything under OpenCode/\n");
    write(path.join(dir, "AGENTS.md"), "# Shop\n");
    write(path.join(dir, "CLAUDE.md"), "# Claude's\n");
    write(path.join(CLAUDE_DIR, "CLAUDE.md"), "# Mine for Claude\n");
    write(path.join(dir, "packages/web/AGENTS.md"), "# Web\n");
    write(path.join(dir, "CONTRIBUTING.md"), "Be kind.\n");
    write(path.join(dir, "opencode.jsonc"), '{\n  // shared rules\n  "instructions": ["CONTRIBUTING.md", "https://example.com/rules.md?token=x"],\n}\n');
    const v = await opencodeView(ref(dir));
    const loads = Object.fromEntries(v.entries.map((e) => [e.file.path, e.loads]));
    expect(loads[path.join(OPENCODE_DIR, "AGENTS.md")]).toBe("read");
    expect(loads[path.join(parent, "AGENTS.md")]).toBe("read");
    expect(loads[path.join(dir, "AGENTS.md")]).toBe("read");
    expect(loads[path.join(dir, "CLAUDE.md")]).toBe("not-read");
    expect(loads[path.join(CLAUDE_DIR, "CLAUDE.md")]).toBe("not-read");
    expect(loads[path.join(dir, "packages/web/AGENTS.md")]).toBe("on-demand");
    // OpenCode 2 accepts instructions in opencode.json but doesn't read them yet.
    expect(loads[path.join(dir, "CONTRIBUTING.md")]).toBe("not-read");
    expect(v.remote).toEqual([{ url: "https://example.com/rules.md", from: expect.stringContaining("opencode.jsonc") }]);
    expect(v.missing).toEqual([]);
    for (const r of v.rules) expect(r.docCurrent).toBe(true);
    cleanup(path.join(OPENCODE_DIR, "AGENTS.md"), path.join(parent, "AGENTS.md"), path.join(CLAUDE_DIR, "CLAUDE.md"));
  });

  it("merges config files in OpenCode's order: yours, the direct files far to near, then every .opencode one", async () => {
    const dir = repo("order");
    const parent = path.dirname(dir);
    write(path.join(OPENCODE_DIR, "opencode.json"), JSON.stringify({ model: "a/yours" }));
    write(path.join(parent, ".opencode/opencode.json"), JSON.stringify({ model: "c/parent-dot" }));
    write(path.join(dir, "opencode.json"), JSON.stringify({ model: "b/project" }));
    const layers = (await configLayers(ref(dir))).map((l) => l.path);
    expect(layers).toEqual([path.join(OPENCODE_DIR, "opencode.json"), path.join(dir, "opencode.json"), path.join(parent, ".opencode/opencode.json")]);
    // Every .opencode file wins over every direct one, however far up it is.
    const s = await opencodeSettings(ref(dir), "2026-10-05");
    expect(s.rows.find((r) => r.key === "model")!.value).toBe("c/parent-dot");
    cleanup(path.join(OPENCODE_DIR, "opencode.json"), path.join(parent, ".opencode"));
  });

  it("lists MCP servers from mcp.servers and OpenCode 1's place, a later file replacing a server whole", async () => {
    const dir = repo("mcp");
    write(path.join(OPENCODE_DIR, "opencode.json"), JSON.stringify({ mcp: { servers: { docs: { type: "remote", url: "https://mcp.example.com/mcp?key=secret", headers: { Authorization: "Bearer x" } }, old: { type: "local", command: ["old-server"] } } } }));
    write(
      path.join(dir, "opencode.json"),
      JSON.stringify({
        mcp: {
          servers: { docs: { type: "local", command: ["npx", "server", "--token", "sk-abcdefghijklmnopqrstuvwxyz123456"], disabled: true } },
          // OpenCode 1's shape, which OpenCode 2 still reads; an entry with only enabled is ignored.
          legacy: { type: "remote", url: "https://legacy.example.com/mcp", enabled: false },
          old: { enabled: false },
        },
      }),
    );
    const mcp = await opencodeMcp(ref(dir));
    const docs = mcp.servers.find((s) => s.name === "docs")!;
    expect(docs.status).toBe("off");
    expect(docs.transport).toBe("stdio");
    expect(docs.endpoint).not.toContain("sk-abcdef");
    // Replaced whole: the remote one's header is gone with it.
    expect(docs.secrets).toEqual([]);
    expect(docs.note).toMatch(/Replaces the one in Your opencode\.json/);
    expect(mcp.servers.find((s) => s.name === "legacy")).toMatchObject({ status: "off", endpoint: "https://legacy.example.com/mcp" });
    expect(mcp.servers.find((s) => s.name === "old")).toMatchObject({ status: "on" });
    const view = await fileView(path.join(dir, "opencode.json"), ref(dir), undefined, "opencode");
    expect(view.findings.map((f) => f.id)).toEqual(expect.arrayContaining(["opencode:config:mcp-v1"]));
    cleanup(path.join(OPENCODE_DIR, "opencode.json"));
  });

  it("shows settings under OpenCode 2's names, OpenCode 1's counted, ignored and unknown keys apart, and cli.json's", async () => {
    const dir = repo("settings");
    write(path.join(OPENCODE_DIR, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", provider: { acme: { options: { apiKey: "{env:ACME}" } } }, logLevel: "DEBUG", theme: "tokyonight", nonsense: 1 }));
    write(path.join(dir, "opencode.json"), JSON.stringify({ providers: { other: { settings: { apiKey: "sk-abcdefghijklmnopqrstuvwxyz123456" } } }, update: "auto" }));
    write(path.join(OPENCODE_DIR, "cli.json"), JSON.stringify({ $schema: "https://opencode.ai/v2/cli.json", tabs: { mode: "off" } }));
    const s = await opencodeSettings(ref(dir), "2026-10-05");
    const providers = s.rows.find((r) => r.key === "providers")!;
    expect(providers.legacy).toEqual([{ name: "provider", file: expect.stringContaining(".config/opencode/opencode.json") }]);
    expect(providers.value).toContain("acme");
    expect(providers.value).not.toContain("sk-abcdef");
    // A project's update is ignored.
    expect(s.rows.find((r) => r.key === "update")!.value).toBeNull();
    expect(s.ignored.map((i) => i.key).sort()).toEqual(["logLevel", "theme"]);
    expect(s.unknown).toEqual([{ key: "nonsense", file: expect.stringContaining(".config/opencode/opencode.json") }]);
    expect(s.cli.layer.exists).toBe(true);
    expect(s.cli.rows.find((r) => r.key === "tabs")!.value).toBe('{"mode":"off"}');
    for (const r of s.rules) expect(r.docCurrent).toBe(true);
    const view = await fileView(path.join(OPENCODE_DIR, "opencode.json"), ref(dir), undefined, "opencode");
    expect(view.findings.map((f) => f.id)).toEqual(expect.arrayContaining(["opencode:config:v1:provider", "opencode:config:ignored:logLevel", "opencode:config:theme", "opencode:config:unknown:nonsense"]));
    expect(opencodeKindFor(path.join(OPENCODE_DIR, "cli.json"), null)).toBe("opencode-cli");
    cleanup(path.join(OPENCODE_DIR, "opencode.json"), path.join(OPENCODE_DIR, "cli.json"));
  });

  it("finds skills by path-derived ID, a later source winning, and says which ones the model won't see", async () => {
    const dir = repo("skills");
    write(path.join(OPENCODE_DIR, "skills/deploy/SKILL.md"), "---\nname: Deploy\ndescription: Yours\n---\n");
    write(path.join(dir, ".opencode/skills/deploy/SKILL.md"), "---\ndescription: The project's\n---\n");
    write(path.join(dir, ".opencode/skills/review.md"), "Read the diff.\n");
    write(path.join(dir, ".opencode/skills/teams/release/SKILL.md"), "---\ndescription: Ship it\nmetadata:\n  opencode/autoinvoke: false\n---\n");
    write(path.join(dir, ".claude/skills/Notes/SKILL.md"), "---\ndescription: Broken: a colon\n  bad: indent\n---\n");
    const skills = await opencodeSkills(ref(dir));
    const mine = skills.items.filter((s) => s.file.path.startsWith(dir) || s.file.path.startsWith(path.join(OPENCODE_DIR, "skills")));
    expect(mine.map((s) => s.name).sort()).toEqual(["Notes", "deploy", "deploy", "release", "review"]);
    const yours = mine.find((s) => s.file.path.startsWith(OPENCODE_DIR))!;
    expect(yours.shadowedBy).toMatch(/\.opencode\/skills, this project/);
    expect(mine.find((s) => s.name === "review")).toMatchObject({ active: false });
    expect(mine.find((s) => s.name === "release")).toMatchObject({ active: false });
    expect(skills.findings.map((f) => f.id)).toContain("opencode:skills:shadowed");
    const notes = await fileView(path.join(dir, ".claude/skills/Notes/SKILL.md"), ref(dir), undefined, "opencode");
    expect(notes.findings.map((f) => f.id)).toEqual(expect.arrayContaining(["opencode:skill:yaml", "opencode:skill:id"]));
    cleanup(path.join(OPENCODE_DIR, "skills"));
  });

  it("lists agents from files, opencode.json and the built-ins, with OpenCode 1's folders and fields", async () => {
    const dir = repo("agents");
    write(path.join(dir, ".opencode/agents/team/review.md"), "---\nmode: subagent\nmaxSteps: 3\n---\nReview carefully.\n");
    write(path.join(dir, ".opencode/mode/writer.md"), "---\ndescription: Writes docs\n---\nWrite.\n");
    write(path.join(dir, "opencode.json"), JSON.stringify({ agents: { build: { permissions: [{ action: "shell", resource: "git push *", effect: "ask" }] }, title: { model: "x/y" } }, agent: { old: { description: "From OpenCode 1", disable: true } } }));
    const agents = await opencodeAgents(ref(dir));
    const review = agents.items.find((a) => a.name === "team/review")!;
    expect(review.counts).toMatchObject({ warning: 1, note: 1 }); // a subagent with no description; maxSteps
    expect(agents.items.find((a) => a.name === "writer")!.description).toMatch(/^Primary agent\./);
    expect(agents.items.find((a) => a.name === "old")).toMatchObject({ active: false });
    expect(agents.items.find((a) => a.name === "title")!.description).toMatch(/hidden title agent/);
    expect(agents.items.find((a) => a.source === "builtin" && a.name === "build")!.shadowedBy).toBe("build");
    const view = await fileView(path.join(dir, ".opencode/agents/team/review.md"), ref(dir), undefined, "opencode");
    expect(view.file.kind).toBe("opencode-agent");
    expect(view.findings.map((f) => f.id)).toEqual(["opencode:agent:description", "opencode:agent:maxSteps"]);
  });

  it("lists commands, a nearer one winning, and plugins from config and plugins folders", async () => {
    const dir = repo("commands");
    write(path.join(OPENCODE_DIR, "commands/review.md"), "---\ndescription: Yours\n---\nReview $ARGUMENTS.\n");
    write(path.join(dir, ".opencode/commands/review.md"), "---\ndescription: The project's\ntemplate: nope\nsubtask: true\n---\nReview $ARGUMENTS carefully.\n");
    write(path.join(dir, "opencode.json"), JSON.stringify({ commands: { audit: { description: "No template" } }, plugins: ["opencode-acme", "-acme.reviewer", { package: "./local/plugin.ts" }], plugin: ["old-plugin"] }));
    const commands = await opencodeCommands(ref(dir));
    const reviews = commands.items.filter((c) => c.name === "/review");
    expect(reviews.find((c) => c.file.path.startsWith(OPENCODE_DIR))!.shadowedBy).toBe("This project");
    expect(commands.findings.map((f) => f.id)).toEqual(["opencode:commands:template"]);
    const cmd = await fileView(path.join(dir, ".opencode/commands/review.md"), ref(dir), undefined, "opencode");
    expect(cmd.file.kind).toBe("opencode-command");
    expect(cmd.findings.map((f) => f.id)).toEqual(["opencode:command:template", "opencode:command:subtask"]);

    write(path.join(OPENCODE_DIR, "plugins/v2.ts"), "export default { id: 'x', async setup(ctx) {} }\n");
    write(path.join(dir, ".opencode/plugins/v1.ts"), "export const Old = async ({ client }) => ({})\n");
    const plugins = await opencodePlugins(ref(dir));
    const names = plugins.items.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["v2", "v1", "opencode-acme", "-acme.reviewer", "./local/plugin.ts", "old-plugin"]));
    expect(plugins.items.find((p) => p.name === "-acme.reviewer")).toMatchObject({ active: false });
    expect(plugins.items.find((p) => p.name === "v1")!.counts.warning).toBe(1);
    expect(plugins.items.find((p) => p.name === "v2")!.counts.warning).toBe(0);
    expect(opencodeKindFor(path.join(dir, ".opencode/plugins/v1.ts"), null)).toBe("opencode-plugin");
    cleanup(path.join(OPENCODE_DIR, "commands"), path.join(OPENCODE_DIR, "plugins"));
  });
});
