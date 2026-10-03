import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { ProjectRef } from "../shared/types.ts";
import { fileView } from "../engine/lib/files.ts";
import { forget } from "../engine/lib/git.ts";
import { opencodeAgents, opencodeMcp, opencodeSettings, opencodeSkills, opencodeView, parseJsonc } from "../engine/lib/opencode.ts";
import { OC_RULES, ocBuiltinAgents, ocCite, ocConfigKeys, ocSkillPlaces } from "../engine/lib/opencode-docs.ts";
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

describe("what the app knows about OpenCode comes from OpenCode's docs", () => {
  it("still finds every sentence an OpenCode rule stands on, under the heading it names", () => {
    for (const [name, r] of Object.entries(OC_RULES)) {
      const c = ocCite(r);
      expect(c.docCurrent, `${name}: "${r.says}"`).toBe(true);
      if ("anchor" in r && r.anchor) expect(c.doc.heading, `${name}: #${r.anchor}`).toBeTruthy();
    }
  });

  it("reads the skill folders, the built-in agents and the settings from the pages and the schema", () => {
    expect(ocSkillPlaces().map((p) => p.pattern)).toEqual([".opencode/skills", "~/.config/opencode/skills", ".claude/skills", "~/.claude/skills", ".agents/skills", "~/.agents/skills"]);
    const builtins = ocBuiltinAgents().map((a) => a.name);
    expect(builtins).toEqual(expect.arrayContaining(["build", "plan", "general", "explore"]));
    // The hidden system agents (compaction, title, summary) aren't ones you pick.
    expect(builtins).not.toContain("title");
    const keys = ocConfigKeys().map((k) => k.key);
    expect(keys).toEqual(expect.arrayContaining(["instructions", "mcp", "agent", "permission", "model"]));
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
  it("reads AGENTS.md over CLAUDE.md, and its own AGENTS.md over ~/.claude/CLAUDE.md", async () => {
    const dir = repo("shop");
    write(path.join(dir, "CLAUDE.md"), "# Claude's\n");
    write(path.join(CLAUDE_DIR, "CLAUDE.md"), "# Mine for Claude\n");
    let v = await opencodeView(ref(dir));
    // No AGENTS.md anywhere: OpenCode falls back to Claude Code's files.
    expect(v.entries.filter((e) => e.loads === "read").map((e) => e.file.path).sort()).toEqual([path.join(CLAUDE_DIR, "CLAUDE.md"), path.join(dir, "CLAUDE.md")].sort());
    expect(v.missing.map((m) => m.path)).toEqual(expect.arrayContaining([path.join(OPENCODE_DIR, "AGENTS.md"), path.join(dir, "AGENTS.md")]));

    write(path.join(dir, "AGENTS.md"), "# Shop\n");
    write(path.join(OPENCODE_DIR, "AGENTS.md"), "# Mine\n");
    write(path.join(dir, "CONTRIBUTING.md"), "Be kind.\n");
    write(path.join(dir, "opencode.jsonc"), '{\n  // shared rules\n  "instructions": ["CONTRIBUTING.md", "https://example.com/rules.md?token=x"],\n}\n');
    v = await opencodeView(ref(dir));
    const read = v.entries.filter((e) => e.loads === "read").map((e) => e.file.path);
    expect(read).toEqual(expect.arrayContaining([path.join(OPENCODE_DIR, "AGENTS.md"), path.join(dir, "AGENTS.md"), path.join(dir, "CONTRIBUTING.md")]));
    expect(read).not.toContain(path.join(dir, "CLAUDE.md"));
    expect(v.entries.find((e) => e.file.path === path.join(CLAUDE_DIR, "CLAUDE.md"))?.reason).toMatch(/AGENTS\.md is read instead/);
    // A web address is listed, without its query string.
    expect(v.remote).toEqual([{ url: "https://example.com/rules.md", from: expect.stringContaining("opencode.jsonc") }]);
    expect(v.missing).toEqual([]);
    for (const r of v.rules) expect(r.docCurrent).toBe(true);
    fs.rmSync(path.join(CLAUDE_DIR, "CLAUDE.md"), { force: true });
  });

  it("lists skills from its six folders, agents with the built-ins, MCP servers and settings by file", async () => {
    const dir = repo("app");
    write(path.join(dir, ".opencode/skills/deploy/SKILL.md"), "---\nname: deploy\ndescription: Ship it\n---\n");
    write(path.join(dir, ".claude/skills/Review/SKILL.md"), "---\nname: Review\ndescription: Read the diff\n---\n");
    write(path.join(HOME, ".agents/skills/deploy/SKILL.md"), "---\nname: deploy\ndescription: The other one\n---\n");
    const skills = await opencodeSkills(ref(dir));
    // Other tests leave skills in the shared test home; these are this test's.
    const mine = skills.items.filter((s) => s.file.path.startsWith(dir) || s.file.path === path.join(HOME, ".agents/skills/deploy/SKILL.md"));
    expect(mine.map((s) => s.name).sort()).toEqual(["Review", "deploy", "deploy"]);
    expect(skills.findings.map((f) => f.id)).toContain("opencode:skills:unique");
    // A name with capitals isn't one OpenCode's docs allow.
    const review = skills.items.find((s) => s.name === "Review")!;
    expect(review.counts.warning).toBeGreaterThan(0);

    write(path.join(dir, ".opencode/agents/team/review.md"), "---\nmaxSteps: 3\n---\nReview carefully.\n");
    const agents = await opencodeAgents(ref(dir));
    const custom = agents.items.find((a) => a.name === "team/review")!;
    expect(custom.counts.problem).toBe(1); // no description
    expect(custom.counts.warning).toBe(1); // maxSteps
    expect(agents.items.filter((a) => a.source === "builtin").map((a) => a.name)).toEqual(expect.arrayContaining(["build", "plan"]));
    const view = await fileView(path.join(dir, ".opencode/agents/team/review.md"), ref(dir), undefined, "opencode");
    expect(view.file.kind).toBe("opencode-agent");
    expect(view.findings.map((f) => f.id)).toEqual(["opencode:agent:description", "opencode:agent:maxSteps"]);

    write(path.join(OPENCODE_DIR, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "anthropic/claude-sonnet-5-5", mcp: { docs: { type: "remote", url: "https://mcp.example.com/mcp?key=secret", headers: { Authorization: "Bearer x" } } }, nonsense: 1 }));
    write(path.join(dir, "opencode.json"), JSON.stringify({ mcp: { docs: { enabled: false }, local: { type: "local", command: ["npx", "server", "--token", "sk-abcdefghijklmnopqrstuvwxyz123456"] } }, model: "openai/gpt-5" }));
    const mcp = await opencodeMcp(ref(dir));
    const docs = mcp.servers.find((s) => s.name === "docs")!;
    expect(docs.status).toBe("off");
    expect(docs.endpoint).toBe("https://mcp.example.com/mcp");
    expect(docs.secrets).toEqual(["Authorization header"]);
    expect(mcp.servers.find((s) => s.name === "local")!.endpoint).not.toContain("sk-abcdef");

    const settings = await opencodeSettings(ref(dir), "2026-10-03");
    const model = settings.rows.find((r) => r.key === "model")!;
    expect(model.value).toBe("openai/gpt-5");
    expect(model.setIn).toContain(path.join("app", "opencode.json"));
    expect(model.alsoIn).toEqual([expect.stringContaining(".config/opencode/opencode.json")]);
    expect(settings.unknown).toEqual([{ key: "nonsense", file: expect.stringContaining(".config/opencode/opencode.json") }]);
    fs.rmSync(path.join(OPENCODE_DIR, "opencode.json"), { force: true });
    fs.rmSync(path.join(OPENCODE_DIR, "AGENTS.md"), { force: true });
    fs.rmSync(path.join(HOME, ".agents/skills/deploy"), { recursive: true, force: true });
  });
});
