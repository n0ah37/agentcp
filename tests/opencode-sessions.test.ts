import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { openCodeDb, openCodeStore } from "../engine/lib/opencode-sessions.ts";
import { HOME } from "../engine/lib/paths.ts";
import { fileSession, fileSessions, forgetTranscripts, usageView } from "../engine/lib/transcripts.ts";

/**
 * OpenCode's sessions from made-up opencode.db files in the test home: one laid
 * out the way OpenCode 1.18 lays it out (packages/core/src/session/sql.ts at
 * v1.18.34), one the way 2.x does (the same file at v2.0.12, and
 * packages/schema/src/session-message.ts for what a row holds). Nothing here
 * reads a real database: vitest.config.ts points HOME and XDG_DATA_HOME at a
 * throwaway folder and clears OPENCODE_DB.
 */

const P = path.join(HOME, "Dev", "shop");
const DATA = path.join(HOME, ".local", "share", "opencode");
const DB = path.join(DATA, "opencode.db");
const SCRATCH = path.join(HOME, "opencode-scratch");
const min = (n: number) => Date.now() - n * 60_000;

/** The tables OpenCode's first database migration creates, with `without` left out to make a layout AgentCP doesn't know. */
function createDb(file: string, without?: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  const table = (name: string, cols: string[]) => db.exec(`CREATE TABLE ${name} (${cols.filter((c) => c.split(" ")[0] !== without).join(", ")})`);
  table("project", ["id text PRIMARY KEY", "worktree text NOT NULL", "time_created integer NOT NULL", "time_updated integer NOT NULL", "sandboxes text NOT NULL"]);
  table("session", [
    "id text PRIMARY KEY", "project_id text NOT NULL", "parent_id text", "slug text NOT NULL", "directory text NOT NULL", "title text NOT NULL", "version text NOT NULL",
    "cost real NOT NULL DEFAULT 0", "tokens_input integer NOT NULL DEFAULT 0", "tokens_output integer NOT NULL DEFAULT 0", "tokens_reasoning integer NOT NULL DEFAULT 0",
    "tokens_cache_read integer NOT NULL DEFAULT 0", "tokens_cache_write integer NOT NULL DEFAULT 0", "agent text", "model text",
    "time_created integer NOT NULL", "time_updated integer NOT NULL", "time_compacting integer", "time_archived integer",
  ]);
  table("message", ["id text PRIMARY KEY", "session_id text NOT NULL", "time_created integer NOT NULL", "time_updated integer NOT NULL", "data text NOT NULL"]);
  table("part", ["id text PRIMARY KEY", "message_id text NOT NULL", "session_id text NOT NULL", "time_created integer NOT NULL", "time_updated integer NOT NULL", "data text NOT NULL"]);
  db.exec("CREATE INDEX part_session_idx ON part (session_id)");
  db.prepare("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('prj', ?, 0, 0, '[]')").run(P);
  return db;
}

let seq = 0;
const next = (prefix: string) => `${prefix}_${String(++seq).padStart(6, "0")}`;
type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } };

function addSession(db: DatabaseSync, s: { id: string; title: string; created: number; updated: number; parent?: string; archived?: number; directory?: string }) {
  db.prepare("INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, model, time_created, time_updated, time_archived) VALUES (?, 'prj', ?, 'slug', ?, ?, '1.18.34', ?, ?, ?, ?)").run(
    s.id, s.parent ?? null, s.directory ?? P, s.title, JSON.stringify({ id: "claude-sonnet-4-5", providerID: "anthropic" }), s.created, s.updated, s.archived ?? null,
  );
}

function addMessage(db: DatabaseSync, session: string, at: number, data: object): string {
  const id = next("msg");
  db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run(id, session, at, at, JSON.stringify(data));
  return id;
}

function addPart(db: DatabaseSync, session: string, message: string, at: number, data: object) {
  db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)").run(next("prt"), message, session, at, at, JSON.stringify(data));
}

