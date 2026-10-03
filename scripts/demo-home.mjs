#!/usr/bin/env node
// A made-up home folder for screenshots: a few projects with instruction files
// at every level, rules, a skill, a subagent, memory, settings and Codex files,
// and nothing from anyone's real Mac. Captures for the landing page and the
// store come from here, so no real path, file or session title is published.
//
//   node scripts/demo-home.mjs <dir>
//   PATH=<dir>/.local/bin:$PATH HOME=<dir> CLAUDE_CONFIG_DIR=<dir>/.claude CODEX_HOME=<dir>/.codex \
//     ACP_HOME=<dir>/.agentcp node scripts/capture.mjs <out> <shots.json>
//
// Put it at a path that names nobody: Claude names memory folders after the
// project's full path, so a demo home under your own scratch folder carries
// your user name into the Memory screen.
//
// The home folder carries stand-in `claude` and `codex` commands that only print a version, so
// setup shows ~/.local/bin instead of the real binaries' paths.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const home = path.resolve(process.argv[2] ?? "demo-home");
fs.rmSync(home, { recursive: true, force: true });

const put = (rel, text) => {
  const p = path.join(home, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text.replace(/^\n/, ""));
};
const git = (rel) => execFileSync("git", ["init", "-q", path.join(home, rel)]);
const enc = (abs) => abs.replace(/[^a-zA-Z0-9]/g, "-");
const ran = (rel, minutesAgo) => {
  const dir = path.join(home, ".claude", "projects", enc(path.join(home, rel)));
  const f = path.join(dir, "0f3c2a51-demo.jsonl");
  fs.mkdirSync(dir, { recursive: true });
  // A meta line: enough for the project list to learn the folder, not a session of its own.
  fs.writeFileSync(f, JSON.stringify({ type: "user", isMeta: true, cwd: path.join(home, rel), message: { role: "user", content: "<local-command-caveat>setup</local-command-caveat>" } }) + "\n");
  const t = new Date(Date.now() - minutesAgo * 60_000);
  fs.utimesSync(f, t, t);
  return dir;
};

// The folders every Mac has and macOS asks about, so setup's search of them finds them.
for (const d of ["Documents", "Desktop", "Downloads"]) fs.mkdirSync(path.join(home, d), { recursive: true });

// A stand-in for the claude binary: setup reads its version and path.
put(".local/bin/claude", "#!/bin/sh\necho '2.1.285 (Claude Code)'\n");
fs.chmodSync(path.join(home, ".local/bin/claude"), 0o755);
put(".local/bin/codex", "#!/bin/sh\necho 'codex-cli 0.155.1'\n");
fs.chmodSync(path.join(home, ".local/bin/codex"), 0o755);

// Your own instructions, for every project.
put(".claude/CLAUDE.md", `
# How I work

- Keep answers short. Lead with what changed and what I need to do.
- Ask before adding a dependency.
- Prefer small commits with messages that read cold.
- Run the tests before you say something works.

## Tools

- pnpm, not npm.
- Use the GitHub CLI for pull requests.
`);
put(".claude/settings.json", JSON.stringify({
  model: "sonnet",
  effortLevel: "medium",
  permissions: { allow: ["Bash(pnpm test:*)"] },
  enabledPlugins: { "commit-helper@acme-tools": true },
  enabledMcpjsonServers: ["postgres"],
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "~/.claude/hooks/guard.sh", timeout: 10 }] }],
    Stop: [{ hooks: [{ type: "command", command: "say Done" }] }],
  },
}, null, 2) + "\n");
put(".claude/skills/release-notes/SKILL.md", `
---
name: release-notes
description: Write release notes from the commits since the last tag. Use when asked for release notes or a changelog entry.
---

# Release notes

1. Read the commits since the last tag with \`git log --oneline <tag>..HEAD\`.
2. Group them into Added, Changed and Fixed.
3. Write one line per change, in plain words, for the people who use the app.
`);
put(".claude/agents/reviewer.md", `
---
name: reviewer
description: Reviews a change for bugs and unclear code before it is committed. Use after finishing a change.
tools: Read, Grep, Glob
---

You review the change in front of you. List real problems first, each with the file and line, then anything that is only a matter of taste.
`);

// A folder of projects with its own shared instructions.
put("Code/CLAUDE.md", `
# Projects in ~/Code

Every project here uses pnpm and TypeScript. Tests live next to the code they test.
`);

