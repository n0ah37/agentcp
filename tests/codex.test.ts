import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import type { ProjectRef } from "../shared/types.ts";
import { codexView, parseRules, planCodexSettings, sharePlan } from "../engine/lib/codex.ts";
import { RULES, cite, configKeys, hookEvents, projectIgnoredKeys, skillPlaces } from "../engine/lib/codex-docs.ts";
import { setTomlKeys } from "../engine/lib/toml-edit.ts";
import { forget } from "../engine/lib/git.ts";
import { resolveStack } from "../engine/lib/instructions.ts";
import { CLAUDE_DIR, CODEX_DIR, HOME } from "../engine/lib/paths.ts";
import { refusalFor } from "../engine/lib/write.ts";
import { codexAgents, codexSettings, codexSkills } from "../engine/lib/codex.ts";
import { claudeEvents, hooksView, planHook } from "../engine/lib/hooks.ts";
import { definitionsView, pairSkills } from "../engine/lib/definitions.ts";

const write = (p: string, text: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const ref = (p: string): ProjectRef => ({ path: p, display: p, name: path.basename(p), group: "", lastActive: null, isWorktree: false, exists: true });
const repo = (name: string) => {
  const dir = path.join(HOME, "Codex", name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  forget();
  return dir;
};

describe("what the app knows about Codex comes from Codex's docs", () => {
  it("still finds every sentence a Codex rule stands on", () => {
    for (const [name, r] of Object.entries(RULES)) {
      const c = cite(r);
      expect(c.docCurrent, `${name}: "${r.says}"`).toBe(true);
      expect(c.doc.heading, `${name}: #${r.anchor}`).toBeTruthy();
    }
  });

  it("reads the configuration reference, the hook events and the skill folders from the pages", () => {
    const keys = configKeys();
    expect(keys.length).toBeGreaterThan(150);
    expect(keys.find((k) => k.key === "approval_policy")?.description).toMatch(/approval/);
    expect(projectIgnoredKeys()).toEqual(expect.arrayContaining(["notify", "profile", "model_provider"]));
    const ev = hookEvents();
    expect(ev.map((e) => e.name)).toEqual(expect.arrayContaining(["SessionStart", "PreToolUse", "PermissionRequest", "Stop"]));
    expect(ev.find((e) => e.name === "PreCompact")?.matcher?.examples).toEqual(["manual", "auto"]);
    expect(ev.every((e) => e.doc.heading === e.name)).toBe(true);
    expect(skillPlaces().map((p) => p.pattern)).toEqual(expect.arrayContaining(["$CWD/.agents/skills", "$HOME/.agents/skills"]));
  });
});

describe("writing Codex's config.toml", () => {
  const text = ['# mine', 'model = "gpt-5" # the usual', "", "[features]", "hooks = true", "", "[mcp_servers.docs]", 'command = "npx"', ""].join("\n");

  it("changes a key in place and keeps comments, order and the rest", () => {
    const out = setTomlKeys(text, [{ key: "model", value: "gpt-6" }, { key: "features.memories", value: true }]);
    expect(out).toContain('model = "gpt-6" # the usual');
    expect(out).toContain("[features]\nhooks = true\nmemories = true");
    expect(out.startsWith("# mine\n")).toBe(true);
    expect(out).toContain('[mcp_servers.docs]\ncommand = "npx"');
  });

  it("adds a top-level key before the first table, starts a table it needs, and removes a key", () => {
    const out = setTomlKeys(text, [{ key: "sandbox_mode", value: "read-only" }, { key: "sandbox_workspace_write.network_access", value: true }, { key: "features.hooks", value: null }]);
    expect(out.indexOf('sandbox_mode = "read-only"')).toBeLessThan(out.indexOf("[features]"));
    expect(out).toContain("[sandbox_workspace_write]\nnetwork_access = true");
    expect(out).not.toContain("hooks = true");
  });

  it("refuses a value written over several lines, rather than guess", () => {
    expect(() => setTomlKeys('notify = [\n  "say",\n]\n', [{ key: "notify", value: ["x"] }])).toThrow(/several lines/);
  });

  it("won't put a key in a project's config that Codex ignores there", async () => {
    await expect(planCodexSettings({ project: ref(HOME), scope: "project", sets: [{ key: "notify", value: ["say"] }] })).rejects.toThrow(/ignores notify/);
  });
});

describe("what Codex reads", () => {
  let big: string;
  let plain: string;

  beforeAll(() => {
    write(path.join(CODEX_DIR, "AGENTS.override.md"), "   \n");
    write(path.join(CODEX_DIR, "AGENTS.md"), "# Mine\n");
    big = repo("big");
    write(path.join(big, "AGENTS.md"), "x".repeat(40 * 1024));
    write(path.join(big, "pkg", "AGENTS.md"), "# pkg\n");
    write(path.join(big, "pkg", "AGENTS.override.md"), "# override\n");
    plain = repo("plain");
    write(path.join(plain, "CLAUDE.md"), "# Plain\n\nUse pnpm.\n@docs/extra.md\n");
  });

  it("reads the global AGENTS.md when the override is empty", async () => {
    const v = await codexView(null);
    const global = v.entries.filter((e) => e.level === "codex-home");
    expect(global.map((e) => [e.file.name, e.loads])).toEqual([
      ["AGENTS.override.md", "not-read"],
      ["AGENTS.md", "read"],
    ]);
    expect(global[0].reason).toMatch(/Empty/);
  });

  it("reads one file per folder from the git root down, and stops at the budget", async () => {
    const v = await codexView(ref(path.join(big, "pkg")));
    const rows = v.entries.filter((e) => e.level !== "codex-home").map((e) => [path.relative(big, e.file.path), e.loads]);
    expect(rows).toEqual([
      ["AGENTS.md", "cut"],
      ["pkg/AGENTS.override.md", "dropped"],
      ["pkg/AGENTS.md", "not-read"],
    ]);
    expect(v.totals).toMatchObject({ bytes: 32 * 1024, budget: 32 * 1024 });
    expect(v.levels.map((l) => l.label)).toEqual(["~/.codex", "~/Codex/big", "pkg/"]);
  });

  it("sees a CLAUDE.md Codex can't read, and offers to share it", async () => {
    const v = await codexView(ref(plain));
    expect(v.claudeOnly.map((c) => path.basename(c.path))).toEqual(["CLAUDE.md"]);
    expect(v.missing.map((m) => m.display)).toContain("~/Codex/plain/AGENTS.md");
    expect(v.share).toMatchObject({ from: path.join(plain, "CLAUDE.md"), to: path.join(plain, "AGENTS.md"), imports: 1, finish: false });
  });

  it("shares by moving the text into AGENTS.md and importing it from CLAUDE.md, as the docs lay out", async () => {
    const plan = await sharePlan(ref(plain));
    expect(plan.steps.map((s) => path.basename(s.path))).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(plan.steps[0]).toMatchObject({ content: "# Plain\n\nUse pnpm.\n@docs/extra.md\n", baseHash: null });
    expect(plan.steps[1].content.startsWith("@AGENTS.md\n")).toBe(true);
    expect(plan.steps[1].baseHash).toBeTruthy();
    expect(plan.note).toMatch(/doesn't follow imports/);

    // Stopped after the first write, the share is offered again with only the second step left.
    write(plan.steps[0].path, plan.steps[0].content);
    const half = await codexView(ref(plain));
    expect(half.share?.finish).toBe(true);
    expect((await sharePlan(ref(plain))).steps.map((s) => path.basename(s.path))).toEqual(["CLAUDE.md"]);

    // Once both are written, Claude reads the same text through the import, and Codex reads AGENTS.md.
    write(plan.steps[1].path, plan.steps[1].content);
    const claude = await resolveStack(ref(plain));
    expect(claude.entries.find((e) => e.file.path === path.join(plain, "AGENTS.md"))?.loads).toBe("launch");
    const after = await codexView(ref(plain));
    expect(after.share).toBeNull();
    expect(after.entries.find((e) => e.file.path === path.join(plain, "AGENTS.md"))?.loads).toBe("read");
  });
});

describe("Codex's skills", () => {
  it("finds them from the project up to the repository root, then in your own folder", async () => {
    const dir = repo("skills");
    write(path.join(dir, "web", ".agents", "skills", "lint", "SKILL.md"), "---\nname: lint\ndescription: Lint the web app\n---\n");
    write(path.join(dir, ".agents", "skills", "release", "SKILL.md"), "---\nname: release\ndescription: Cut a release\n---\n");
    write(path.join(HOME, ".agents", "skills", "notes", "SKILL.md"), "---\nname: notes\ndescription: Take notes\n---\n");
    write(path.join(CODEX_DIR, "skills", "old", "SKILL.md"), "---\nname: old\ndescription: Old place\n---\n");
    const { items } = await codexSkills(ref(path.join(dir, "web")));
    // ~/.codex/skills isn't in the docs' list any more, so the app doesn't read it.
    expect(items.map((i) => [i.name, i.where])).toEqual([
      ["lint", "This project"],
      ["release", "Repository"],
      ["notes", "User"],
    ]);
  });

  it("says whether Codex reads the same skill, a copy of it, or a different one", async () => {
    const skill = (name: string, body = "Do it.") => `---\nname: ${name}\ndescription: The ${name} skill\n---\n${body}\n`;
    for (const n of ["shared", "copied", "differs", "alone"]) write(path.join(CLAUDE_DIR, "skills", n, "SKILL.md"), skill(n));
    write(path.join(HOME, ".agents", "skills", "copied", "SKILL.md"), skill("copied"));
    write(path.join(HOME, ".agents", "skills", "differs", "SKILL.md"), skill("differs", "Do it differently."));
    fs.symlinkSync(path.join(CLAUDE_DIR, "skills", "shared"), path.join(HOME, ".agents", "skills", "shared"));
    const claude = (await definitionsView("skill", null)).items.filter((i) => i.source === "user");
    await pairSkills(claude, (await codexSkills(null)).items, "codex");
    expect(Object.fromEntries(claude.map((i) => [i.name, i.twin?.relation ?? null]))).toEqual({ alone: null, copied: "copy", differs: "different", shared: "same" });
  });

  it("lets Markdown be written in .agents folders and nothing else there", () => {
    expect(refusalFor(path.join(HOME, ".agents", "skills", "x", "SKILL.md"))).toBeNull();
    expect(refusalFor(path.join(HOME, ".agents", "skills", "x", "run.sh"))).toMatch(/Only instruction/);
  });
});

describe("Codex's settings", () => {
  it("names each layer, what's in force, and config that no longer works", async () => {
    const dir = repo("settings");
    write(path.join(CODEX_DIR, "config.toml"), [
      'model = "gpt-5-codex"',
      'approval_policy = "on-failure"',
      'profile = "fast"',
      "[profiles.fast]",
      'model = "gpt-5-mini"',
      "[features]",
      "hooks = true",
      "[mcp_servers.docs]",
      'command = "npx"',
      'args = ["-y", "docs-mcp"]',
      `[projects."${dir}"]`,
      'trust_level = "trusted"',
    ].join("\n"));
    write(path.join(dir, ".codex", "config.toml"), 'model = "gpt-5.1-codex"\nnotify = ["say", "done"]\n');
    write(path.join(CODEX_DIR, "deep.config.toml"), 'model_reasoning_effort = "high"\n');
    const v = await codexSettings(ref(dir));
    const cx = v.codex!;
    expect(cx.trust).toMatchObject({ level: "trusted" });
    expect(cx.layers.map((l) => [l.kind, l.used])).toEqual([["user", true], ["project", true], ["profile", false]]);
    // The project wins over your config; a profile only counts with --profile.
    const model = v.rows.find((r) => r.key === "model")!;
    expect(model.effective).toMatchObject({ value: "gpt-5.1-codex", label: "This project" });
    expect(model.values.map((x) => x.label)).toEqual(["This project", "User"]);
    const effort = v.rows.find((r) => r.key === "model_reasoning_effort")!;
    expect(effort.effective).toBeNull();
    expect(effort.values).toEqual([expect.objectContaining({ value: "high", inactive: true })]);
    expect(v.rows.find((r) => r.key === "notify")?.allowed).toEqual(["user"]);
    expect(cx.mcp).toEqual([{ name: "docs", run: "npx -y docs-mcp", enabled: true, from: "User" }]);
    const user = cx.findings[path.join(CODEX_DIR, "config.toml")].map((f) => f.id);
    expect(user).toEqual(expect.arrayContaining(["ap:on-failure", "profiles:fast", "profile:selector"]));
    expect(cx.findings[path.join(dir, ".codex", "config.toml")].map((f) => f.id)).toEqual(["ignored:notify"]);
    expect(cx.permissions.map((p) => p.name)).toEqual(expect.arrayContaining(["Auto (preset)"]));
    // "no flags needed": what Codex does when none of the three keys is set.
    expect(cx.permissions.filter((p) => p.byDefault).map((p) => p.name)).toEqual(["Auto (preset)"]);
  });

  it("says a project layer isn't read in a project Codex doesn't trust", async () => {
    const dir = repo("untrusted");
    write(path.join(dir, ".codex", "config.toml"), 'model = "x"\n');
    const v = await codexSettings(ref(dir));
    expect(v.codex!.layers.find((l) => l.kind === "project")?.used).toBe(false);
    expect(v.codex!.findings[path.join(dir, ".codex", "config.toml")].map((f) => f.id)).toEqual(["trust:untrusted"]);
    expect(v.rows.find((r) => r.key === "model")?.effective?.value).toBe("gpt-5-codex");
  });

  it("lists custom agents from their TOML files", async () => {
    write(path.join(CODEX_DIR, "agents", "reviewer.toml"), 'name = "reviewer"\ndescription = "Reviews a change"\ndeveloper_instructions = "Be blunt."\n');
    const { items, fields } = await codexAgents(null);
    expect(items.filter((i) => i.source !== "builtin").map((i) => [i.name, i.description])).toEqual([["reviewer", "Reviews a change"]]);
    // The built-in agents and the required fields are the ones the subagents guide lists.
    expect(items.filter((i) => i.source === "builtin").map((i) => i.name)).toEqual(expect.arrayContaining(["default", "worker", "explorer"]));
    expect(fields.filter((f) => f.required === "yes").map((f) => f.name)).toEqual(["name", "description", "developer_instructions"]);
  });

  it("reads each prefix rule's pattern, decision and reason from a .rules file", () => {
    const rules = parseRules('# allow gh\nprefix_rule(\n  pattern = ["gh", ["pr", "issue"], "view"],\n  decision = "prompt",\n  justification = "Ask first",\n)\nprefix_rule(pattern = ["rm"], decision = "forbidden")\n');
    expect(rules).toEqual([
      { pattern: ["gh", "pr|issue", "view"], decision: "prompt", justification: "Ask first", line: 2 },
      { pattern: ["rm"], decision: "forbidden", justification: null, line: 7 },
    ]);
  });
});

describe("hooks", () => {
  it("takes Claude Code's hook events from the docs: when each fires, what its matcher sees, whether it can block", () => {
    const ev = claudeEvents();
    expect(ev.length).toBeGreaterThan(20);
    for (const name of ["SessionStart", "PreToolUse", "PostToolUse", "Stop"]) expect(ev.map((e) => e.name)).toContain(name);
    const pre = ev.find((e) => e.name === "PreToolUse")!;
    expect(pre.summary).toMatch(/tool call/i);
    expect(pre.doc.heading).toBe("PreToolUse");
    expect(pre.matcher?.on).toBe("tool name");
    expect(pre.block).toMatchObject({ can: true });
    // Notification's matcher is the notification type, not a tool.
    expect(ev.find((e) => e.name === "Notification")?.matcher?.on).toBe("notification type");
    expect(ev.find((e) => e.name === "Stop")?.matcher).toBeNull();
  });

  it("adds a hook to a file and takes it out again, keeping the rest", async () => {
    const f = path.join(HOME, ".claude", "hooks-test.json");
    write(f, JSON.stringify({ model: "sonnet", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }));
    const added = await planHook({ file: f, event: "PreToolUse", add: { matcher: "Bash", command: "./check.sh", timeout: 30 } });
    const data = JSON.parse(added.content);
    expect(data.model).toBe("sonnet");
    expect(data.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "./check.sh", timeout: 30 }] }]);
    write(f, added.content);
    const removed = JSON.parse((await planHook({ file: f, event: "Stop", remove: { group: 0, index: 0 } })).content);
    expect(removed.hooks.Stop).toBeUndefined();
    expect(removed.hooks.PreToolUse).toHaveLength(1);
  });

  it("reads Codex's hooks.json and the hooks in its config.toml", async () => {
    write(path.join(CODEX_DIR, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }));
    const v = await hooksView("codex", null);
    expect(v.enabled).toBe(true);
    expect(v.entries.map((e) => [e.event, e.run, e.fileLabel])).toEqual([["SessionStart", "echo hi", "User"]]);
    expect(v.events.map((e) => e.name)).toContain("PermissionRequest");
  });
});