const user = (at: number) => ({ role: "user", time: { created: at }, agent: "build", model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" } });
const assistant = (at: number, modelID: string, tokens: Tokens) => ({ role: "assistant", time: { created: at, completed: at }, modelID, providerID: "anthropic", mode: "build", agent: "build", path: { cwd: P, root: P }, cost: 0.01, tokens });
const text = (t: string, extra: object = {}) => ({ type: "text", text: t, ...extra });
const tool = (name: string, input: object) => ({ type: "tool", callID: next("call"), tool: name, state: { status: "completed", input, output: "ok", title: name, metadata: {}, time: { start: 1, end: 2 } } });
const finish = (tokens: Tokens) => ({ type: "step-finish", reason: "stop", cost: 0.005, tokens });
const tokens = (input: number, output: number, reasoning: number, read: number, write: number): Tokens => ({ input, output, reasoning, cache: { read, write } });

const STEP1 = tokens(100, 40, 10, 1000, 500);
const STEP2 = tokens(7, 30, 5, 2000, 0);

/** OpenCode, still running: the database stays open for writing while AgentCP reads it. */
let live: DatabaseSync;

beforeAll(() => {
  live = createDb(DB);
  // A session you worked in: one typed prompt, an injected one, two model calls.
  addSession(live, { id: "ses_top", title: "Fix the checkout total", created: min(60), updated: min(30) });
  const u1 = addMessage(live, "ses_top", min(60), user(min(60)));
  addPart(live, "ses_top", u1, min(60), text("The checkout total is off by a cent"));
  addPart(live, "ses_top", u1, min(60), text("Called the Read tool with the following input: src/total.ts", { synthetic: true }));
  // The assistant message's own tokens are its last model call's only.
  const a1 = addMessage(live, "ses_top", min(59), assistant(min(59), "claude-sonnet-4-5", STEP2));
  addPart(live, "ses_top", a1, min(59), { type: "step-start" });
  addPart(live, "ses_top", a1, min(59), text("Looking at the cart."));
  addPart(live, "ses_top", a1, min(59), tool("edit", { filePath: path.join(P, "src/total.ts"), oldString: "a", newString: "b" }));
  addPart(live, "ses_top", a1, min(58), tool("bash", { command: "pnpm test", description: "Run the tests" }));
  addPart(live, "ses_top", a1, min(58), finish(STEP1));
  addPart(live, "ses_top", a1, min(58), { type: "step-start" });
  addPart(live, "ses_top", a1, min(57), tool("apply_patch", { patchText: "*** Begin Patch\n*** Update File: src/total.ts\n@@\n-a\n+b\n*** Add File: src/round.ts\n+export {}\n*** End Patch" }));
  addPart(live, "ses_top", a1, min(57), tool("task", { description: "Check rounding", prompt: "Look for rounding", subagent_type: "explore" }));
  addPart(live, "ses_top", a1, min(57), tool("skill", { name: "money" }));
  addPart(live, "ses_top", a1, min(56), text("Fixed: the total rounded twice."));
  addPart(live, "ses_top", a1, min(56), finish(STEP2));
  // Something OpenCode put in the conversation itself: not a prompt.
  const u2 = addMessage(live, "ses_top", min(31), user(min(31)));
  addPart(live, "ses_top", u2, min(31), text("The following tool was executed by the user", { synthetic: true }));

  // The subagent the task started: its own session, pointing at the first.
  addSession(live, { id: "ses_child", parent: "ses_top", title: "Check rounding (@explore subagent)", created: min(57), updated: min(57) });
  const cu = addMessage(live, "ses_child", min(57), user(min(57)));
  addPart(live, "ses_child", cu, min(57), text("Look for rounding"));
  const ca = addMessage(live, "ses_child", min(57), assistant(min(57), "claude-haiku-4-5", tokens(50, 20, 0, 300, 0)));
  addPart(live, "ses_child", ca, min(57), finish(tokens(50, 20, 0, 300, 0)));

  // One you archived.
  addSession(live, { id: "ses_arch", title: "An old idea", created: min(50), updated: min(20), archived: min(20) });
  const au = addMessage(live, "ses_arch", min(50), user(min(50)));
  addPart(live, "ses_arch", au, min(50), text("Try a coupon engine"));
  const aa = addMessage(live, "ses_arch", min(50), assistant(min(50), "claude-sonnet-4-5", tokens(1, 2, 0, 0, 0)));
  addPart(live, "ses_arch", aa, min(50), finish(tokens(1, 2, 0, 0, 0)));

  // One OpenCode hasn't named yet, and one with nothing typed in it.
  addSession(live, { id: "ses_new", title: "New session - 2026-10-03T10:00:00.000Z", created: min(10), updated: min(10) });
  const nu = addMessage(live, "ses_new", min(10), user(min(10)));
  addPart(live, "ses_new", nu, min(10), text("Rename the cart module"));
  addSession(live, { id: "ses_quiet", title: "Nothing typed", created: min(5), updated: min(5) });
  const qu = addMessage(live, "ses_quiet", min(5), user(min(5)));
  addPart(live, "ses_quiet", qu, min(5), text("The following tool was executed by the user", { synthetic: true }));
  forgetTranscripts();
});

afterAll(() => {
  live.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  forgetTranscripts();
});

const env = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, OPENCODE_DB: process.env.OPENCODE_DB };
afterEach(() => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  forgetTranscripts();
});

