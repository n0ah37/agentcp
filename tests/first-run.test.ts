import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { forget, gitBinary } from "../engine/lib/git.ts";
import { buildHostileHome, restore } from "./fixtures/hostile-home.ts";

/**
 * First run on a Mac that isn't ours: a real engine process, started the way the
 * app starts it from the Finder (launchd's minimal PATH, no CLAUDE_CONFIG_DIR),
 * on a home folder whose every agent file is broken somehow. It goes through
 * setup as the setup window does, then opens every screen for every project it
 * found, for both agents. Nothing may answer with a server error or take longer
 * than a person would wait.
 */

const repoRoot = path.resolve(import.meta.dirname, "..");
const home = path.join(os.tmpdir(), `acp-first-run-${process.pid}`);
const token = randomBytes(12).toString("hex");
const SLOW_MS = 8000;

let engine: ChildProcess;
let base = "";
let locked: string[] = [];
const problems: string[] = [];

async function call(method: "GET" | "POST", route: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  const started = Date.now();
  const r = await fetch(`${base}${route}`, {
    method,
    headers: { "x-acp-token": token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  const took = Date.now() - started;
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    problems.push(`${method} ${route}: not JSON (${r.status}) ${text.slice(0, 120)}`);
  }
  if (r.status >= 500) problems.push(`${method} ${route}: ${r.status} ${text.slice(0, 200)}`);
  if (took > SLOW_MS) problems.push(`${method} ${route}: took ${took} ms`);
  return { status: r.status, data };
}
const get = (route: string) => call("GET", route);
const q = (params: Record<string, string | null | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v!)}`)
    .join("&");

beforeAll(async () => {
  fs.rmSync(home, { recursive: true, force: true });
  ({ locked } = buildHostileHome(home));
  // What a Finder launch gets: launchd's PATH, and none of the shell's variables.
  const env: NodeJS.ProcessEnv = { HOME: home, USER: "newperson", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ACP_PORT: "0", ACP_TOKEN: token, TMPDIR: os.tmpdir() };
  if (process.env.ACP_DOCS) env.ACP_DOCS = process.env.ACP_DOCS;
  engine = spawn(process.execPath, ["--import", "tsx", path.join(repoRoot, "engine/main.ts")], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  engine.stderr!.on("data", (d) => (stderr += String(d)));
  base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`The engine didn't start: ${stderr}`)), 20_000);
    engine.stdout!.on("data", (d) => {
      const m = /AgentCP on (http:\/\/127\.0\.0\.1:\d+)/.exec(String(d));
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    engine.once("exit", (code) => reject(new Error(`The engine exited (${code}): ${stderr}`)));
  });
}, 30_000);

afterAll(() => {
  engine?.kill();
  restore(locked);
  fs.rmSync(home, { recursive: true, force: true });
});

