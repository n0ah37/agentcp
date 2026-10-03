import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

import type { OpenCodeStore, SessionStep } from "../../shared/types.ts";
import { HOME, tilde } from "./paths.ts";
import { classify } from "./session-steps.ts";

/**
 * OpenCode's sessions, read from its own database and only read.
 *
 * Since 1.2 OpenCode keeps every session in one SQLite file, <data>/opencode.db,
 * where <data> is $XDG_DATA_HOME/opencode, else ~/.local/share/opencode (on
 * macOS too), and OPENCODE_DB names another file. The JSON files under
 * <data>/storage/ are the copy it migrated from; they're never read, because
 * every session in them is in the database too.
 *
 * The database is opened read-only for each refresh and closed straight after.
 * OpenCode may be writing to it at the same time (it runs in WAL mode), so it is
 * never opened as immutable. What's read is kept in memory while the database
 * and its WAL keep their size and modification time, and a session is read
 * again only when its messages or parts changed. Nothing is written to disk.
 *
 * The layout isn't in OpenCode's documentation; it comes from OpenCode's source
 * (github.com/anomalyco/opencode). The file holds one of two layouts:
 *
 * - 1.x (1.2 to 1.18): tables session, message and part. A message is one
 *   prompt or one answer, and each part one piece of it: typed text, a tool
 *   call, a step-finish part per model call. From packages/core/src/session/sql.ts
 *   and packages/schema/src/v1/session.ts at tag v1.18.34 (commit aec0b9a).
 * - 2.x: tables session_v2 and session_message. A session_message row is one
 *   typed prompt, one model call with everything it said and called, or a
 *   marker (idle, agent or model switched, …). From tag v2.0.12 (commit
 *   2670273ff17d), unchanged through v2.0.22 (527f0b931d1f); the files are named
 *   where they're used below. 2.x copies the 1.x tables into its own and leaves
 *   them beside (packages/core/src/database/v1-migration.bun.ts), so a file
 *   with session_v2 is read as 2.x even when the 1.x tables are still there.
 *
 * Every table and column used here is checked before anything is read, and a
 * database laid out differently gives no sessions and says why (openCodeStore),
 * rather than numbers that are silently wrong.
 */

/** OpenCode's two layouts. */
type Layout = "v1" | "v2";

/** The tables and columns each layout is read from. All of the 1.x ones are in OpenCode's first database layout (1.2.0). */
const NEEDS: Record<Layout, Record<string, string[]>> = {
  v1: {
    session: ["id", "parent_id", "directory", "title", "time_created", "time_updated", "time_archived"],
    message: ["id", "session_id", "time_created", "time_updated", "data"],
    part: ["id", "message_id", "session_id", "time_created", "data"],
  },
  // packages/core/src/session/sql.ts, SessionTable and SessionMessageTable (v2.0.12).
  v2: {
    session_v2: ["id", "parent_id", "fork_session_id", "directory", "title", "model", "time_created", "time_updated", "time_archived"],
    session_message: ["id", "session_id", "type", "seq", "time_created", "time_updated", "data"],
  },
};