describe("OpenCode's sessions", () => {
  it("finds the database where OpenCode does", () => {
    expect(openCodeDb()).toBe(DB);
    delete process.env.XDG_DATA_HOME;
    expect(openCodeDb()).toBe(path.join(HOME, ".local", "share", "opencode", "opencode.db"));
    process.env.XDG_DATA_HOME = path.join(SCRATCH, "data");
    expect(openCodeDb()).toBe(path.join(SCRATCH, "data", "opencode", "opencode.db"));
    process.env.OPENCODE_DB = "work.db";
    expect(openCodeDb()).toBe(path.join(SCRATCH, "data", "opencode", "work.db"));
    process.env.OPENCODE_DB = path.join(SCRATCH, "elsewhere.db");
    expect(openCodeDb()).toBe(path.join(SCRATCH, "elsewhere.db"));
    process.env.OPENCODE_DB = ":memory:";
    expect(openCodeDb()).toBeNull();
  });

  it("lists the sessions you worked in, counting only what you typed", async () => {
    const { sessions } = await fileSessions({ project: P, q: null, sources: ["opencode"] });
    // Not the subagent's session, not the archived one, not the one with nothing typed.
    expect(sessions.map((s) => [s.id, s.source, s.title, s.prompts])).toEqual([
      ["opencode:ses_new", "opencode", "Rename the cart module", 1],
      ["opencode:ses_top", "opencode", "Fix the checkout total", 1],
    ]);
    expect(sessions[1].preview).toBe("The checkout total is off by a cent");
    expect(sessions[1].model).toBe("claude-sonnet-4-5");
    expect((await fileSessions({ project: P, q: "checkout", sources: ["opencode"] })).sessions.map((s) => s.id)).toEqual(["opencode:ses_top"]);
    expect((await fileSessions({ project: P, q: null, sources: ["claude_code", "codex"] })).sessions).toEqual([]);
    expect(openCodeStore()).toEqual({ path: DB, display: "~/.local/share/opencode/opencode.db", exists: true, problem: null });
  });

  it("reads a session as prompt, work and answer, with the files it changed and how to resume it", () => {
    const v = fileSession("opencode:ses_top")!;
    expect(v.turns).toHaveLength(1);
    expect(v.turns[0].prompt?.text).toBe("The checkout total is off by a cent");
    expect(v.turns[0].answer?.text).toBe("Fixed: the total rounded twice.");
    expect(v.turns[0].events.map((e) => (e.type === "say" ? "say" : e.kind))).toEqual(["say", "edit", "run", "edit", "agent", "skill"]);
    // The edit and the patch both changed total.ts; the patch also added round.ts.
    expect(v.files).toEqual([
      { path: path.join(P, "src/total.ts"), display: "src/total.ts", edits: 2 },
      { path: path.join(P, "src/round.ts"), display: "src/round.ts", edits: 1 },
    ]);
    expect(v.commands).toEqual([{ command: "pnpm test", count: 1 }]);
    expect(v.skills).toEqual(["money"]);
    expect(v.subagents).toEqual([{ type: "explore", description: "Check rounding" }]);
    expect(v.resume).toBe("cd ~/Dev/shop && opencode --session ses_top");
    expect(fileSession("opencode:ses_gone")).toBeNull();
  });

  it("counts every model call once, subagents and archived sessions included, reasoning as output", async () => {
    const u = await usageView({ days: 7, sources: ["opencode"], project: P });
    // ses_top: two calls (not the message's own tokens, which are the last call's), ses_child: one, ses_arch: one.
    expect(u.totals).toMatchObject({
      input: 100 + 7 + 50 + 1,
      output: 40 + 10 + (30 + 5) + 20 + 2,
      cacheRead: 1000 + 2000 + 300,
      cacheWrite: 500,
      // The subagent's session isn't a session of its own.
      sessions: 2,
    });
    expect(u.prompts).toBe(2);
    expect(u.byModel.find((m) => m.label === "claude-haiku-4-5")).toMatchObject({ input: 50, output: 20, cacheRead: 300 });
    expect(u.byProject.map((p) => p.project)).toEqual([P]);
    expect((await usageView({ days: 7, sources: ["claude_code", "codex"], project: P })).totals.input).toBe(0);
  });

  it("sees what OpenCode writes while it's running", async () => {
    const before = (await usageView({ days: 7, sources: ["opencode"], project: P })).totals.output;
    const a = addMessage(live, "ses_top", min(1), assistant(min(1), "claude-sonnet-4-5", tokens(3, 4, 0, 0, 0)));
    addPart(live, "ses_top", a, min(1), finish(tokens(3, 4, 0, 0, 0)));
    expect((await usageView({ days: 7, sources: ["opencode"], project: P })).totals.output).toBe(before + 4);
  });

  it("leaves the database as it found it", async () => {
    const file = path.join(SCRATCH, "closed.db");
    const db = createDb(file);
    addSession(db, { id: "ses_one", title: "One", created: min(5), updated: min(5) });
    const m = addMessage(db, "ses_one", min(5), user(min(5)));
    addPart(db, "ses_one", m, min(5), text("Hello"));
    db.close();
    const hash = () => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const before = { hash: hash(), mtime: fs.statSync(file).mtimeMs };
    process.env.OPENCODE_DB = file;
    expect((await fileSessions({ project: null, q: null, sources: ["opencode"] })).sessions.map((s) => s.id)).toEqual(["opencode:ses_one"]);
    expect(fileSession("opencode:ses_one")?.turns[0].prompt?.text).toBe("Hello");
    expect({ hash: hash(), mtime: fs.statSync(file).mtimeMs }).toEqual(before);
    // SQLite may leave its empty WAL beside the file; nothing is written into it.
    expect(fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0).toBe(0);
  });

  it("shows nothing and says why when the database is laid out differently", async () => {
    const file = path.join(SCRATCH, "future.db");
    const db = createDb(file, "time_archived");
    db.prepare("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_x', 'prj', 's', ?, 'Unread', '9.0.0', ?, ?)").run(P, min(5), min(5));
    const m = addMessage(db, "ses_x", min(5), user(min(5)));
    addPart(db, "ses_x", m, min(5), text("Hello"));
    db.close();
    process.env.OPENCODE_DB = file;
    expect((await fileSessions({ project: null, q: null, sources: ["opencode"] })).sessions).toEqual([]);
    expect((await usageView({ days: 7, sources: ["opencode"], project: null })).totals.input).toBe(0);
    expect(fileSession("opencode:ses_x")).toBeNull();
    expect(openCodeStore().problem).toBe(
      "OpenCode's session database has a layout this version of AgentCP doesn't know, so OpenCode's sessions and usage aren't shown (missing session.time_archived).",
    );
  });

  it("shows nothing and says why when a model call has no token counts", async () => {
    const file = path.join(SCRATCH, "tokens.db");
    const db = createDb(file);
    addSession(db, { id: "ses_y", title: "Odd", created: min(5), updated: min(5) });
    const m = addMessage(db, "ses_y", min(5), user(min(5)));
    addPart(db, "ses_y", m, min(5), text("Hello"));
    const a = addMessage(db, "ses_y", min(5), assistant(min(5), "claude-sonnet-4-5", tokens(1, 1, 0, 0, 0)));
    addPart(db, "ses_y", a, min(5), { type: "step-finish", reason: "stop", cost: 0, usage: { prompt: 1 } });
    db.close();
    process.env.OPENCODE_DB = file;
    expect((await usageView({ days: 7, sources: ["opencode"], project: null })).totals.sessions).toBe(0);
    expect(openCodeStore().problem).toMatch(/doesn't know.*\(a model call without its token counts\)/);
  });

  it("shows nothing, and no problem, when OpenCode has never run", async () => {
    process.env.OPENCODE_DB = path.join(SCRATCH, "never.db");
    expect((await fileSessions({ project: null, q: null, sources: ["opencode"] })).sessions).toEqual([]);
    expect(openCodeStore()).toMatchObject({ exists: false, problem: null });
    expect(fs.existsSync(path.join(SCRATCH, "never.db"))).toBe(false);
  });
});

// ------------------------------------------------------------- OpenCode 2.x

/** 2.x's session tables (SessionTable and SessionMessageTable, v2.0.12), with `without` left out to make a layout AgentCP doesn't know. */
function createV2Tables(db: DatabaseSync, without?: string) {
  const table = (name: string, cols: string[]) => db.exec(`CREATE TABLE IF NOT EXISTS ${name} (${cols.filter((c) => c.split(" ")[0] !== without).join(", ")})`);
  table("project", ["id text PRIMARY KEY", "worktree text NOT NULL", "time_created integer NOT NULL", "time_updated integer NOT NULL", "sandboxes text NOT NULL"]);
  table("session_v2", [
    "id text PRIMARY KEY", "project_id text NOT NULL", "workspace_id text", "parent_id text", "fork_session_id text", "fork_boundary text", "slug text NOT NULL",
    "directory text NOT NULL", "path text", "title text", "version text NOT NULL", "share_url text", "summary_additions integer", "summary_deletions integer",
    "summary_files integer", "summary_diffs text", "metadata text", "cost real NOT NULL DEFAULT 0", "tokens_input integer NOT NULL DEFAULT 0",
    "tokens_output integer NOT NULL DEFAULT 0", "tokens_reasoning integer NOT NULL DEFAULT 0", "tokens_cache_read integer NOT NULL DEFAULT 0",
    "tokens_cache_write integer NOT NULL DEFAULT 0", "revert text", "permission text", "agent text", "model text", "time_created integer NOT NULL",
    "time_updated integer NOT NULL", "time_idle integer", "time_viewed integer", "idle_outcome text", "time_compacting integer", "time_archived integer",
    "time_suspended integer", "resume_attempts integer NOT NULL DEFAULT 0",
  ]);
  table("session_message", ["id text PRIMARY KEY", "session_id text NOT NULL", "type text NOT NULL", "seq integer NOT NULL", "time_created integer NOT NULL", "time_updated integer NOT NULL", "data text NOT NULL"]);
  db.exec("CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq)");
  db.exec("CREATE INDEX session_message_session_type_seq_idx ON session_message (session_id, type, seq)");
  db.prepare("INSERT OR IGNORE INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('prj', ?, 0, 0, '[]')").run(P);
}

function createV2Db(file: string, without?: string): DatabaseSync {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  createV2Tables(db, without);
  return db;
}

type V2Session = { id: string; title: string | null; created: number; updated: number; parent?: string; fork?: string; archived?: number; model?: string };
function addV2Session(db: DatabaseSync, s: V2Session) {
  db.prepare(
    "INSERT INTO session_v2 (id, project_id, parent_id, fork_session_id, slug, directory, title, version, agent, model, time_created, time_updated, time_archived) VALUES (?, 'prj', ?, ?, 'slug', ?, ?, '2.0.12', 'build', ?, ?, ?, ?)",
  ).run(s.id, s.parent ?? null, s.fork ?? null, P, s.title, JSON.stringify({ id: s.model ?? "claude-sonnet-4-5", providerID: "anthropic" }), s.created, s.updated, s.archived ?? null);
}

/** A row in a session's message stream; `seq` counts up per session, as OpenCode's event sequence does. */
const seqs = new Map<string, number>();
function addRow(db: DatabaseSync, session: string, type: string, at: number, data: object, seq?: number): string {
  const id = next("msg");
  const n = seq ?? (seqs.get(session) ?? 0) + 1;
  seqs.set(session, Math.max(n, seqs.get(session) ?? 0));
  db.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, session, type, n, at, at, JSON.stringify(data));
  return id;
}

