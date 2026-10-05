import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { AgentCommand, AppState, Fix, Preferences, SearchHit, SettingScope } from "../shared/types.ts";
import { agentStatus, enabledAgents, sessionSources } from "./lib/agents.ts";
import { codexAgents, codexMemories, codexRules, codexSettings, codexSkills, codexView, planCodexSettings, sharePlan } from "./lib/codex.ts";
import { aiPrompt } from "./lib/prompt.ts";
import { opencodeAgents, opencodeCommands, opencodeMcp, opencodePlugins, opencodeSettings, opencodeSkills, opencodeView } from "./lib/opencode.ts";
import { AGENT_NAMES, isAgentId } from "../shared/agents.ts";
import { definitionsView, pairSkills } from "./lib/definitions.ts";
import { docsInfo, page, searchDocs, updateDocs } from "./lib/docs.ts";
import { fileView } from "./lib/files.ts";
import { readText } from "./lib/fsx.ts";
import { combinedView, instructionsView, resolveStack } from "./lib/instructions.ts";
import { memoryDir, memoryFolders, memoryView } from "./lib/memory.ts";
import { APP_DIR, CLAUDE_DIR, HOME, REPO_ROOT, expandHome, tilde } from "./lib/paths.ts";
import { getPrefs, setPrefs } from "./lib/prefs.ts";
import { listProjects, projectRef } from "./lib/projects.ts";
import { planSetting, settingsCatalog, settingsView } from "./lib/settings.ts";
import { ASK_FIRST, scanAskFirst, scanFolder, scanHome, scanState } from "./lib/scan.ts";
import { hooksView, planHook } from "./lib/hooks.ts";
import { availablePlugins, describe as describeCommand, runCommand } from "./lib/agent-commands.ts";
import { claudeMcp, codexMcp, planMcp, type McpChange } from "./lib/mcp.ts";
import { pluginsView } from "./lib/plugins.ts";
import { setupView } from "./lib/setup.ts";
import { fileSession, fileSessions, openCodeStore, usageView } from "./lib/transcripts-client.ts";
import { tips } from "./lib/tips.ts";
import { announce, watchBase, watchCount, watchFile, watchProject } from "./lib/watch.ts";
import { WriteError, applyRename, applyWrite, historySnapshot, listHistory, planRename, planWrite } from "./lib/write.ts";
import { HttpError, type Handler } from "./server.ts";

// The version and build number in package.json, which the packaged app carries at its root.
const PKG = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string; build?: { buildVersion?: string } };

function str(url: URL, key: string): string | null {
  const v = url.searchParams.get(key);
  return v && v.trim() ? v : null;
}

function need<T>(v: T | null | undefined, what: string): T {
  if (v === null || v === undefined || v === "") throw new HttpError(400, `Missing ${what}.`);
  return v;
}

async function project(p: string | null) {
  const ref = await projectRef(p);
  if (ref) watchProject(ref.path, (await memoryDir(ref.path)).dir);
  return ref;
}

async function extraRootsFor(p: string | null): Promise<string[]> {
  return p ? [(await memoryDir(path.resolve(expandHome(p)))).dir] : [];
}

