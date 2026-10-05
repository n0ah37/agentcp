import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { buildOneAgentHome } from "./fixtures/one-agent-home.ts";

/**
 * Most people use one agent. A real engine on a home with only Claude Code,
 * then one with only Codex: the agent that isn't there starts off, everything
 * the app lists leaves it out, and turning it on or off is a preference.
 * ACP_AGENT_DIRS keeps the search for the agents' commands inside the home, so
 * an agent installed on this Mac doesn't count. OpenCode ships after 1.0, so
 * each engine gets ACP_OPENCODE=1 unless a test checks the 1.0 build.
 */

const repoRoot = path.resolve(import.meta.dirname, "..");
const engines: { proc: ChildProcess; home: string }[] = [];

type Agent = { id: string; on: boolean; found: boolean; used: boolean; version: string | null };

async function startEngine(agent: "claude" | "codex" | "opencode", offerOpencode = true) {
  const home = path.join(os.tmpdir(), `acp-one-${agent}-${offerOpencode ? "" : "1.0-"}${process.pid}`);
  fs.rmSync(home, { recursive: true, force: true });
  const { project } = buildOneAgentHome(home, agent);
  const token = randomBytes(12).toString("hex");
  const env: NodeJS.ProcessEnv = { HOME: home, USER: "pat", PATH: "/usr/bin:/bin", ACP_AGENT_DIRS: [path.join(home, ".local/bin"), path.join(home, ".opencode/bin")].join(":"), ACP_PORT: "0", ACP_TOKEN: token, TMPDIR: os.tmpdir() };
  if (process.env.ACP_DOCS) env.ACP_DOCS = process.env.ACP_DOCS;
  if (offerOpencode) env.ACP_OPENCODE = "1";
  const proc = spawn(process.execPath, ["--import", "tsx", path.join(repoRoot, "engine/main.ts")], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  engines.push({ proc, home });
  let stderr = "";
  proc.stderr!.on("data", (d) => (stderr += String(d)));
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The engine didn't start: ${stderr}`)), 20_000);
    proc.stdout!.on("data", (d) => {
      const m = /AgentCP on (http:\/\/127\.0\.0\.1:\d+)/.exec(String(d));
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.once("exit", (code) => reject(new Error(`The engine exited (${code}): ${stderr}`)));
  });
  const call = async <T,>(method: "GET" | "POST", route: string, body?: unknown): Promise<{ status: number; data: T }> => {
    const r = await fetch(`${base}${route}`, { method, headers: { "x-acp-token": token, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: (await r.json()) as T };
  };
  const get = async <T,>(route: string) => (await call<T>("GET", route)).data;
  return { home, project, call, get };
}

afterAll(() => {
  for (const e of engines) {
    e.proc.kill();
    fs.rmSync(e.home, { recursive: true, force: true });
  }
});

describe("a Mac with only Claude Code", () => {
  it("starts with Codex off, and leaves it out of sessions, search and setup", async () => {
    const { project, call, get } = await startEngine("claude");
    const state = await get<{ agents: Agent[] }>("/api/state");
    expect(state.agents.map((a) => [a.id, a.on, a.found, a.used])).toEqual([
      ["claude", true, true, true],
      ["codex", false, false, false],
      ["opencode", false, false, false],
    ]);
    expect(state.agents[0].version).toBe("2.1.290");
    const setup = await get<{ agents: Agent[] }>("/api/setup");
    expect(setup.agents.filter((a) => a.on).map((a) => a.id)).toEqual(["claude"]);

    const sessions = await get<{ sessions: { source: string }[] }>("/api/sessions");
    expect(sessions.sessions.map((s) => s.source)).toEqual(["claude_code"]);
    // Asking for an agent that's off gives nothing, not every agent.
    expect((await get<{ sessions: unknown[] }>("/api/sessions?agent=codex")).sessions).toEqual([]);
    expect((await get<{ totals: { sessions: number } }>("/api/usage?agent=codex")).totals.sessions).toBe(0);

    const hits = await get<{ kind: string; slug?: string; path?: string }[]>(`/api/search?q=claude&project=${encodeURIComponent(project)}`);
    expect(hits.some((h) => h.kind === "doc" && h.slug?.startsWith("codex/"))).toBe(false);

    // Turned on by hand, Codex shows even though it isn't installed; with every agent off, the app refuses.
    await call("POST", "/api/prefs", { agents: ["codex", "claude"] });
    const both = await get<{ agents: Agent[]; prefs: { agents: string[] } }>("/api/state");
    expect(both.prefs.agents).toEqual(["claude", "codex"]);
    expect(both.agents.map((a) => a.on)).toEqual([true, true, false]);
    const refused = await call<{ error: string }>("POST", "/api/prefs", { agents: [] });
    expect(refused.status).toBe(400);
    expect(refused.data.error).toMatch(/at least one agent/);
    expect((await call("POST", "/api/prefs", { agents: ["claude", "cursor"] })).status).toBe(400);
  }, 40_000);
});

describe("a Mac with only Codex", () => {
  it("starts with Claude Code off: no Claude tips, settings or docs in search", async () => {
    const { project, call, get } = await startEngine("codex");
    const state = await get<{ agents: Agent[] }>("/api/state");
    expect(state.agents.filter((a) => a.on).map((a) => a.id)).toEqual(["codex"]);
    expect(state.agents[1]).toMatchObject({ found: true, used: true, version: "0.130.0" });
    // Every tip is a fact about Claude Code.
    expect(await get<unknown[]>("/api/tips")).toEqual([]);

    const hits = await get<{ kind: string; slug?: string; path?: string; agent?: string }[]>(`/api/search?q=agents&project=${encodeURIComponent(project)}`);
    expect(hits.find((h) => h.kind === "file" && h.path === path.join(project, "AGENTS.md"))?.agent).toBe("codex");
    expect(hits.some((h) => h.kind === "setting")).toBe(false);
    expect(hits.filter((h) => h.kind === "doc").every((h) => h.slug?.startsWith("codex/"))).toBe(true);
    expect((await get<{ sessions: { source: string }[] }>("/api/sessions")).sessions.map((s) => s.source)).toEqual(["codex"]);

    // Turning Codex off and Claude Code on swaps them everywhere.
    await call("POST", "/api/prefs", { agents: ["claude"] });
    expect((await get<{ sessions: unknown[] }>("/api/sessions")).sessions).toEqual([]);
    expect((await get<unknown[]>("/api/tips")).length).toBeGreaterThan(0);
  }, 40_000);
});

describe("a Mac with only OpenCode", () => {
  it("finds it in ~/.opencode/bin, turns only it on, and searches only its files and docs", async () => {
    const { project, get } = await startEngine("opencode");
    const state = await get<{ agents: Agent[] }>("/api/state");
    expect(state.agents.filter((a) => a.on).map((a) => a.id)).toEqual(["opencode"]);
    expect(state.agents[2]).toMatchObject({ found: true, used: true, version: "2.0.12" });
    expect(await get<unknown[]>("/api/tips")).toEqual([]);
    const hits = await get<{ kind: string; slug?: string; path?: string; agent?: string }[]>(`/api/search?q=agents&project=${encodeURIComponent(project)}`);
    expect(hits.find((h) => h.kind === "file" && h.path === path.join(project, "AGENTS.md"))?.agent).toBe("opencode");
    expect(hits.filter((h) => h.kind === "doc").every((h) => h.slug?.startsWith("opencode/"))).toBe(true);
    const view = await get<{ entries: { file: { path: string }; loads: string }[] }>(`/api/opencode?project=${encodeURIComponent(project)}`);
    expect(view.entries.filter((e) => e.loads === "read").map((e) => path.basename(e.file.path))).toEqual(["AGENTS.md", "AGENTS.md"]);
    const mcp = await get<{ servers: { name: string; endpoint: string }[] }>(`/api/mcp?agent=opencode&project=${encodeURIComponent(project)}`);
    expect(mcp.servers.map((s) => [s.name, s.endpoint])).toEqual([["docs", "https://docs.example.com/mcp"]]);
    // Its one session, from its database, and nobody else's.
    const sessions = await get<{ sessions: { source: string; title: string }[]; problem: string | null }>("/api/sessions");
    expect(sessions.sessions.map((s) => [s.source, s.title])).toEqual([["opencode", "Add a free-shipping banner"]]);
    expect(sessions.problem).toBeNull();
    const usage = await get<{ totals: { input: number; output: number; sessions: number } }>("/api/usage");
    expect(usage.totals).toMatchObject({ input: 20, output: 90, sessions: 1 });
  }, 40_000);

  it("isn't offered in 1.0: without ACP_OPENCODE the app lists Claude Code and Codex only", async () => {
    const { project, call, get } = await startEngine("opencode", false);
    const state = await get<{ agents: Agent[] }>("/api/state");
    // Neither is installed, so both start on, as on a Mac with no agent.
    expect(state.agents.map((a) => [a.id, a.on])).toEqual([["claude", true], ["codex", true]]);
    expect((await get<{ agents: Agent[] }>("/api/setup")).agents.map((a) => a.id)).toEqual(["claude", "codex"]);
    // A preference naming OpenCode leaves it out.
    expect((await call("POST", "/api/prefs", { agents: ["codex", "opencode"] })).status).toBe(200);
    expect((await get<{ agents: Agent[] }>("/api/state")).agents.filter((a) => a.on).map((a) => a.id)).toEqual(["codex"]);
    const hits = await get<{ kind: string; slug?: string; agent?: string }[]>(`/api/search?q=agents&project=${encodeURIComponent(project)}`);
    expect(hits.some((h) => h.agent === "opencode" || h.slug?.startsWith("opencode/"))).toBe(false);
    expect((await get<{ sessions: unknown[] }>("/api/sessions")).sessions).toEqual([]);
  }, 40_000);
});
