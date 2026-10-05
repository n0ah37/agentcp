import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * A home folder where one agent is installed and the other never was: the
 * agent's command in ~/.local/bin, its folder with a little in it, one project
 * in ~/code with that agent's instructions and one session. Nothing else, so
 * every list the app shows for it is short or empty. Made up: no real names.
 */
export function buildOneAgentHome(home: string, agent: "claude" | "codex" | "opencode"): { project: string } {
  const write = (p: string, text: string, mode?: number) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text, mode ? { mode } : undefined);
  };
  const rows = (p: string, r: object[]) => write(p, r.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const project = path.join(home, "code", "shop");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  write(path.join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  write(path.join(project, "package.json"), '{ "name": "shop" }\n');

  if (agent === "claude") {
    write(path.join(home, ".local/bin/claude"), '#!/bin/sh\necho "2.1.290 (Claude Code)"\n', 0o755);
    write(path.join(home, ".claude/settings.json"), '{\n  "model": "sonnet"\n}\n');
    write(path.join(home, ".claude/CLAUDE.md"), "# How I work\n\n- Use pnpm, never npm.\n- Keep commits small.\n");
    write(path.join(project, "CLAUDE.md"), "# Shop\n\nA small storefront. Run `pnpm test` before you commit.\n");
    const base = { cwd: project, sessionId: "s1", gitBranch: "main", entrypoint: "cli" };
    const usage = { input_tokens: 12, output_tokens: 80, cache_read_input_tokens: 1200, cache_creation_input_tokens: 300 };
    rows(path.join(home, ".claude/projects", project.replace(/[^a-zA-Z0-9]/g, "-"), "s1.jsonl"), [
      { ...base, type: "user", timestamp: at(50), message: { role: "user", content: "Add a free-shipping banner to the cart" } },
      { ...base, type: "assistant", timestamp: at(49), message: { id: "m1", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: "Added the banner above the total." }], usage } },
    ]);
  } else if (agent === "opencode") {
    // Where OpenCode's install script puts it.
    write(path.join(home, ".opencode/bin/opencode"), '#!/bin/sh\necho "2.0.12"\n', 0o755);
    write(path.join(home, ".config/opencode/opencode.json"), '{\n  "$schema": "https://opencode.ai/config.json",\n  "model": "anthropic/claude-sonnet-5-5"\n}\n');
    write(path.join(home, ".config/opencode/AGENTS.md"), "# How I work\n\n- Use pnpm, never npm.\n- Keep commits small.\n");
    write(path.join(project, "AGENTS.md"), "# Shop\n\nA small storefront. Run `pnpm test` before you commit.\n");
    write(path.join(project, "opencode.json"), '{\n  "$schema": "https://opencode.ai/config.json",\n  // The docs server for this project\n  "mcp": { "servers": { "docs": { "type": "remote", "url": "https://docs.example.com/mcp" } } },\n}\n');
    write(path.join(project, ".opencode/agents/review.md"), "---\ndescription: Reviews a diff before you commit\nmode: subagent\n---\n\nYou review diffs. Say what's wrong and why, briefly.\n");
    // One session in OpenCode's database, in the layout its 1.2 release moved sessions to.
    const file = path.join(home, ".local/share/opencode/opencode.db");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, sandboxes text NOT NULL);
      CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, cost real NOT NULL DEFAULT 0, tokens_input integer NOT NULL DEFAULT 0, tokens_output integer NOT NULL DEFAULT 0, tokens_reasoning integer NOT NULL DEFAULT 0, tokens_cache_read integer NOT NULL DEFAULT 0, tokens_cache_write integer NOT NULL DEFAULT 0, agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL, time_compacting integer, time_archived integer);
      CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
      CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);`);
    const t = (min: number) => Date.now() - min * 60_000;
    db.prepare("INSERT INTO project VALUES ('prj_1', ?, 0, 0, '[]')").run(project);
    db.prepare("INSERT INTO session (id, project_id, slug, directory, title, version, model, time_created, time_updated) VALUES ('ses_1', 'prj_1', 'shop', ?, 'Add a free-shipping banner', '1.18.34', ?, ?, ?)").run(project, JSON.stringify({ id: "claude-sonnet-5-5", providerID: "anthropic" }), t(45), t(43));
    const msg = db.prepare("INSERT INTO message VALUES (?, 'ses_1', ?, ?, ?)");
    const part = db.prepare("INSERT INTO part VALUES (?, ?, 'ses_1', ?, ?, ?)");
    msg.run("msg_1", t(45), t(45), JSON.stringify({ role: "user", time: { created: t(45) }, agent: "build", model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" } }));
    part.run("prt_1", "msg_1", t(45), t(45), JSON.stringify({ type: "text", text: "Add a free-shipping banner to the cart" }));
    msg.run("msg_2", t(44), t(43), JSON.stringify({ role: "assistant", time: { created: t(44), completed: t(43) }, modelID: "claude-sonnet-5-5", providerID: "anthropic", mode: "build", agent: "build", path: { cwd: project, root: project }, cost: 0.01, tokens: { input: 20, output: 90, reasoning: 0, cache: { read: 1300, write: 200 } } }));
    part.run("prt_2", "msg_2", t(43), t(43), JSON.stringify({ type: "text", text: "Added the banner above the total." }));
    part.run("prt_3", "msg_2", t(43), t(43), JSON.stringify({ type: "step-finish", reason: "stop", cost: 0.01, tokens: { input: 20, output: 90, reasoning: 0, cache: { read: 1300, write: 200 } } }));
    db.close();
  } else {
    write(path.join(home, ".local/bin/codex"), '#!/bin/sh\necho "codex-cli 0.130.0"\n', 0o755);
    write(path.join(home, ".codex/config.toml"), 'model = "gpt-5-codex"\n');
    write(path.join(home, ".codex/AGENTS.md"), "# How I work\n\n- Use pnpm, never npm.\n- Keep commits small.\n");
    write(path.join(project, "AGENTS.md"), "# Shop\n\nA small storefront. Run `pnpm test` before you commit.\n");
    const id = "0199b2c3-d4e5-7f60-8a9b-1c2d3e4f5a6b";
    rows(path.join(home, ".codex/sessions/2026/10/03", `rollout-2026-10-03T09-00-00-${id}.jsonl`), [
      { timestamp: at(40), type: "session_meta", payload: { id, cwd: project, originator: "codex_cli_rs", git: { branch: "main" } } },
      { timestamp: at(40), type: "turn_context", payload: { model: "gpt-5-codex", cwd: project } },
      { timestamp: at(39), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add a free-shipping banner to the cart" }] } },
      { timestamp: at(38), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Added the banner above the total." }] } },
      { timestamp: at(38), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1400, cached_input_tokens: 1100, output_tokens: 70 } } } },
    ]);
  }
  return { project };
}
