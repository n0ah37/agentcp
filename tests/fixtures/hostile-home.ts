import fs from "node:fs";
import path from "node:path";

/**
 * A home folder from a Mac that isn't ours: code outside ~/Dev, odd folder names,
 * and every file the agents read in a shape that's broken somehow (invalid JSON
 * and TOML, wrong types, binary text, loops, folders where files go, unreadable
 * files). The first-run test runs the engine against it, the way a new person's
 * Mac would; `pnpm exec tsx tests/fixtures/hostile-home.ts <dir>` builds one to
 * open the app on.
 *
 * Returns the projects it made, by folder, and the folders it made unreadable
 * (chmod 000), which the caller restores with `restore` before deleting the home.
 */
export function buildHostileHome(home: string): { projects: string[]; locked: string[] } {
  const locked: string[] = [];
  const at = (...p: string[]) => path.join(home, ...p);
  const write = (p: string, data: string | Buffer, mode?: number) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
    if (mode !== undefined) fs.chmodSync(p, mode);
  };
  const dir = (p: string) => fs.mkdirSync(p, { recursive: true });
  const link = (target: string, p: string) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.symlinkSync(target, p);
  };
  const lock = (p: string) => {
    fs.chmodSync(p, 0o000);
    locked.push(p);
  };
  const binary = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x00, 0x00, 0xc3, 0x28, 0x0a, 0x89, 0x50, 0x4e, 0x47, 0x00, 0x1b, 0x5b, 0x33, 0x31, 0x6d]);

  // The agents' own commands, installed the way their installers put them.
  write(at(".local/bin/claude"), '#!/bin/sh\necho "2.1.290 (Claude Code)"\n', 0o755);
  write(at(".local/bin/codex"), '#!/bin/sh\necho "codex-cli 0.130.0"\n', 0o755);

  // ~/.claude: Claude Code's user files, all of them wrong somehow.
  const c = (...p: string[]) => at(".claude", ...p);
  write(c("settings.json"), '{\n  // a comment\n  "permissions": { "allow": ["Bash(ls:*)"], },\n}\n');
  write(c("settings.local.json"), '\ufeff{"hooks": "nope", "enabledPlugins": [], "env": null, "model": 5, "permissions": {"allow": "Bash"}}');
  write(c("CLAUDE.md"), binary);
  write(c("rules/paths.md"), "---\npaths: [unclosed\n---\n# Rule\n");
  write(c("rules/no-end.md"), "---\npaths: src/**\n# never closed\n");
  write(c("rules/deep/deeper/deepest/x.md"), "# deep rule\n");
  dir(c("rules/folder.md"));
  write(c("agents/plain.md"), "No frontmatter at all.\n");
  write(c("agents/types.md"), "---\nname: [a, b]\ndescription: 5\ntools: 7\nmodel: {x: 1}\n---\nbody\n");
  link(c("agents/missing-target.md"), c("agents/broken.md"));
  dir(c("skills/empty-skill"));
  write(c("skills/colon/SKILL.md"), "---\nname: colon\ndescription: Use when: the user asks: anything\n---\nBody\n");
  dir(c("skills/folder-skill/SKILL.md"));
  link("..", c("skills/loop"));
  write(c("skills/huge/SKILL.md"), `---\nname: huge\ndescription: ${"x".repeat(5000)}\n---\n${"line\n".repeat(20000)}`);
  write(c("output-styles/big.md"), `---\nname: Big\n---\n${"word ".repeat(400_000)}`);
  write(c("plugins/installed_plugins.json"), "garbage");
  write(c("plugins/known_marketplaces.json"), JSON.stringify({ gone: { installLocation: "/nonexistent/place" }, nothing: null, wrong: { installLocation: 5 } }));
  write(c("plugins/synced/acct/bad/.claude-plugin/plugin.json"), "{bad json");
  write(c("plugins/synced/acct/odd/.claude-plugin/plugin.json"), JSON.stringify({ name: 5, skills: [1, null], mcpServers: "../../../../etc/passwd", hooks: { PreToolUse: "x" } }));
  write(at(".claude.json"), JSON.stringify({ mcpServers: [1, 2], projects: { [at("code/my app")]: { mcpServers: null, disabledMcpServers: "x", hasTrustDialogAccepted: "yes" } } }));

  // Sessions: garbage lines, a cut-off last line, an empty file, a folder named like a session.
  const proj = c("projects", at("code/my app").replace(/[^a-zA-Z0-9]/g, "-"));
  write(path.join(proj, "garbage.jsonl"), 'not json\n{"type":"user"}\n{"type":"assistant","message":{"usage":{"input_tokens":"many"}}}\n{"type":"user","message":{"content":[{"type":"text","text":"hi"}]},"timestamp":"not a date"}\n{"type":"assi');
  write(path.join(proj, "empty.jsonl"), "");
  write(path.join(proj, "binary.jsonl"), binary);
  dir(path.join(proj, "folder.jsonl"));
  write(path.join(proj, "memory/MEMORY.md"), "- [x](x.md)\n".repeat(50_000));
  dir(path.join(proj, "memory/x.md"));

  // ~/.codex: Codex's files, all wrong.
  const x = (...p: string[]) => at(".codex", ...p);
  write(x("config.toml"), 'model = "gpt"\n[mcp_servers.a\ncommand = 1\n[[[broken\n');
  dir(x("AGENTS.md"));
  write(x("rules/default.rules"), "prefix_rule(pattern = [\n");
  write(x("sessions/2026/10/01/rollout-2026-10-01T00-00-00-x.jsonl"), 'garbage\n{"type":"session_meta","payload":5}\n{"type":"response_item","payload":{"type":"message","content":"x"}}\n');
  write(x("skills/s/SKILL.md"), binary);

  // Projects, in ~/code rather than ~/Dev, with names that break naive code.
  const projects: string[] = [];
  const repo = (name: string, files: Record<string, string | Buffer> = {}) => {
    const root = at("code", name);
    dir(path.join(root, ".git"));
    for (const [rel, data] of Object.entries(files)) write(path.join(root, rel), data);
    projects.push(root);
    return root;
  };
  repo("my app", { "CLAUDE.md": "# My app\n@CLAUDE.md\n@./missing.md\n@~/nowhere.md\n@../../../../etc/hosts\n", ".mcp.json": "{ not json", ".claude/settings.json": JSON.stringify({ mcpServers: "x", hooks: { PreToolUse: [{ matcher: 5, hooks: "x" }] }, enabledPlugins: { "a@b": "yes" } }) });
  repo("日本語-プロジェクト", { "AGENTS.md": "# 日本語\r\nWindows line endings\r\n", "CLAUDE.local.md": "local\n" });
  repo("weird#name%20&?", { "CLAUDE.md": "# Weird\n", ".claude/rules/r.md": "---\npaths:\n  - '**/*.ts'\n---\nrule\n" });
  repo("emoji-🚀", { "CLAUDE.md": "# 🚀\n" });
  const wt = repo("worktree-ish");
  fs.rmSync(path.join(wt, ".git"), { recursive: true });
  write(path.join(wt, ".git"), "gitdir: /nonexistent/.git/worktrees/x\n");
  write(path.join(wt, "CLAUDE.md"), "# worktree\n");
  const big = repo("big", { "CLAUDE.md": `# Big\n${"A line of instructions that goes on.\n".repeat(90_000)}` });
  void big;
  const looped = repo("loops", { "CLAUDE.md": "# Loops\n@a.md\n", "a.md": "@b.md\n", "b.md": "@a.md\n" });
  link("..", path.join(looped, ".claude/rules/up"));
  link(path.join(looped, "nowhere"), path.join(looped, "AGENTS.md"));
  const nested = repo("nested", { "CLAUDE.md": "# Root\n" });
  let deep = nested;
  for (const part of ["a", "b", "c", "d", "e", "f"]) {
    deep = path.join(deep, part);
    write(path.join(deep, "CLAUDE.md"), `# ${part}\n`);
  }
  write(path.join(nested, "odd\nname.md"), "a file name with a line break\n");
  let long = path.join(nested, "long");
  while (long.length < 900) long = path.join(long, "a-very-long-folder-name-that-repeats");
  write(path.join(long, "CLAUDE.md"), "# far down\n");
  const shut = repo("no-read", { "CLAUDE.md": "# secret\n", ".claude/settings.json": "{}", "AGENTS.md": "# agents\n" });
  lock(path.join(shut, "CLAUDE.md"));
  lock(path.join(shut, ".claude"));

  // A project of instructions without git, a plain folder, a file where a folder would be.
  write(at("notes/handbook/AGENTS.md"), "# Handbook\n");
  write(at("code/README"), "not a project\n");
  write(at("Documents/GitHub/paper/.git/HEAD"), "ref: refs/heads/main\n");

  // Folders the search can't read, at the top and inside a project folder.
  dir(at("private"));
  lock(at("private"));
  dir(at("code/locked-folder"));
  lock(at("code/locked-folder"));
  return { projects, locked };
}

/** Give back the permissions buildHostileHome took away, so the home can be deleted. */
export function restore(locked: string[]): void {
  for (const p of locked) fs.chmodSync(p, 0o755);
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry.endsWith(`${path.sep}hostile-home.ts`)) {
  const home = path.resolve(process.argv[2] ?? "");
  if (!process.argv[2] || (fs.existsSync(home) && fs.readdirSync(home).length)) throw new Error("Give an empty folder for the home.");
  const { projects, locked } = buildHostileHome(home);
  console.log(`${home}: ${projects.length} projects; locked: ${locked.length} (chmod 755 them before deleting)`);
}