const typed = (at: number, t: string) => ({ time: { created: at }, text: t });
const injected = (at: number, t: string) => ({ time: { created: at }, text: t, description: "notice" });
/** One model call: what it said and called, and its tokens once it ended (`tokens: null` while it's still running). */
const call = (at: number, model: string, content: object[], t: Tokens | null, extra: object = {}) => ({
  time: t ? { created: at, completed: at } : { created: at },
  agent: "build",
  model: { id: model, providerID: "anthropic", variant: "default" },
  content,
  ...(t ? { finish: "stop", cost: 0.01, tokens: t } : {}),
  ...extra,
});
const said = (t: string) => ({ type: "text", text: t });
const thought = (t: string) => ({ type: "reasoning", text: t });
const v2tool = (name: string, input: object, at: number) => ({
  type: "tool",
  id: next("call"),
  name,
  state: { status: "completed", input, content: [{ type: "text", text: "ok" }] },
  time: { created: at, ran: at, completed: at },
});

describe("OpenCode 2's sessions", () => {
  const V2 = path.join(HOME, "opencode-v2", "opencode.db");
  const V2SCRATCH = path.join(HOME, "opencode-v2-scratch");
  /** OpenCode 2, still running. */
  let live2: DatabaseSync;
  /** The model call in ses_top still running when the tests start. */
  let running: string;

  beforeAll(() => {
    live2 = createV2Db(V2);
    // A session you worked in: one typed prompt, two model calls, a command and a skill you ran yourself, and a compaction.
    addV2Session(live2, { id: "ses_top", title: "Fix the checkout total", created: min(60), updated: min(30), model: "claude-opus-4-5" });
    addRow(live2, "ses_top", "agent-switched", min(60), { time: { created: min(60) }, agent: "build" });
    addRow(live2, "ses_top", "user", min(60), typed(min(60), "The checkout total is off by a cent"));
    addRow(live2, "ses_top", "synthetic", min(60), injected(min(60), "Called the Read tool with the following input: src/total.ts"));
    addRow(live2, "ses_top", "assistant", min(59), call(min(59), "claude-sonnet-4-5", [
      thought("The total is summed twice"),
      said("Looking at the cart."),
      v2tool("edit", { path: "src/total.ts", oldString: "a", newString: "b" }, min(59)),
      v2tool("shell", { command: "pnpm test", description: "Run the tests" }, min(58)),
    ], STEP1));
    addRow(live2, "ses_top", "assistant", min(57), call(min(57), "claude-sonnet-4-5", [
      v2tool("patch", { patchText: "*** Begin Patch\n*** Update File: src/total.ts\n@@\n-a\n+b\n*** Add File: src/round.ts\n+export {}\n*** End Patch" }, min(57)),
      v2tool("subagent", { agent: "explore", description: "Check rounding", prompt: "Look for rounding" }, min(57)),
      v2tool("skill", { id: "money" }, min(57)),
      said("Fixed: the total rounded twice."),
    ], STEP2));
    addRow(live2, "ses_top", "idle", min(56), { time: { created: min(56) }, outcome: "succeeded" });
    addRow(live2, "ses_top", "shell", min(40), { time: { created: min(40), completed: min(40) }, shellID: "sh_1", command: "git status", status: "completed", exit: 0 });
    addRow(live2, "ses_top", "synthetic", min(40), injected(min(40), "The following command was run by the user: git status"));
    addRow(live2, "ses_top", "skill", min(35), { time: { created: min(35) }, skill: "release-notes", name: "release-notes", text: "How to write release notes" });
    // A compaction that failed after the summary request was billed: it names no model, so it's the session's.
    addRow(live2, "ses_top", "compaction", min(33), { time: { created: min(33) }, status: "failed", reason: "auto", error: { type: "unknown", message: "Cut short" }, cost: 0.02, tokens: tokens(300, 60, 0, 0, 0) });
    running = addRow(live2, "ses_top", "assistant", min(31), call(min(31), "claude-sonnet-4-5", [], null));

    // The subagent it started: a session of its own, pointing at the first.
    addV2Session(live2, { id: "ses_child", parent: "ses_top", title: "Check rounding", created: min(57), updated: min(57) });
    addRow(live2, "ses_child", "user", min(57), typed(min(57), "You are a subagent spawned by another session.\nLook for rounding"));
    addRow(live2, "ses_child", "assistant", min(57), call(min(57), "claude-haiku-4-5", [said("Rounded once.")], tokens(50, 20, 0, 300, 0)));

    // One you archived, with a call that failed before the provider reported any usage.
    addV2Session(live2, { id: "ses_arch", title: "An old idea", created: min(50), updated: min(20), archived: min(20) });
    addRow(live2, "ses_arch", "user", min(50), typed(min(50), "Try a coupon engine"));
    addRow(live2, "ses_arch", "assistant", min(50), call(min(50), "claude-sonnet-4-5", [], null, { time: { created: min(50), completed: min(50) }, finish: "error", error: { type: "provider", message: "Overloaded" } }));
    addRow(live2, "ses_arch", "assistant", min(49), call(min(49), "claude-sonnet-4-5", [said("Here's a sketch.")], tokens(1, 2, 0, 0, 0)));

    // A fork of the first: a copy of its history up to the first answer, keeping the copied rows' times, then its own.
    addV2Session(live2, { id: "ses_fork", fork: "ses_top", title: "Fix the checkout total (fork #1)", created: min(20), updated: min(19) });
    addRow(live2, "ses_fork", "user", min(60), typed(min(60), "The checkout total is off by a cent"), 2);
    addRow(live2, "ses_fork", "assistant", min(59), call(min(59), "claude-sonnet-4-5", [said("Looking at the cart.")], STEP1), 4);
    addRow(live2, "ses_fork", "user", min(19), typed(min(19), "Try rounding once instead"));
    addRow(live2, "ses_fork", "assistant", min(19), call(min(19), "claude-sonnet-4-5", [said("Rounded once.")], tokens(9, 8, 0, 0, 0)));

    // One OpenCode hasn't named yet (2.x leaves the title empty), and one with nothing typed in it.
    addV2Session(live2, { id: "ses_new", title: null, created: min(10), updated: min(10) });
    addRow(live2, "ses_new", "user", min(10), typed(min(10), "Rename the cart module"));
    addV2Session(live2, { id: "ses_quiet", title: "Nothing typed", created: min(5), updated: min(5) });
    addRow(live2, "ses_quiet", "synthetic", min(5), injected(min(5), "The following command was run by the user: ls"));
    forgetTranscripts();
  });

  afterAll(() => {
    live2.close();
    fs.rmSync(path.dirname(V2), { recursive: true, force: true });
    fs.rmSync(V2SCRATCH, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env.OPENCODE_DB = V2;
  });

  it("lists the sessions you worked in, counting only what you typed", async () => {
    const { sessions } = await fileSessions({ project: P, q: null, sources: ["opencode"] });
    // Not the subagent's session, not the archived one, not the one with nothing typed; a fork's copied prompt isn't its own.
    expect(sessions.map((s) => [s.id, s.source, s.title, s.prompts])).toEqual([
      ["opencode:ses_new", "opencode", "Rename the cart module", 1],
      ["opencode:ses_fork", "opencode", "Fix the checkout total (fork #1)", 1],
      ["opencode:ses_top", "opencode", "Fix the checkout total", 1],
    ]);
    expect(sessions[1].preview).toBe("Try rounding once instead");
    expect(sessions[2].preview).toBe("The checkout total is off by a cent");
    // The last model call that reported usage: the compaction ran on the session's model.
    expect(sessions[2].model).toBe("claude-opus-4-5");
    expect(sessions[1].model).toBe("claude-sonnet-4-5");
    expect((await fileSessions({ project: P, q: "checkout", sources: ["opencode"] })).sessions.map((s) => s.id)).toEqual(["opencode:ses_fork", "opencode:ses_top"]);
    expect((await fileSessions({ project: P, q: null, sources: ["claude_code", "codex"] })).sessions).toEqual([]);
    expect(openCodeStore()).toEqual({ path: V2, display: "~/opencode-v2/opencode.db", exists: true, problem: null });
  });

  it("reads a session as prompt, work and answer, with the files it changed and how to resume it", () => {
    const v = fileSession("opencode:ses_top")!;
    expect(v.turns).toHaveLength(1);
    expect(v.turns[0].prompt?.text).toBe("The checkout total is off by a cent");
    expect(v.turns[0].answer?.text).toBe("Fixed: the total rounded twice.");
    // Reasoning isn't shown; the command and the skill you ran yourself are steps of the turn they followed.
    expect(v.turns[0].events.map((e) => (e.type === "say" ? `say:${e.text}` : `${e.kind}:${e.tool}`))).toEqual([
      "say:Looking at the cart.", "edit:edit", "run:shell", "edit:patch", "agent:explore", "skill:skill", "run:shell", "skill:skill",
    ]);
    // The edit and the patch both changed total.ts, named from the session's folder; the patch also added round.ts.
    expect(v.files).toEqual([
      { path: path.join(P, "src/total.ts"), display: "src/total.ts", edits: 2 },
      { path: path.join(P, "src/round.ts"), display: "src/round.ts", edits: 1 },
    ]);
    expect(v.commands).toEqual([{ command: "pnpm test", count: 1 }, { command: "git status", count: 1 }]);
    expect(v.skills).toEqual(["money", "release-notes"]);
    expect(v.subagents).toEqual([{ type: "explore", description: "Check rounding" }]);
    expect(v.resume).toBe("cd ~/Dev/shop && opencode --session ses_top");
    // A fork reads as the conversation it continues.
    expect(fileSession("opencode:ses_fork")!.turns.map((t) => [t.prompt?.text, t.answer?.text])).toEqual([
      ["The checkout total is off by a cent", "Looking at the cart."],
      ["Try rounding once instead", "Rounded once."],
    ]);
    expect(fileSession("opencode:ses_gone")).toBeNull();
  });

  it("counts every model call once, subagents, compactions and archived sessions included, reasoning as output", async () => {
    const u = await usageView({ days: 7, sources: ["opencode"], project: P });
    // ses_top: two calls and the compaction (not the call still running), ses_child: one, ses_arch: one (not the one
    // that failed without usage), ses_fork: its own call (not the one copied from ses_top).
    expect(u.totals).toMatchObject({
      input: 100 + 7 + 300 + 50 + 1 + 9,
      output: 40 + 10 + (30 + 5) + 60 + 20 + 2 + 8,
      cacheRead: 1000 + 2000 + 300,
      cacheWrite: 500,
      // The subagent's session isn't a session of its own.
      sessions: 3,
    });
    expect(u.prompts).toBe(3);
    expect(u.byModel.find((m) => m.label === "claude-haiku-4-5")).toMatchObject({ input: 50, output: 20, cacheRead: 300 });
    expect(u.byModel.find((m) => m.label === "claude-opus-4-5")).toMatchObject({ input: 300, output: 60 });
    expect(u.byProject.map((p) => p.project)).toEqual([P]);
    expect(openCodeStore().problem).toBeNull();
  });

  it("sees what OpenCode writes while it's running, including a model call finishing in place", async () => {
    const before = (await usageView({ days: 7, sources: ["opencode"], project: P })).totals.output;
    // OpenCode rewrites a call's row when it ends: same row, same count, a later time_updated.
    const done = Date.now();
    live2.prepare("UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?").run(JSON.stringify(call(done, "claude-sonnet-4-5", [said("All green.")], tokens(2, 6, 1, 0, 0))), done, running);
    expect((await usageView({ days: 7, sources: ["opencode"], project: P })).totals.output).toBe(before + 7);
    addRow(live2, "ses_top", "assistant", min(0), call(min(0), "claude-sonnet-4-5", [said("And again.")], tokens(3, 4, 0, 0, 0)));
    expect((await usageView({ days: 7, sources: ["opencode"], project: P })).totals.output).toBe(before + 7 + 4);
    expect(fileSession("opencode:ses_top")!.turns[0].answer?.text).toBe("And again.");
  });

  it("leaves the database as it found it", async () => {
    const file = path.join(V2SCRATCH, "closed.db");
    const db = createV2Db(file);
    addV2Session(db, { id: "ses_one", title: "One", created: min(5), updated: min(5) });
    addRow(db, "ses_one", "user", min(5), typed(min(5), "Hello"));
    addRow(db, "ses_one", "assistant", min(5), call(min(5), "claude-sonnet-4-5", [said("Hi.")], tokens(1, 1, 0, 0, 0)));
    db.close();
    const hash = () => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const before = { hash: hash(), mtime: fs.statSync(file).mtimeMs };
    process.env.OPENCODE_DB = file;
    expect((await fileSessions({ project: null, q: null, sources: ["opencode"] })).sessions.map((s) => s.id)).toEqual(["opencode:ses_one"]);
    expect(fileSession("opencode:ses_one")?.turns[0].prompt?.text).toBe("Hello");
    expect((await usageView({ days: 7, sources: ["opencode"], project: null })).totals.input).toBe(1);
    expect({ hash: hash(), mtime: fs.statSync(file).mtimeMs }).toEqual(before);
    expect(fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0).toBe(0);
  });

  it("reads 2.x's tables when 1.x's are still beside them, and counts nothing twice", async () => {
    // What 2.x leaves after copying a 1.x database: the 1.x tables as they were, the same session in its own.
    const file = path.join(V2SCRATCH, "upgraded.db");
    const db = createDb(file);
    addSession(db, { id: "ses_one", title: "New session - 2026-09-01T10:00:00.000Z", created: min(5), updated: min(5) });
    const m = addMessage(db, "ses_one", min(5), user(min(5)));
    addPart(db, "ses_one", m, min(5), text("Hello from 1.x"));
    const a = addMessage(db, "ses_one", min(5), assistant(min(5), "claude-sonnet-4-5", tokens(5, 5, 0, 0, 0)));
    addPart(db, "ses_one", a, min(5), finish(tokens(5, 5, 0, 0, 0)));
    createV2Tables(db);
    addV2Session(db, { id: "ses_one", title: "New session - 2026-09-01T10:00:00.000Z", created: min(5), updated: min(5) });
    addRow(db, "ses_one", "user", min(5), typed(min(5), "Hello"));
    addRow(db, "ses_one", "assistant", min(5), call(min(5), "claude-sonnet-4-5", [said("Hi.")], tokens(1, 1, 0, 0, 0)));
    db.close();
    process.env.OPENCODE_DB = file;
    // 1.x's placeholder title, carried over, still isn't a title.
    expect((await fileSessions({ project: null, q: null, sources: ["opencode"] })).sessions.map((s) => [s.id, s.title])).toEqual([["opencode:ses_one", "Hello"]]);
    expect((await usageView({ days: 7, sources: ["opencode"], project: null })).totals.input).toBe(1);
  });

  it("shows nothing and says why when the database is laid out differently", async () => {
    // A complete 1.x layout beside a 2.x one AgentCP doesn't know isn't read instead: 2.x no longer writes to it.
    const file = path.join(V2SCRATCH, "future.db");
    const db = createDb(file);
    addSession(db, { id: "ses_x", title: "Unread", created: min(5), updated: min(5) });
    const m = addMessage(db, "ses_x", min(5), user(min(5)));
    addPart(db, "ses_x", m, min(5), text("Hello"));
    createV2Tables(db, "time_archived");
    db.prepare("INSERT INTO session_v2 (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_x', 'prj', 's', ?, 'Unread', '9.0.0', ?, ?)").run(P, min(5), min(5));
    addRow(db, "ses_x", "user", min(5), typed(min(5), "Hello"));
    db.close();
    process.env.OPENCODE_DB = file;
    expect((await fileSessions({ project: null, q: null, sources: ["opencode"] })).sessions).toEqual([]);
    expect((await usageView({ days: 7, sources: ["opencode"], project: null })).totals.input).toBe(0);
    expect(fileSession("opencode:ses_x")).toBeNull();
    expect(openCodeStore().problem).toBe(
      "OpenCode's session database has a layout this version of AgentCP doesn't know, so OpenCode's sessions and usage aren't shown (missing session_v2.time_archived).",
    );
  });

  it("leaves out a model call that ended without token counts, and still shows the session", async () => {
    // A provider that reports no usage leaves a finished call with no tokens; a real 2.0.12 database had one.
    const file = path.join(V2SCRATCH, "tokens.db");
    const db = createV2Db(file);
    addV2Session(db, { id: "ses_y", title: "Odd", created: min(5), updated: min(5) });
    addRow(db, "ses_y", "user", min(5), typed(min(5), "Hello"));
    addRow(db, "ses_y", "assistant", min(5), call(min(5), "claude-sonnet-4-5", [said("Hi.")], null, { time: { created: min(5), completed: min(5) }, finish: "stop", usage: { prompt: 1 } }));
    db.close();
    process.env.OPENCODE_DB = file;
    const u = await usageView({ days: 7, sources: ["opencode"], project: null });
    expect(u.totals).toMatchObject({ input: 0, output: 0 });
    expect((await fileSessions({ project: null, q: null, sources: ["opencode"] })).sessions.map((s) => s.title)).toEqual(["Odd"]);
    expect(openCodeStore().problem).toBeNull();
  });
});