export const routes: Record<string, Handler> = {
  "GET /api/state": async (): Promise<AppState> => {
    watchBase();
    const prefs = await getPrefs();
    return {
      version: PKG.version,
      build: PKG.build?.buildVersion ?? null,
      prefs,
      docs: docsInfo(),
      agents: await agentStatus(prefs),
      home: tilde(process.env.HOME ?? "~"),
      appDir: APP_DIR,
      watching: watchCount(),
    };
  },

  "GET /api/projects": async () => listProjects(),

  "GET /api/instructions": async ({ url }) => {
    const ref = await project(str(url, "project"));
    const view = await instructionsView(ref);
    for (const e of view.entries) watchFile(e.file.path);
    return view;
  },

  "GET /api/instructions/combined": async ({ url }) => combinedView(await project(str(url, "project"))),

  "GET /api/setup": async () => setupView(),

  "GET /api/scan": async () => scanState(),

  // Every tip is a fact from Claude Code's documentation.
  "GET /api/tips": async () => ((await enabledAgents()).includes("claude") ? tips() : []),

  "GET /api/hooks": async ({ url }) => {
    const ref = await project(str(url, "project"));
    return hooksView(str(url, "agent") === "codex" ? "codex" : "claude", ref?.path ?? null);
  },

  "POST /api/hooks/plan": async ({ body }) => {
    const b = (body ?? {}) as Parameters<typeof planHook>[0];
    if (!b.file || !b.event) throw new HttpError(400, "file and event are needed.");
    try {
      return await planHook(b);
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  },

  "GET /api/codex": async ({ url }) => codexView(await project(str(url, "project"))),

  "GET /api/opencode": async ({ url }) => {
    const view = await opencodeView(await project(str(url, "project")));
    for (const e of view.entries) watchFile(e.file.path);
    for (const l of view.layers) watchFile(l.path);
    return view;
  },

  "GET /api/opencode/settings": async ({ url }) => {
    const view = await opencodeSettings(await project(str(url, "project")), docsInfo().opencode.capturedAt);
    for (const l of view.layers) watchFile(l.path);
    return view;
  },

  "GET /api/codex/settings": async ({ url }) => codexSettings(await project(str(url, "project"))),

  "GET /api/codex/memories": async () => codexMemories(),

  "GET /api/codex/rules": async ({ url }) => codexRules(await project(str(url, "project"))),

  "POST /api/codex/settings/plan": async ({ body }) => {
    const b = (body ?? {}) as { project: string | null; scope: "user" | "project"; sets: { key: string; value: unknown }[] };
    if (!Array.isArray(b.sets) || !b.sets.length) throw new HttpError(400, "sets is needed.");
    try {
      return await planCodexSettings({ project: await projectRef(b.project), scope: b.scope === "project" ? "project" : "user", sets: b.sets });
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  },

  // A prompt to paste into Claude Code or Codex, for help with one file. Nothing is started here.
  "POST /api/prompt": async ({ body }) => {
    const b = (body ?? {}) as { path?: string; project?: string | null; agent?: string };
    return aiPrompt({ path: need(b.path, "path"), project: await projectRef(b.project ?? null), agent: isAgentId(b.agent) ? b.agent : "claude" });
  },

  "POST /api/codex/share": async ({ body }) => {
    const ref = await projectRef((body as { project?: string } | null)?.project ?? null);
    if (!ref) throw new HttpError(400, "Choose a project to share.");
    try {
      return await sharePlan(ref);
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
  },

  // No folder: search the home folder. Documents, Desktop or Downloads: search
  // that one, after macOS asks. Any other path: a folder the person chose.
  "POST /api/scan": async ({ body }) => {
    const folder = (body as { folder?: unknown } | null)?.folder;
    if (folder === undefined || folder === null) return scanHome();
    if (typeof folder !== "string" || !folder) throw new HttpError(400, "folder must be a path.");
    if ((ASK_FIRST as readonly string[]).includes(folder)) return scanAskFirst(folder);
    if (!path.isAbsolute(expandHome(folder))) throw new HttpError(400, "Choose a folder by its full path.");
    return scanFolder(folder);
  },

  // Sessions come from the agents' own session files, read directly and only read.
  "GET /api/sessions": async ({ url }) => {
    const p = str(url, "project");
    const project = p ? path.resolve(expandHome(p)) : null;
    const limit = Number(str(url, "limit") ?? 200);
    const sources = await sessionSources(str(url, "agent"));
    const view = await fileSessions({ project, q: str(url, "q"), sources, limit });
    return { ...view, problem: sources.includes("opencode") ? (await openCodeStore()).problem : null };
  },

  "GET /api/session": async ({ url }) => {
    const s = await fileSession(need(str(url, "id"), "id"));
    if (!s) throw new HttpError(404, "That session couldn't be found.");
    return s;
  },

  "GET /api/usage": async ({ url }) => {
    const p = str(url, "project");
    const days = Math.min(366, Math.max(1, Number(str(url, "days") ?? 90)));
    const sources = await sessionSources(str(url, "agent"));
    const view = await usageView({ days, sources, project: p ? path.resolve(expandHome(p)) : null });
    return { ...view, problem: sources.includes("opencode") ? (await openCodeStore()).problem : null };
  },

  "GET /api/file": async ({ url }) => {
    const p = need(str(url, "path"), "path");
    watchFile(path.resolve(expandHome(p)));
    return fileView(p, await project(str(url, "project")), undefined, str(url, "agent"));
  },

  "POST /api/check": async ({ body }) => {
    const b = body as { path: string; project: string | null; text: string; agent?: string | null };
    return (await fileView(need(b?.path, "path"), await projectRef(b.project), b.text, b.agent ?? null)).findings;
  },

  "POST /api/plan": async ({ body }) => {
    const b = body as { path: string; content: string | null; baseHash: string | null; project: string | null };
    return planWrite({ path: need(b?.path, "path"), content: b.content, baseHash: b.baseHash ?? null, extraRoots: await extraRootsFor(b.project) });
  },

  "POST /api/save": async ({ body }) => {
    const b = body as { path: string; content: string | null; baseHash: string | null; project: string | null };
    const r = await applyWrite({ path: need(b?.path, "path"), content: b.content, baseHash: b.baseHash ?? null, extraRoots: await extraRootsFor(b.project) });
    announce([r.path]);
    return r;
  },

  "POST /api/rename/plan": async ({ body }) => {
    const b = body as { from: string; name: string; project: string | null };
    return planRename({ from: need(b?.from, "from"), name: b.name ?? "", extraRoots: await extraRootsFor(b.project) });
  },

  "POST /api/rename": async ({ body }) => {
    const b = body as { from: string; name: string; baseHash: string | null; project: string | null };
    const r = await applyRename({ from: need(b?.from, "from"), name: b.name ?? "", baseHash: b.baseHash ?? null, extraRoots: await extraRootsFor(b.project) });
    announce([r.from, r.to]);
    return r;
  },

  "POST /api/fix/plan": async ({ body }) => {
    const b = body as { fix: Fix; project: string | null };
    const fix = need(b?.fix, "fix");
    if (fix.kind === "gitignore") {
      const file = path.join(fix.repo, ".gitignore");
      const cur = await readText(file);
      const text = cur?.text ?? "";
      if (text.split("\n").some((l) => l.trim() === fix.entry || l.trim() === `/${fix.entry}`)) {
        throw new HttpError(409, `.gitignore already lists ${fix.entry}.`);
      }
      const content = text + (text && !text.endsWith("\n") ? "\n" : "") + fix.entry + "\n";
      return { plan: await planWrite({ path: file, content, baseHash: cur?.hash ?? null }), content, baseHash: cur?.hash ?? null };
    }
    if (fix.kind === "setting") {
      const cur = await readText(settingsFile(b.project, fix.scope));
      const { plan, content } = await planSetting(b.project, fix.scope, fix.path, fix.value, cur?.hash ?? null);
      return { plan, content, baseHash: cur?.hash ?? null };
    }
    throw new HttpError(400, "That fix is applied in the editor.");
  },

  // A project's memory; with none open, the list of every folder Claude keeps memory for, and
  // `folder` reads one of them (the home folder's by default) without making it the project.
  "GET /api/memory": async ({ url }) => {
    const folder = str(url, "folder");
    if (folder) {
      const ref = await projectRef(folder);
      if (ref) watchFile(path.join((await memoryDir(ref.path)).dir, "_"));
      return ref ? memoryView(ref) : null;
    }
    const ref = await project(str(url, "project"));
    if (!ref) return { folders: await memoryFolders(), home: HOME };
    return memoryView(ref);
  },

  "GET /api/definitions": async ({ url }) => {
    const kind = need(str(url, "kind"), "kind") as "agent" | "style" | "skill" | "command" | "plugin";
    if (!["agent", "style", "skill", "command", "plugin"].includes(kind)) throw new HttpError(400, "Unknown kind.");
    if ((kind === "command" || kind === "plugin") && str(url, "agent") !== "opencode") throw new HttpError(400, "Commands and plugins are listed for OpenCode here.");
    const ref = await project(str(url, "project"));
    if (kind !== "style" && str(url, "agent") === "opencode") {
      const oc = kind === "agent" ? await opencodeAgents(ref) : kind === "command" ? await opencodeCommands(ref) : kind === "plugin" ? await opencodePlugins(ref) : await opencodeSkills(ref);
      for (const l of oc.locations) watchFile(path.join(l.path, "_"));
      return { project: ref, kind, ...oc };
    }
    if (kind === "agent" && str(url, "agent") === "codex") {
      const codex = await codexAgents(ref);
      for (const l of codex.locations) watchFile(path.join(l.path, "_"));
      return { project: ref, kind, ...codex };
    }
    if (kind === "skill" && str(url, "agent") === "codex") {
      const codex = await codexSkills(ref);
      for (const l of codex.locations) watchFile(path.join(l.path, "_"));
      await pairSkills(codex.items, (await definitionsView("skill", ref)).items, "claude");
      return { project: ref, kind, ...codex };
    }
    // Commands and plugins were OpenCode's, above; what's left is Claude Code's or Codex's.
    const view = await definitionsView(kind as "agent" | "style" | "skill", ref);
    for (const l of view.locations) watchFile(path.join(l.path, "_"));
    if (kind === "skill") await pairSkills(view.items, (await codexSkills(ref)).items, "codex");
    return view;
  },

  "GET /api/plugins": async ({ url }) => {
    const ref = await project(str(url, "project"));
    return pluginsView(ref);
  },

  "GET /api/plugins/available": async () => availablePlugins(),

  // A Claude Code command for plugins and its MCP servers: described first, then run.
  "POST /api/agent/command": async ({ body }) => {
    const b = body as { project: string | null; command: AgentCommand; run?: boolean };
    const ref = b.project ? await projectRef(b.project) : null;
    if (!b.run) return describeCommand(b.command, ref);
    const result = await runCommand(b.command, ref);
    announce([ref?.path ?? CLAUDE_DIR]);
    return result;
  },

  "POST /api/mcp/plan": async ({ body }) => {
    const b = body as { project: string | null; change: McpChange };
    const ref = b.project ? await projectRef(b.project) : null;
    const { path: p, content, baseHash } = await planMcp(ref, b.change);
    return { plan: await planWrite({ path: p, content, baseHash }), content, baseHash };
  },

  "GET /api/mcp": async ({ url }) => {
    const ref = await project(str(url, "project"));
    if (ref) watchFile(path.join(ref.path, ".mcp.json"));
    const agent = str(url, "agent");
    return agent === "codex" ? codexMcp(ref) : agent === "opencode" ? opencodeMcp(ref) : claudeMcp(ref);
  },

  "GET /api/settings": async ({ url }) => {
    const ref = await project(str(url, "project"));
    return { project: ref, ...(await settingsView(ref?.path ?? null)) };
  },

  "POST /api/settings/plan": async ({ body }) => {
    const b = body as { project: string | null; scope: SettingScope; path: string[]; value: unknown };
    const ref = await projectRef(b.project);
    const target = settingsFile(ref?.path ?? null, b.scope);
    const cur = await readText(target);
    const { plan, content } = await planSetting(ref?.path ?? null, b.scope, need(b.path, "path"), b.value, cur?.hash ?? null);
    return { plan, content, baseHash: cur?.hash ?? null };
  },

  // The open-source packages built into the app, written by scripts/licenses.mjs at build time.
  "GET /api/licenses": async () => {
    try {
      return JSON.parse(await fs.readFile(path.join(REPO_ROOT, "dist", "licenses.json"), "utf8")) as unknown[];
    } catch {
      return [];
    }
  },

  "GET /api/license": async () => ({ text: await fs.readFile(path.join(REPO_ROOT, "LICENSE"), "utf8").catch(() => "") }),

  "GET /api/history": async () => listHistory(),

  "GET /api/history/entry": async ({ url }) => {
    const { entry, text } = await historySnapshot(need(str(url, "id"), "id"));
    const cur = await readText(entry.path);
    return { entry, before: text, current: cur?.text ?? null, currentHash: cur?.hash ?? null };
  },

  "POST /api/history/restore": async ({ body }) => {
    const b = body as { id: string; baseHash: string | null };
    const { entry, text } = await historySnapshot(need(b?.id, "id"));
    // Putting back the version before a create means removing the file again.
    const r = await applyWrite({ path: entry.path, content: text, baseHash: b.baseHash ?? null, action: "restore", extraRoots: [path.dirname(entry.path)] });
    announce([r.path]);
    return r;
  },

  "GET /api/docs/page": async ({ url }) => {
    const p = page(need(str(url, "slug"), "slug"));
    if (!p) throw new HttpError(404, "That page isn't in the downloaded documentation.");
    return p;
  },

  "GET /api/docs/search": async ({ url }) => searchDocs(str(url, "q") ?? ""),

  "POST /api/docs/update": async () => {
    try {
      return await updateDocs();
    } catch (e) {
      throw new HttpError(502, `The documentation couldn't be downloaded: ${(e as Error).message.split("\n")[0]}`);
    }
  },

  "GET /api/prefs": async () => getPrefs(),

  "POST /api/prefs": async ({ body }) => {
    const patch = (body ?? {}) as Partial<Preferences>;
    const allowed: (keyof Preferences)[] = ["allowEdits", "appearance", "projectRoots", "skipFolders", "showWorktrees", "lastProject", "setupDone", "showTips", "formatted", "sessions", "checkUpdates", "agents"];
    const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k as keyof Preferences)));
    try {
      return await setPrefs(clean);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  },

  "GET /api/search": async ({ url }) => {
    const q = (str(url, "q") ?? "").toLowerCase();
    if (q.length < 2) return [];
    const hits: SearchHit[] = [];
    const ref = await projectRef(str(url, "project"));
    // Only the agents that are on: their instruction files, settings, sessions and documentation.
    const on = await enabledAgents();
    if (on.includes("claude")) {
      for (const e of (await resolveStack(ref)).entries) {
        if (e.file.display.toLowerCase().includes(q)) hits.push({ kind: "file", label: e.file.name, detail: e.file.display, path: e.file.path, route: "instructions" });
      }
    }
    if (on.includes("codex")) {
      for (const e of (await codexView(ref)).entries) {
        if (e.file.display.toLowerCase().includes(q)) hits.push({ kind: "file", label: e.file.name, detail: e.file.display, path: e.file.path, route: "instructions", agent: "codex" });
      }
    }
    if (on.includes("opencode")) {
      const seen = new Set(hits.map((h) => (h.kind === "file" ? h.path : "")));
      for (const e of (await opencodeView(ref)).entries) {
        if (!seen.has(e.file.path) && e.file.display.toLowerCase().includes(q)) hits.push({ kind: "file", label: e.file.name, detail: e.file.display, path: e.file.path, route: "instructions", agent: "opencode" });
      }
    }
    for (const p of await listProjects()) {
      if (p.name.toLowerCase().includes(q) || p.display.toLowerCase().includes(q)) hits.push({ kind: "project", label: p.name, detail: p.display, path: p.path });
      if (hits.length > 40) break;
    }
    if ((await getPrefs()).sessions) {
      for (const s of (await fileSessions({ project: null, q, sources: await sessionSources(null), limit: 8 })).sessions) hits.push({ kind: "session", label: s.title, detail: [s.projectDisplay, s.endedAt ? new Date(s.endedAt).toLocaleDateString("en-CA") : null].filter(Boolean).join(" · "), id: s.id });
    }
    if (on.includes("claude")) {
      for (const s of settingsCatalog().entries) {
        if (s.key.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)) hits.push({ kind: "setting", label: s.key, detail: s.description, key: s.key, route: "settings" });
      }
    }
    const corpus = (slug: string) => (slug.startsWith("codex/") ? "codex" : slug.startsWith("opencode/") ? "opencode" : "claude");
    for (const d of searchDocs(q, 12).filter((d) => on.includes(corpus(d.slug)))) hits.push({ kind: "doc", label: d.heading ?? d.title, detail: d.heading ? d.title : `${AGENT_NAMES[corpus(d.slug)]} docs`, slug: d.slug, anchor: d.anchor });
    return hits.slice(0, 60);
  },
};

function settingsFile(projectPath: string | null, scope: SettingScope): string {
  if (scope === "user") return path.join(CLAUDE_DIR, "settings.json");
  if (!projectPath) throw new WriteError("Choose a project first.", 400, "refused");
  return path.join(projectPath, ".claude", scope === "local" ? "settings.local.json" : "settings.json");
}