git("Code/storefront");
put("Code/storefront/CLAUDE.md", `
# storefront

The shop's web app: Next.js pages under \`app/\`, payments through Stripe.

## Commands

- \`pnpm dev\` runs the site on port 3000.
- \`pnpm test\` runs the unit tests; run it before every commit.

## Rules

- Prices are integers in cents, never floats.
- Never log a customer's email or address.
`);
put("Code/storefront/.claude/rules/checkout.md", `
---
paths:
  - "app/checkout/**"
---

Checkout changes need a test for the failed-payment path.
`);
put("Code/storefront/app/checkout/CLAUDE.md", `
# Checkout

Stripe webhooks arrive at \`/api/stripe\`. Verify the signature before reading the body.
`);
const mem = ran("Code/storefront", 18);
put(path.relative(home, path.join(mem, "memory", "MEMORY.md")), `
- [Test data](test-data.md) — use the seeded shop, never production
- [Deploys](deploys.md) — preview deploys come from every pull request
`);
put(path.relative(home, path.join(mem, "memory", "test-data.md")), `
---
name: test-data
description: Which data to test against
type: project
---

Use the seeded shop from \`pnpm db:seed\`. Never point tests at production.
`);

git("Code/api-server");
put("Code/api-server/AGENTS.md", `
# api-server

The shop's API: Fastify on Node 24, Postgres through Drizzle.

- \`pnpm dev\` starts it on port 4000.
- Every route has a schema; add one before the handler.
- Migrations go in \`drizzle/\` and are never edited after they ship.
`);
ran("Code/api-server", 60 * 26);

git("Code/docs-site");
put("Code/docs-site/README.md", "# docs-site\n\nThe help centre.\n");
ran("Code/docs-site", 60 * 24 * 5);

// Codex's own skills: one it shares by name with Claude, one only this repository has.
put(".agents/skills/release-notes/SKILL.md", `
---
name: release-notes
description: Write release notes from the commits since the last tag.
---

Group the commits into Added, Changed and Fixed, one plain line each.
`);
put("Code/storefront/.agents/skills/deploy-preview/SKILL.md", `
---
name: deploy-preview
description: Deploy a preview of the storefront for a pull request.
---

Run \`pnpm build\`, then \`pnpm deploy:preview\` and post the URL on the pull request.
`);