export type OpenCodeUsage = {
  /** When the model call finished, in epoch ms. */
  at: number;
  model: string;
  input: number;
  /** What the model wrote, its reasoning included: reasoning is output it generated and is billed as output. */
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type OpenCodeSession = {
  /** OpenCode's own id, ses_… */
  id: string;
  /** Set on a subagent's session: the session that started it. */
  parent: string | null;
  archived: boolean;
  /** The folder it ran in. */
  directory: string | null;
  /** Its title, unless it's still OpenCode's placeholder ("New session - <date>"). */
  title: string | null;
  firstPrompt: string | null;
  prompts: number;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Its latest activity, in epoch ms. */
  updated: number;
  /** One entry per model call. */
  usage: OpenCodeUsage[];
  /** Changes whenever the session, its messages or its parts do. */
  sig: string;
};

/** What a session's messages read as: what you typed, what OpenCode answered, and each tool it used. */
export type OpenCodeMsg = { role: "user" | "assistant" | "tool"; text: string; step?: SessionStep; edited?: string[]; at: string | null };

type Row = Record<string, SQLOutputValue>;

class LayoutError extends Error {}

// ------------------------------------------------------------- where it is

/** OpenCode's data folder: $XDG_DATA_HOME/opencode, else ~/.local/share/opencode. */
export function openCodeDataDir(): string {
  return path.join(process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share"), "opencode");
}

/**
 * OpenCode's session database, the way OpenCode finds it: OPENCODE_DB when it's
 * set (a full path, or a name inside the data folder), else opencode.db in the
 * data folder. Null when OPENCODE_DB keeps the sessions in memory.
 */
export function openCodeDb(): string | null {
  const set = process.env.OPENCODE_DB;
  if (set) {
    if (set === ":memory:") return null;
    return path.isAbsolute(set) ? set : path.join(openCodeDataDir(), set);
  }
  return path.join(openCodeDataDir(), "opencode.db");
}

/** The database's and its WAL's size and time; null when there's no database. */
function statKey(db: string): string | null {
  const one = (f: string) => {
    try {
      const st = fs.statSync(f);
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return "-";
    }
  };
  const main = one(db);
  return main === "-" ? null : `${main}|${one(`${db}-wal`)}`;
}

function open(db: string): DatabaseSync {
  return new DatabaseSync(db, { readOnly: true, timeout: 2000 });
}

// ------------------------------------------------------------------ reading

const str = (v: SQLOutputValue | undefined): string | null => (typeof v === "string" && v ? v : null);
const ms = (v: SQLOutputValue | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "bigint" ? Number(v) : 0);
const iso = (v: SQLOutputValue | undefined): string | null => (ms(v) > 0 ? new Date(ms(v)).toISOString() : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function parse(v: SQLOutputValue | undefined): Record<string, unknown> | null {
  if (typeof v !== "string") return null;
  try {
    const o = JSON.parse(v) as unknown;
    return o && typeof o === "object" ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Text you typed: OpenCode marks what it adds itself as synthetic, and what only the screen shows as ignored. */
function typedText(p: Record<string, unknown> | null): string | null {
  if (!p || p.type !== "text" || p.synthetic === true || p.ignored === true || typeof p.text !== "string") return null;
  return p.text.trim() ? p.text : null;
}

/** OpenCode's placeholder title, kept until it has named the session (session.ts, isDefaultTitle). */
const PLACEHOLDER = /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** 2.x when the file has its session table, else 1.x; the columns are checked after. */
function layoutOf(h: DatabaseSync): Layout {
  return h.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'").get() ? "v2" : "v1";
}

function missingColumns(h: DatabaseSync, layout: Layout): string[] {
  const missing: string[] = [];
  for (const [table, cols] of Object.entries(NEEDS[layout])) {
    const have = new Set(h.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((r) => String(r.name)));
    if (!have.size) missing.push(`the ${table} table`);
    else for (const c of cols) if (!have.has(c)) missing.push(`${table}.${c}`);
  }
  return missing;
}

function layoutProblem(what: string): string {
  return `OpenCode's session database has a layout this version of AgentCP doesn't know, so OpenCode's sessions and usage aren't shown (${what}).`;
}

/** Every session in a 1.x database; one whose signature hasn't changed is taken from `prev` without reading it again. */
function readAllV1(h: DatabaseSync, prev: Map<string, OpenCodeSession>): Map<string, OpenCodeSession> {
  const rows = h.prepare("SELECT id, parent_id, directory, title, time_created, time_updated, time_archived FROM session").all();
  const messages = new Map<string, { n: number; t: number }>();
  for (const r of h.prepare("SELECT session_id AS s, COUNT(*) AS n, MAX(time_updated) AS t FROM message GROUP BY session_id").all()) {
    if (typeof r.s === "string") messages.set(r.s, { n: ms(r.n), t: ms(r.t) });
  }
  // A new prompt, answer or model call adds a part; counting them comes from an index, not the parts themselves.
  const parts = new Map<string, number>();
  for (const r of h.prepare("SELECT session_id AS s, COUNT(*) AS n FROM part GROUP BY session_id").all()) {
    if (typeof r.s === "string") parts.set(r.s, ms(r.n));
  }
  const promptRows = h.prepare(
    `SELECT p.message_id AS mid, p.data AS data FROM part p JOIN message m ON m.id = p.message_id
     WHERE p.session_id = ? AND json_extract(m.data, '$.role') = 'user' AND json_extract(p.data, '$.type') = 'text'
     ORDER BY m.time_created, m.id, p.id`,
  );
  // One step-finish part per model call. The assistant message's own tokens hold only its last call, so they aren't used.
  const stepRows = h.prepare(
    `SELECT p.time_created AS at, p.data AS data, json_extract(m.data, '$.modelID') AS model FROM part p JOIN message m ON m.id = p.message_id
     WHERE p.session_id = ? AND json_extract(p.data, '$.type') = 'step-finish'
     ORDER BY p.time_created, p.id`,
  );
  const out = new Map<string, OpenCodeSession>();
  for (const r of rows) {
    const id = str(r.id);
    if (!id) continue;
    const m = messages.get(id);
    const sig = [r.parent_id, r.directory, r.title, r.time_updated, r.time_archived, m?.n ?? 0, m?.t ?? 0, parts.get(id) ?? 0].join("|");
    const old = prev.get(id);
    if (old?.sig === sig) {
      out.set(id, old);
      continue;
    }

    const typed = new Map<string, string[]>();
    for (const p of promptRows.all(id)) {
      const text = typedText(parse(p.data));
      const mid = str(p.mid);
      if (!text || !mid) continue;
      const list = typed.get(mid) ?? [];
      list.push(text);
      typed.set(mid, list);
    }
    const prompts = [...typed.values()].map((t) => t.join("\n").trim());

    const usage: OpenCodeUsage[] = [];
    for (const p of stepRows.all(id)) {
      const d = parse(p.data);
      if (!d) continue;
      const t = d.tokens as { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown; write?: unknown } } | undefined;
      if (!t || typeof t.input !== "number" || typeof t.output !== "number") throw new LayoutError(layoutProblem("a model call without its token counts"));
      usage.push({
        at: ms(p.at),
        model: str(p.model) ?? "unknown",
        input: t.input,
        output: t.output + count(t.reasoning),
        cacheRead: count(t.cache?.read),
        cacheWrite: count(t.cache?.write),
      });
    }

    const title = str(r.title);
    const updated = Math.max(ms(r.time_updated), m?.t ?? 0);
    out.set(id, {
      id,
      parent: str(r.parent_id),
      archived: ms(r.time_archived) > 0,
      directory: str(r.directory),
      title: title && !PLACEHOLDER.test(title) ? title : null,
      firstPrompt: prompts[0] ?? null,
      prompts: prompts.length,
      model: usage.length ? usage[usage.length - 1].model : null,
      startedAt: iso(r.time_created),
      endedAt: iso(m?.t || r.time_updated),
      updated,
      usage,
      sig,
    });
  }
  return out;
}

/**
 * Every session in a 2.x database, the same way.
 *
 * What a row holds is in packages/schema/src/session-message.ts (its `data` is
 * the message without `id` and `type`). A user row is what you typed (`text`);
 * a synthetic row is text OpenCode put in the conversation itself, so it isn't a
 * prompt. Each model call is one assistant row: packages/core/src/session/
 * message-updater.ts starts a row on every step and sets that step's `tokens`
 * when it ends, so a row's tokens count once. A compaction row carries the
 * usage of the summary request (CompactionUsage), which 1.x kept as an ordinary
 * model call. Tokens are packages/schema/src/token-usage.ts: input without the
 * cache reads and writes, output without the reasoning (packages/core/src/
 * session/usage.ts), so reasoning is added to output here, as for 1.x.
 *
 * A fork (fork_session_id) starts with a copy of the history it was forked
 * from, each copied row keeping its original time (packages/core/src/session/
 * projector.ts, projectFork). Those rows are counted in the session they came
 * from, so in a fork only rows from after it was made count, prompts and model
 * calls alike; that is OpenCode's own rule in packages/core/src/session/stats.ts.
 */
function readAllV2(h: DatabaseSync, prev: Map<string, OpenCodeSession>): Map<string, OpenCodeSession> {
  const rows = h.prepare("SELECT id, parent_id, fork_session_id, directory, title, model, time_created, time_updated, time_archived FROM session_v2").all();
  // A row is added for each prompt and model call and rewritten as the call goes on (time_updated), and a revert deletes rows.
  const messages = new Map<string, { n: number; t: number; q: number }>();
  for (const r of h.prepare("SELECT session_id AS s, COUNT(*) AS n, MAX(time_updated) AS t, MAX(seq) AS q FROM session_message GROUP BY session_id").all()) {
    if (typeof r.s === "string") messages.set(r.s, { n: ms(r.n), t: ms(r.t), q: ms(r.q) });
  }
  const promptRows = h.prepare("SELECT time_created AS at, json_extract(data, '$.text') AS text FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq");
  // Only the fields a model call is counted from, so a long answer's text and tool output aren't read for it.
  const callRows = h.prepare(
    `SELECT type, time_created AS at, time_updated AS updated, json_extract(data, '$.time.completed') AS completed,
       json_extract(data, '$.model.id') AS model, json_extract(data, '$.tokens') AS tokens,
       json_extract(data, '$.finish') AS finish, json_type(data, '$.error') AS error
     FROM session_message WHERE session_id = ? AND type IN ('assistant', 'compaction') ORDER BY seq`,
  );
  const out = new Map<string, OpenCodeSession>();
  for (const r of rows) {
    const id = str(r.id);
    if (!id) continue;
    const m = messages.get(id);
    const sig = [r.parent_id, r.fork_session_id, r.directory, r.title, r.model, r.time_updated, r.time_archived, m?.n ?? 0, m?.t ?? 0, m?.q ?? 0].join("|");
    const old = prev.get(id);
    if (old?.sig === sig) {
      out.set(id, old);
      continue;
    }

    const born = ms(r.time_created);
    const own = (at: SQLOutputValue | undefined) => !str(r.fork_session_id) || ms(at) >= born;

    const prompts: string[] = [];
    for (const p of promptRows.all(id)) {
      const text = typeof p.text === "string" ? p.text.trim() : "";
      if (text && own(p.at)) prompts.push(text);
    }

    const modelId = parse(r.model)?.id;
    const fallback = typeof modelId === "string" && modelId ? modelId : null;
    const usage: OpenCodeUsage[] = [];
    for (const c of callRows.all(id)) {
      if (!own(c.at)) continue;
      const t = parse(c.tokens) as { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown; write?: unknown } } | null;
      if (!t) {
        // Every step that ends sets `finish` and its tokens together (Step.Ended in packages/schema/src/session-event.ts);
        // one that failed, is still running, or was cut off may have none. A finished one can too, when the provider
        // reports no usage (seen on a real 2.0.12 database): it's left out of the count rather than hiding every session.
        continue;
      }
      if (typeof t.input !== "number" || typeof t.output !== "number") throw new LayoutError(layoutProblem("a model call without its token counts"));
      usage.push({
        at: ms(c.completed) || ms(c.updated),
        // A compaction names its model only when it finished; the session's model is the one it ran on.
        model: str(c.model) ?? (c.type === "compaction" ? fallback : null) ?? "unknown",
        input: t.input,
        output: t.output + count(t.reasoning),
        cacheRead: count(t.cache?.read),
        cacheWrite: count(t.cache?.write),
      });
    }

    const title = str(r.title);
    const updated = Math.max(ms(r.time_updated), m?.t ?? 0);
    out.set(id, {
      id,
      parent: str(r.parent_id),
      archived: ms(r.time_archived) > 0,
      directory: str(r.directory),
      // Sessions brought over from 1.x keep 1.x's placeholder until OpenCode names them.
      title: title && !PLACEHOLDER.test(title) ? title : null,
      firstPrompt: prompts[0] ?? null,
      prompts: prompts.length,
      model: usage.length ? usage[usage.length - 1].model : null,
      startedAt: iso(r.time_created),
      endedAt: iso(m?.t || r.time_updated),
      updated,
      usage,
      sig,
    });
  }
  return out;
}

// -------------------------------------------------------------------- state

/** `layout` is the one the sessions were read from, null when none were. */
type State = { db: string | null; key: string; layout: Layout | null; sessions: Map<string, OpenCodeSession>; problem: string | null };

const EMPTY: State = { db: null, key: "", layout: null, sessions: new Map(), problem: null };
let state: State = EMPTY;

function refresh(): void {
  const db = openCodeDb();
  const key = db ? statKey(db) : null;
  if (!db || !key) {
    state = { ...EMPTY, db };
    return;
  }
  if (state.db === db && state.key === key) return;
  let h: DatabaseSync | null = null;
  try {
    h = open(db);
    const layout = layoutOf(h);
    const missing = missingColumns(h, layout);
    // A session read from the other layout (OpenCode was upgraded since) is read again.
    const prev = state.db === db && state.layout === layout && !state.problem ? state.sessions : new Map<string, OpenCodeSession>();
    state = missing.length
      ? { db, key, layout: null, sessions: new Map(), problem: layoutProblem(`missing ${missing.join(", ")}`) }
      : { db, key, layout, sessions: layout === "v2" ? readAllV2(h, prev) : readAllV1(h, prev), problem: null };
  } catch (e) {
    // A layout problem stays until the database changes; anything else is tried again next time.
    state = e instanceof LayoutError ? { db, key, layout: null, sessions: new Map(), problem: e.message } : { db, key: "", layout: null, sessions: new Map(), problem: `OpenCode's session database couldn't be read: ${(e as Error).message}` };
  } finally {
    h?.close();
  }
}

/**
 * Every session OpenCode has, subagents' and archived ones included; none when
 * there's no database or it can't be read (openCodeStore says why).
 */
export function openCodeSessions(): OpenCodeSession[] {
  refresh();
  return state.problem ? [] : [...state.sessions.values()];
}

/** A session from the last read, without reading again. */
export function openCodeSession(id: string): OpenCodeSession | null {
  return state.problem ? null : (state.sessions.get(id) ?? null);
}

/** Where OpenCode's sessions are read from, and why they aren't shown when they aren't. */
export function openCodeStore(): OpenCodeStore {
  refresh();
  const db = openCodeDb();
  return { path: db, display: db ? tilde(db) : null, exists: !!db && fs.existsSync(db), problem: state.problem };
}

// ---------------------------------------------------------------- the steps

/** OpenCode's tools that classify() knows by another name. */
const SAME_AS: Record<string, string> = {
  patch: "apply_patch", // apply_patch's earlier name
  list: "ls", // listed a folder, in earlier versions
  todoread: "todowrite",
  codesearch: "websearch",
  plan_enter: "enterplanmode",
  plan_exit: "exitplanmode",
  lsp: "read", // asks the language server about a file
  subagent: "task", // 2.x's name for task (packages/core/src/tool/plugin/subagent.ts)
};

/** A tool call as a step, with every file it changed as a full path. */
export function openCodeStep(tool: string, input: unknown, cwd: string | null): { step: SessionStep; edited: string[] } {
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const full = (p: string) => (path.isAbsolute(p) || !cwd ? p : path.resolve(cwd, p));
  const name = SAME_AS[tool] ?? tool;
  if (name === "apply_patch") {
    // One patch can add, change, move and delete several files.
    const text = typeof args.patchText === "string" ? args.patchText : "";
    const edited = [...text.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].map((m) => full(m[1].trim()));
    return { step: { kind: "edit", tool, target: edited[0] ?? null, at: null }, edited: [...new Set(edited)] };
  }
  // OpenCode's arguments are camelCase (filePath) where the other agents' are file_path; 2.x's are `path`, which
  // classify() reads as it is. A skill is named by `name` (2.x's tool takes its `id`), and 2.x names a subagent's
  // type `agent` (packages/core/src/tool/plugin/*.ts, v2.0.12).
  const step = classify(
    name,
    JSON.stringify({
      file_path: args.filePath,
      skill: tool === "skill" ? (args.name ?? args.id) : undefined,
      subagent_type: name === "task" ? (args.subagent_type ?? args.agent) : undefined,
      ...args,
    }),
  );
  if (SAME_AS[tool] && step.kind !== "agent") step.tool = tool;
  if (step.kind === "edit" && step.target) {
    step.target = full(step.target);
    return { step, edited: [step.target] };
  }
  return { step, edited: [] };
}

/** A 1.x session's messages: each message's parts, in order. */
function transcriptV1(h: DatabaseSync, session: OpenCodeSession): OpenCodeMsg[] {
  const messages = h.prepare("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id").all(session.id);
  const parts = new Map<string, Row[]>();
  for (const p of h.prepare("SELECT message_id, time_created, data FROM part WHERE session_id = ? ORDER BY id").all(session.id)) {
    const mid = str(p.message_id);
    if (!mid) continue;
    const list = parts.get(mid) ?? [];
    list.push(p);
    parts.set(mid, list);
  }
  const msgs: OpenCodeMsg[] = [];
  for (const m of messages) {
    const role = parse(m.data)?.role;
    const own = parts.get(str(m.id) ?? "") ?? [];
    if (role === "user") {
      const text = own.map((p) => typedText(parse(p.data))).filter((t): t is string => !!t).join("\n").trim();
      if (text) msgs.push({ role: "user", text, at: iso(m.time_created) });
      continue;
    }
    if (role !== "assistant") continue;
    for (const p of own) {
      const d = parse(p.data);
      const at = iso(p.time_created);
      if (d?.type === "text" && d.synthetic !== true && typeof d.text === "string" && d.text.trim()) msgs.push({ role: "assistant", text: d.text, at });
      else if (d?.type === "tool" && typeof d.tool === "string") {
        const { step, edited } = openCodeStep(d.tool, (d.state as { input?: unknown } | undefined)?.input, session.directory);
        msgs.push({ role: "tool", text: "", step, edited, at });
      }
    }
  }
  return msgs;
}

/**
 * A 2.x session's rows in OpenCode's own order (seq), a fork's copied history
 * included, since that is the conversation it continues. What a row holds is
 * packages/schema/src/session-message.ts: an assistant row's `content` is its
 * text, reasoning and tool calls in order, a tool call `{name, state: {input}}`.
 * A shell row is a command you ran yourself and a skill row a skill you turned
 * on (Session.shell and Session.skill in packages/core/src/session.ts), so both
 * read as steps. Synthetic, system, compaction and the marker rows are
 * OpenCode's own bookkeeping, and reasoning isn't shown, as for 1.x.
 */
function transcriptV2(h: DatabaseSync, session: OpenCodeSession): OpenCodeMsg[] {
  const msgs: OpenCodeMsg[] = [];
  const step = (tool: string, input: unknown, at: string | null) => msgs.push({ role: "tool", text: "", ...openCodeStep(tool, input, session.directory), at });
  for (const r of h.prepare("SELECT type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq").all(session.id)) {
    const d = parse(r.data);
    if (!d) continue;
    const at = iso(r.time_created);
    if (r.type === "user") {
      const text = typeof d.text === "string" ? d.text.trim() : "";
      if (text) msgs.push({ role: "user", text, at });
    } else if (r.type === "assistant" && Array.isArray(d.content)) {
      const done = iso((d.time as { completed?: SQLOutputValue } | undefined)?.completed) ?? at;
      for (const c of d.content as Record<string, unknown>[]) {
        if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) msgs.push({ role: "assistant", text: c.text, at: done });
        else if (c?.type === "tool" && typeof c.name === "string") step(c.name, (c.state as { input?: unknown } | undefined)?.input, iso((c.time as { created?: SQLOutputValue } | undefined)?.created) ?? at);
      }
    } else if (r.type === "shell" && typeof d.command === "string") step("shell", { command: d.command }, at);
    else if (r.type === "skill" && typeof d.name === "string") step("skill", { name: d.name }, at);
  }
  return msgs;
}

/** One session read in full, for the session view: prompt, steps and answer, in order. */
export function openCodeTranscript(id: string): { session: OpenCodeSession; msgs: OpenCodeMsg[] } | null {
  refresh();
  const session = openCodeSession(id);
  if (!session || !state.db) return null;
  let h: DatabaseSync | null = null;
  try {
    h = open(state.db);
    return { session, msgs: state.layout === "v2" ? transcriptV2(h, session) : transcriptV1(h, session) };
  } catch (e) {
    throw new Error(`OpenCode's session database couldn't be read: ${(e as Error).message}`, { cause: e });
  } finally {
    h?.close();
  }
}

/** Drops what was read; for tests. */
export function forgetOpenCode(): void {
  state = EMPTY;
}