describe("first run on someone else's Mac", () => {
  it("starts with nothing set up", async () => {
    const state = (await get("/api/state")).data as { prefs: { setupDone: string | null; projectRoots: string[]; agents: string[] | null }; agents: { id: string; on: boolean; version: string | null }[] };
    expect(state.prefs.setupDone).toBeNull();
    expect(state.prefs.projectRoots).toEqual([]);
    // Found in ~/.local/bin, where the installers put them, though PATH doesn't name it; both are here, so both are on.
    expect(state.prefs.agents).toBeNull();
    // The engine runs as a release does, without ACP_OPENCODE: OpenCode ships after 1.0.
    expect(state.agents.map((a) => [a.id, a.on, a.version])).toEqual([
      ["claude", true, "2.1.290"],
      ["codex", true, "0.130.0"],
    ]);
    const setup = (await get("/api/setup")).data as { agents: { id: string; found: boolean; used: boolean; on: boolean }[] };
    expect(setup.agents.map((a) => [a.id, a.found, a.used, a.on])).toEqual([
      ["claude", true, true, true],
      ["codex", true, true, true],
    ]);
    expect(problems).toEqual([]);
  });

  it("searches the home folder and finds the projects in ~/code", async () => {
    await call("POST", "/api/scan", {});
    let scan: { running: boolean; error: string | null; folders: { path: string; projects: number }[] };
    const until = Date.now() + 30_000;
    do {
      await new Promise((r) => setTimeout(r, 200));
      scan = (await get("/api/scan")).data as typeof scan;
    } while (scan.running && Date.now() < until);
    expect(scan.running).toBe(false);
    expect(scan.error).toBeNull();
    const code = scan.folders.find((f) => f.path === path.join(home, "code"));
    expect(code?.projects).toBeGreaterThanOrEqual(9);
    // Setup keeps the folders it found, then finishes.
    await call("POST", "/api/prefs", { projectRoots: scan.folders.map((f) => f.path) });
    await call("POST", "/api/prefs", { setupDone: new Date().toISOString() });
    expect(problems).toEqual([]);
  }, 40_000);

  it("opens every screen, for every project and both agents, without a server error", async () => {
    const projects = (await get("/api/projects")).data as { path: string }[];
    expect(projects.length).toBeGreaterThanOrEqual(9);
    const files = new Set<string>();
    for (const p of [null, ...projects.map((x) => x.path)]) {
      for (const agent of ["claude", "codex"]) {
        const instructions = (await get(`/api/instructions?${q({ project: p, agent })}`)).data as { entries?: { file: { path: string } }[] };
        for (const e of instructions.entries ?? []) files.add(JSON.stringify([e.file.path, p, agent]));
        await get(`/api/instructions/combined?${q({ project: p })}`);
        await get(`/api/hooks?${q({ project: p, agent })}`);
        await get(`/api/mcp?${q({ project: p, agent })}`);
        await get(`/api/plugins?${q({ project: p })}`);
        await get(`/api/settings?${q({ project: p })}`);
        await get(`/api/memory?${q({ project: p })}`);
        for (const kind of ["agent", "style", "skill"]) {
          const defs = (await get(`/api/definitions?${q({ kind, project: p, agent })}`)).data as { items?: { path?: string; file?: { path: string } }[] };
          for (const d of defs.items ?? []) {
            const f = d.path ?? d.file?.path;
            if (f) files.add(JSON.stringify([f, p, agent]));
          }
        }
        await get(`/api/sessions?${q({ project: p, agent })}`);
        await get(`/api/usage?${q({ project: p, agent })}`);
        await get(`/api/search?${q({ project: p, q: "cl" })}`);
      }
      await get(`/api/codex?${q({ project: p })}`);
      await get(`/api/codex/settings?${q({ project: p })}`);
      await get(`/api/codex/rules?${q({ project: p })}`);
    }
    for (const route of ["/api/codex/memories", "/api/plugins/available", "/api/tips", "/api/history", "/api/licenses", "/api/memory?folder=" + encodeURIComponent(home)]) await get(route);

    // Every file a screen listed opens, is checked and gets a Write with AI prompt.
    for (const f of files) {
      const [file, p, agent] = JSON.parse(f) as [string, string | null, string];
      const view = (await get(`/api/file?${q({ path: file, project: p, agent })}`)).data as { text?: string | null };
      await call("POST", "/api/check", { path: file, project: p, text: view?.text ?? "", agent });
      await call("POST", "/api/prompt", { path: file, project: p, agent });
    }
    expect(files.size).toBeGreaterThan(20);

    // Every session the files hold opens.
    for (const agent of ["claude", "codex"]) {
      const { sessions } = (await get(`/api/sessions?${q({ agent })}`)).data as { sessions: { id: string }[] };
      for (const s of sessions) await get(`/api/session?${q({ id: s.id })}`);
    }
    expect(problems).toEqual([]);
  }, 180_000);

  it("shows a file it can't read as there and locked, and never writes over it", async () => {
    const shut = path.join(home, "code", "no-read");
    const view = (await get(`/api/instructions?${q({ project: shut })}`)).data as { entries: { file: { path: string; exists: boolean; editable: boolean; lockedBecause: string | null } }[] };
    const file = view.entries.find((e) => e.file.path === path.join(shut, "CLAUDE.md"))?.file;
    expect(file).toMatchObject({ exists: true, editable: false });
    expect(file?.lockedBecause).toMatch(/isn't allowed to read/);
    const plan = (await call("POST", "/api/plan", { path: path.join(shut, "CLAUDE.md"), content: "# replaced\n", baseHash: null, project: shut })).data as { refusal: string | null };
    expect(plan.refusal).toMatch(/isn't allowed to read/);
    expect(file).toMatchObject({ unreadable: true });
    expect(problems).toEqual([]);
  });

  it("says when a file is broken instead of showing it as empty", async () => {
    const app = path.join(home, "code", "my app");
    const claude = (await get(`/api/mcp?${q({ project: app })}`)).data as { files: { display: string; broken: string | null }[] };
    expect(claude.files.find((f) => f.display === "~/code/my app/.mcp.json")?.broken).toBe("isn't valid JSON");
    const codex = (await get(`/api/mcp?${q({ project: app, agent: "codex" })}`)).data as { files: { display: string; broken: string | null }[] };
    expect(codex.files.find((f) => f.display === "~/.codex/config.toml")?.broken).toBe("isn't valid TOML");
    // A session line whose time isn't a date leaves the time out, rather than "Invalid Date".
    const { sessions } = (await get("/api/sessions")).data as { sessions: { startedAt: string | null; endedAt: string | null }[] };
    expect(sessions.length).toBeGreaterThan(0);
    for (const s of sessions) for (const t of [s.startedAt, s.endedAt]) if (t) expect(Number.isNaN(new Date(t).getTime())).toBe(false);
    // A plugin whose manifest name isn't text goes by its folder's name.
    const plugins = (await get("/api/plugins")).data as { plugins: { id: string }[] };
    expect(plugins.plugins.map((p) => p.id)).toContain("odd@synced");
    expect(problems).toEqual([]);
  });
});

describe("a Mac without Apple's command line tools", () => {
  it("never runs the /usr/bin/git stand-in, which would open an install dialog", () => {
    if (process.platform !== "darwin") return;
    const saved = { PATH: process.env.PATH, DEVELOPER_DIR: process.env.DEVELOPER_DIR };
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "acp-no-clt-"));
    try {
      process.env.PATH = "/usr/bin:/bin";
      process.env.DEVELOPER_DIR = empty; // what xcode-select points at when the tools are gone
      forget();
      expect(gitBinary()).toBeNull();
      // With the tools there, the same git runs.
      delete process.env.DEVELOPER_DIR;
      forget();
      const dev = (() => {
        try {
          return execFileSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8" }).trim();
        } catch {
          return null;
        }
      })();
      if (dev && fs.existsSync(path.join(dev, "usr/bin/git"))) expect(gitBinary()).toBe("/usr/bin/git");
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.DEVELOPER_DIR === undefined) delete process.env.DEVELOPER_DIR;
      else process.env.DEVELOPER_DIR = saved.DEVELOPER_DIR;
      fs.rmSync(empty, { recursive: true, force: true });
      forget();
    }
  });
});