// Codex's own files.
put(".codex/AGENTS.md", `
# How I work

Keep answers short. Ask before adding a dependency. Run the tests before you say something works.
`);
// MCP servers: yours in ~/.claude.json (CLAUDE_CONFIG_DIR puts it inside .claude), the storefront's in .mcp.json.
put(".claude/.claude.json", JSON.stringify({
  mcpServers: {
    github: { type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } },
    linear: { type: "http", url: "https://mcp.linear.app/mcp" },
  },
  projects: { [path.join(home, "Code/storefront")]: { hasTrustDialogAccepted: true, mcpServers: {} } },
}, null, 2) + "\n");
put("Code/storefront/.mcp.json", JSON.stringify({
  mcpServers: {
    postgres: { command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres"], env: { DATABASE_URL: "${DATABASE_URL}" } },
    sentry: { type: "http", url: "https://mcp.sentry.dev/mcp" },
  },
}, null, 2) + "\n");

// One plugin from a made-up marketplace, with a skill, a command and a hook.
const plug = ".claude/plugins/cache/acme-tools/commit-helper/1.4.0";
put(`${plug}/.claude-plugin/plugin.json`, JSON.stringify({ name: "commit-helper", version: "1.4.0", description: "Writes commit messages and checks them before you push.", author: { name: "Acme Tools" } }, null, 2) + "\n");
put(`${plug}/skills/commit-message/SKILL.md`, "---\nname: commit-message\ndescription: Write a commit message for the staged change, in the repository's style.\n---\n\n# commit-message\n\nRead the staged diff, then write a subject under 60 characters and a short body that says why.\n");
put(`${plug}/commands/squash.md`, "---\ndescription: Squash the branch's commits into one\n---\nSquash the commits on this branch into one, keeping the first message.\n");
put(`${plug}/hooks/hooks.json`, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/check-commit.sh" }] }] } }, null, 2) + "\n");
put(".claude/plugins/installed_plugins.json", JSON.stringify({ version: 2, plugins: { "commit-helper@acme-tools": [{ scope: "user", installPath: path.join(home, plug), version: "1.4.0", installedAt: "2026-09-20T10:00:00.000Z", lastUpdated: "2026-09-28T10:00:00.000Z" }] } }, null, 2) + "\n");
put(".claude/plugins/known_marketplaces.json", JSON.stringify({ "acme-tools": { source: { source: "github", repo: "acme/claude-tools" }, installLocation: path.join(home, ".claude/plugins/marketplaces/acme-tools"), lastUpdated: "2026-09-28T10:00:00.000Z" } }, null, 2) + "\n");

const store = path.join(home, "Code/storefront");
put(".codex/config.toml", [
  'model = "gpt-5-codex"',
  'model_reasoning_effort = "medium"',
  'approval_policy = "on-failure"',
  'sandbox_mode = "workspace-write"',
  "",
  "[features]",
  "hooks = true",
  "memories = true",
  "",
  "[mcp_servers.docs]",
  'command = "npx"',
  'args = ["-y", "@acme/docs-mcp"]',
  "",
  `[projects."${store}"]`,
  'trust_level = "trusted"',
  "",
].join("\n"));
put("Code/storefront/.codex/config.toml", 'model_reasoning_effort = "high"\n');
put(".codex/agents/reviewer.toml", 'name = "reviewer"\ndescription = "Reviews a change for bugs before it is committed."\ndeveloper_instructions = """\nList real problems first, each with the file and line.\n"""\n');
put(".codex/hooks.json", JSON.stringify({ hooks: { PostToolUse: [{ matcher: "apply_patch", hooks: [{ type: "command", command: "pnpm lint --fix", timeout: 60 }] }] } }, null, 2) + "\n");
put(".codex/memories/MEMORY.md", "# Memories\n\n- The storefront uses pnpm and Next.js.\n- Prices are integers in cents.\n");
put(".codex/memories/memory_summary.md", "Works mostly on the storefront and its API. Prefers small commits.\n");
put(".codex/rules/default.rules", 'prefix_rule(pattern = ["pnpm", "test"], decision = "allow")\n');

// Fake chats: Claude Code and Codex sessions over the last 30 days, written in
// each agent's own session-file format, so Sessions and Usage have something to
// show that came from nobody's real work.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const uuid = (n) => `0199${String(n).padStart(4, "0")}-c3d4-7e5f-8a9b-0c1d2e3f${String(n).padStart(4, "0")}`;
const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const CHATS = [
  { agent: "claude", rel: "Code/storefront", title: "Fix the double coupon", prompt: "The cart total is wrong when a coupon applies. Find out why.", tools: [["Read", { file_path: "src/cart.ts" }], ["Grep", { pattern: "applyCoupon" }], ["Edit", { file_path: "src/cart.ts" }], ["Bash", { command: "pnpm test" }]], answer: "Fixed: the coupon was applied once in the cart and again at checkout. It's applied once now, and there's a test for it." },
  { agent: "claude", rel: "Code/storefront", title: "Add Apple Pay to checkout", prompt: "Add Apple Pay as a payment option on the checkout page.", tools: [["Read", { file_path: "app/checkout/page.tsx" }], ["WebFetch", { url: "https://docs.stripe.com/apple-pay" }], ["Edit", { file_path: "app/checkout/page.tsx" }], ["Write", { file_path: "app/checkout/apple-pay.tsx" }], ["Bash", { command: "pnpm dev" }]], answer: "Apple Pay shows on checkout for Safari. It uses Stripe's Payment Request button; the domain still needs verifying in Stripe before it works in production." },
  { agent: "claude", rel: "Code/storefront", title: "Why is the product page slow?", prompt: "The product page takes three seconds to load. Profile it.", tools: [["Bash", { command: "pnpm build && pnpm start" }], ["Read", { file_path: "app/products/[id]/page.tsx" }], ["Edit", { file_path: "app/products/[id]/page.tsx" }]], answer: "Reviews were fetched one by one. They load in one query now; the page is under a second locally." },
  { agent: "claude", rel: "Code/docs-site", title: "Write the returns page", prompt: "Write a help page about returns from our policy doc.", tools: [["Read", { file_path: "content/policy.md" }], ["Write", { file_path: "content/returns.md" }]], answer: "Added content/returns.md: how long you have, how to start a return, and refunds." },
  { agent: "codex", rel: "Code/api-server", title: "Rate limit /orders", prompt: "Add rate limiting to POST /orders, 20 a minute per customer.", tools: [["exec_command", { cmd: "rg -n \"orders\" src/routes" }], ["apply_patch", "*** Begin Patch\n*** Update File: src/routes/orders.ts\n@@"], ["exec_command", { cmd: "pnpm test" }]], answer: "POST /orders now allows 20 requests a minute per customer and answers 429 after that. Tests pass." },
  { agent: "codex", rel: "Code/api-server", title: "Refunds table migration", prompt: "Write the migration for a refunds table linked to orders.", tools: [["apply_patch", "*** Begin Patch\n*** Add File: drizzle/0012_refunds.sql\n@@"], ["exec_command", { cmd: "pnpm drizzle-kit check" }]], answer: "Added drizzle/0012_refunds.sql with a refunds table and a foreign key to orders." },
  { agent: "codex", rel: "Code/storefront", title: "Tidy the checkout tests", prompt: "The checkout tests are flaky. Make them reliable.", tools: [["exec_command", { cmd: "pnpm test checkout --repeat 20" }], ["apply_patch", "*** Begin Patch\n*** Update File: app/checkout/checkout.test.ts\n@@"]], answer: "The flaky test waited on a real timer. It uses fake timers now and passed 20 runs in a row." },
];
const index = [];
for (let n = 0; n < 26; n++) {
  const c = CHATS[n % CHATS.length];
  const ago = Math.round(n * 1600 + rand() * 900) + 30;
  const cwd = path.join(home, c.rel);
  const model = c.agent === "claude" ? (n % 3 ? "claude-sonnet-5-5" : "claude-opus-5-5") : "gpt-5-codex";
  const big = 0.4 + rand() * 1.6;
  if (c.agent === "claude") {
    const id = uuid(n);
    const base = { cwd, sessionId: id, gitBranch: "main", entrypoint: n % 2 ? "cli" : "claude-desktop", version: "2.1.285" };
    const rows = [{ ...base, type: "user", timestamp: iso(ago), message: { role: "user", content: c.prompt } }];
    let t = ago;
    c.tools.forEach(([name, input], i) => {
      t -= 1;
      const u = { input_tokens: Math.round(40 * big), output_tokens: Math.round(900 * big), cache_read_input_tokens: Math.round(38000 * big * (i + 1)), cache_creation_input_tokens: Math.round(3200 * big) };
      const inp = { ...input, ...(input.file_path ? { file_path: path.join(cwd, input.file_path) } : {}) };
      rows.push({ ...base, type: "assistant", timestamp: iso(t), message: { id: `msg_${n}_${i}`, role: "assistant", model, content: [{ type: "tool_use", id: `tu_${n}_${i}`, name, input: inp }], usage: u } });
      rows.push({ ...base, type: "user", timestamp: iso(t), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu_${n}_${i}`, content: "ok" }] } });
    });
    rows.push({ ...base, type: "assistant", timestamp: iso(t - 1), message: { id: `msg_${n}_end`, role: "assistant", model, content: [{ type: "text", text: c.answer }], usage: { input_tokens: 12, output_tokens: Math.round(420 * big), cache_read_input_tokens: Math.round(52000 * big), cache_creation_input_tokens: 800 } } });
    rows.push({ type: "custom-title", sessionId: id, customTitle: c.title });
    const dir = path.join(home, ".claude", "projects", enc(cwd));
    put(path.relative(home, path.join(dir, `${id}.jsonl`)), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const f = path.join(dir, `${id}.jsonl`);
    fs.utimesSync(f, new Date(Date.now() - (t - 1) * 60_000), new Date(Date.now() - (t - 1) * 60_000));
  } else {
    const id = uuid(n);
    const when = new Date(Date.now() - ago * 60_000);
    const stamp = when.toISOString().slice(0, 19).replace(/:/g, "-");
    const rel = `.codex/sessions/${when.toISOString().slice(0, 4)}/${when.toISOString().slice(5, 7)}/${when.toISOString().slice(8, 10)}/rollout-${stamp}-${id}.jsonl`;
    let t = ago;
    const tot = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
    const rows = [
      { timestamp: iso(t), type: "session_meta", payload: { id, cwd, originator: "codex_cli_rs", cli_version: "0.140.0", git: { branch: "main" } } },
      { timestamp: iso(t), type: "turn_context", payload: { cwd, model, effort: "medium" } },
      { timestamp: iso(t), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>" + cwd + "</cwd>\n</environment_context>" }] } },
      { timestamp: iso(t), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: c.prompt }] } },
    ];
    for (const [name, input] of c.tools) {
      t -= 1;
      rows.push({ timestamp: iso(t), type: "response_item", payload: typeof input === "string" ? { type: "custom_tool_call", name, input } : { type: "function_call", name, arguments: JSON.stringify(input), call_id: `c${t}` } });
      tot.input_tokens += Math.round(30000 * big);
      tot.cached_input_tokens += Math.round(26000 * big);
      tot.output_tokens += Math.round(700 * big);
      rows.push({ timestamp: iso(t), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { ...tot } } } });
    }
    rows.push({ timestamp: iso(t - 1), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: c.answer }] } });
    put(rel, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const f = path.join(home, rel);
    fs.utimesSync(f, new Date(Date.now() - (t - 1) * 60_000), new Date(Date.now() - (t - 1) * 60_000));
    index.push({ id, thread_name: c.title, updated_at: iso(t - 1) });
  }
}
put(".codex/session_index.jsonl", index.map((r) => JSON.stringify(r)).join("\n") + "\n");

// The app itself: set up, looking only, Sessions shown, no tip card over the screenshots.
put(".agentcp/preferences.json", JSON.stringify({ setupDone: "2026-10-01T09:00:00Z", projectRoots: ["~/Code"], lastProject: path.join(home, "Code/storefront"), sessions: true, showTips: false }, null, 2) + "\n");

console.log(home);
