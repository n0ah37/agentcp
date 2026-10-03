import fs from "node:fs";
import path from "node:path";

import type { SessionEvent, SessionSource, SessionStep, SessionSummary, SessionTurn, SessionView, UsageRow, UsageView } from "../../shared/types.ts";
import { classify, cleanPrompt, resumeCommand } from "./session-steps.ts";
import { forgetOpenCode, openCodeDb, openCodeSession, openCodeSessions, openCodeTranscript } from "./opencode-sessions.ts";
import { CLAUDE_DIR, CODEX_DIR, isInside, tilde } from "./paths.ts";

/**
 * The agents' own session files, read directly and only read: Claude Code's
 * transcripts in ~/.claude/projects/<folder>/<session>.jsonl, Codex's in
 * ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl, and OpenCode's one database
 * (opencode-sessions.ts). Nothing is indexed or written; a summary of each
 * file is kept in memory while its size and modification time stay the same,
 * and of each OpenCode session while its messages stay the same.
 *
 * Sessions and Usage both come from here.
 */

/** One response's tokens. `mid` is Claude's message id, so a response is counted once across files. */
type Usage = { day: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; mid?: string };
type Summary = {
  source: SessionSource;
  id: string;
  nativeId: string;
  file: string;
  cwd: string | null;
  title: string | null;
  firstPrompt: string | null;
  prompts: number;
  model: string | null;
  entry: string | null;
  branch: string | null;
  startedAt: string | null;
  endedAt: string | null;
  usage: Usage[];
  /** OpenCode: the session a subagent's session was started from. */
  parent?: string | null;
};
/** A session file, or with `sid` one session in OpenCode's database. */
type Ref = { file: string; source: SessionSource; mtime: number; size: number; sid?: string };

const cache = new Map<string, { key: string; s: Summary }>();

/** A line's time, or null when it isn't a real date (a hand-edited or damaged session file). */
function stamp(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  return Number.isNaN(new Date(v).getTime()) ? null : v;
}

function day(at: string | null): string {
  const d = at ? new Date(at) : new Date();
  return Number.isNaN(d.getTime()) ? "unknown" : d.toLocaleDateString("en-CA");
}

function lines(file: string): string[] {
  try {
    return fs.readFileSync(file, "utf8").split("\n");
  } catch {
    return [];
  }
}

function json(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ Claude Code

type ClaudeLine = {
  type?: string;
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  cwd?: string;
  gitBranch?: string;
  entrypoint?: string;
  timestamp?: string;
  customTitle?: string;
  message?: { id?: string; role?: string; model?: string; content?: unknown; usage?: Record<string, number> };
};

/** What you typed in a Claude Code user line, or "" for tool results, meta lines and host additions. */
function claudePrompt(o: ClaudeLine): string {
  if (o.type !== "user" || o.isMeta || o.isSidechain || o.isCompactSummary) return "";
  const c = o.message?.content;
  if (typeof c === "string") return cleanPrompt(c);
  if (!Array.isArray(c)) return "";
  if (c.some((p) => (p as { type?: string }).type === "tool_result")) return "";
  return cleanPrompt(c.filter((p) => (p as { type?: string }).type === "text").map((p) => (p as { text?: string }).text ?? "").join("\n"));
}

function summarizeClaude(file: string): Summary {
  const s: Summary = { source: "claude_code", id: "", nativeId: path.basename(file, ".jsonl"), file, cwd: null, title: null, firstPrompt: null, prompts: 0, model: null, entry: null, branch: null, startedAt: null, endedAt: null, usage: [] };
  s.id = `claude_code:${s.nativeId}`;
  const counted = new Set<string>();
  for (const line of lines(file)) {
    if (!line.includes('"type"')) continue;
    const isUser = line.includes('"type":"user"');
    const isAssistant = line.includes('"type":"assistant"');
    const isTitle = line.includes('"custom-title"');
    if (!isUser && !isAssistant && !isTitle) continue;
    const o = json(line) as ClaudeLine | null;
    if (!o) continue;
    if (o.type === "custom-title" && o.customTitle) s.title = o.customTitle;
    if (o.type !== "user" && o.type !== "assistant") continue;
    s.cwd ??= o.cwd ?? null;
    s.branch ??= o.gitBranch ?? null;
    s.entry ??= o.entrypoint ?? null;
    const ts = stamp(o.timestamp);
    if (ts) {
      s.startedAt ??= ts;
      s.endedAt = ts;
    }
    const typed = claudePrompt(o);
    if (typed) {
      s.prompts++;
      s.firstPrompt ??= typed;
    }
    const u = o.message?.usage;
    // A streamed response is written as several lines that repeat its usage; count it once.
    const mid = o.message?.id;
    if (o.type === "assistant" && u && (!mid || !counted.has(mid))) {
      if (mid) counted.add(mid);
      if (o.message?.model && o.message.model !== "<synthetic>") s.model = o.message.model;
      s.usage.push({
        mid,
        day: day(stamp(o.timestamp)),
        model: o.message?.model ?? "unknown",
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      });
    }
  }
  return s;
}

function readClaude(file: string): { msgs: Msg[] } {
  const msgs: Msg[] = [];
  for (const line of lines(file)) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    const o = json(line) as ClaudeLine | null;
    if (!o || o.isSidechain) continue;
    const at = stamp(o.timestamp);
    const typed = claudePrompt(o);
    if (typed) {
      msgs.push({ role: "user", text: typed, at });
      continue;
    }
    if (o.type !== "assistant" || !Array.isArray(o.message?.content)) continue;
    for (const p of o.message.content as { type?: string; text?: string; name?: string; input?: unknown }[]) {
      if (p.type === "text" && p.text?.trim()) msgs.push({ role: "assistant", text: p.text, at });
      else if (p.type === "tool_use") msgs.push({ role: "tool", text: "", tool: p.name ?? "tool", input: JSON.stringify(p.input ?? {}), at });
    }
  }
  return { msgs };
}

// ------------------------------------------------------------------ Codex

type CodexLine = { timestamp?: string; type?: string; payload?: Record<string, unknown> };

/** Codex puts its own context into the conversation as user messages: the environment, AGENTS.md, instructions. */
function injected(text: string): boolean {
  const t = text.trimStart();
  return /^<(environment_context|user_instructions|permissions instructions|INSTRUCTIONS|app-context|turn_aborted)\b/.test(t) || t.startsWith("# AGENTS.md instructions");
}

function codexText(p: Record<string, unknown>, kind: "input_text" | "output_text"): string {
  const content = Array.isArray(p.content) ? (p.content as { type?: string; text?: string }[]) : [];
  return content.filter((c) => c.type === kind).map((c) => c.text ?? "").join("\n").trim();
}

let codexIndex: { key: string; names: Map<string, string> } | null = null;

/** Session names Codex keeps in ~/.codex/session_index.jsonl. */
function codexNames(): Map<string, string> {
  const f = path.join(CODEX_DIR, "session_index.jsonl");
  let key: string;
  try {
    const st = fs.statSync(f);
    key = `${st.size}:${st.mtimeMs}`;
  } catch {
    return new Map();
  }
  if (codexIndex?.key === key) return codexIndex.names;
  const names = new Map<string, string>();
  for (const line of lines(f)) {
    const o = json(line) as { id?: string; thread_name?: string } | null;
    if (o?.id && o.thread_name) names.set(o.id, o.thread_name);
  }
  codexIndex = { key, names };
  return names;
}

function summarizeCodex(file: string): Summary {
  const s: Summary = { source: "codex", id: "", nativeId: "", file, cwd: null, title: null, firstPrompt: null, prompts: 0, model: null, entry: null, branch: null, startedAt: null, endedAt: null, usage: [] };
  let last = { input: 0, cached: 0, write: 0, output: 0 };
  for (const line of lines(file)) {
    if (!line) continue;
    const quick = line.slice(0, 120);
    if (!/"type":"(session_meta|turn_context|response_item|event_msg)"/.test(quick) && !quick.includes("session_meta")) continue;
    const o = json(line) as CodexLine | null;
    const p = o?.payload;
    if (!o || !p) continue;
    const ts = stamp(o.timestamp);
    if (ts) {
      s.startedAt ??= ts;
      s.endedAt = ts;
    }
    if (o.type === "session_meta") {
      s.nativeId = String(p.id ?? p.session_id ?? "");
      s.cwd = typeof p.cwd === "string" ? p.cwd : null;
      s.entry = typeof p.originator === "string" ? p.originator : null;
      const git = p.git as { branch?: string } | undefined;
      s.branch = git?.branch ?? null;
    } else if (o.type === "turn_context" && typeof p.model === "string") {
      s.model = p.model;
    } else if (o.type === "response_item" && p.type === "message" && p.role === "user") {
      const t = codexText(p, "input_text");
      if (t && !injected(t)) {
        s.prompts++;
        s.firstPrompt ??= t;
      }
    } else if (o.type === "event_msg" && p.type === "token_count") {
      const tot = (p.info as { total_token_usage?: Record<string, number> } | null)?.total_token_usage;
      if (!tot) continue;
      // Totals are running sums for the session; each step adds the difference.
      const now = { input: tot.input_tokens ?? 0, cached: tot.cached_input_tokens ?? 0, write: tot.cache_write_input_tokens ?? 0, output: tot.output_tokens ?? 0 };
      const d = { input: now.input - last.input, cached: now.cached - last.cached, write: now.write - last.write, output: now.output - last.output };
      last = now;
      if (d.input <= 0 && d.output <= 0) continue;
      // OpenAI counts cached tokens inside input_tokens; split them out to match Claude's columns.
      s.usage.push({ day: day(stamp(o.timestamp)), model: s.model ?? "unknown", input: Math.max(0, d.input - d.cached), output: Math.max(0, d.output), cacheRead: Math.max(0, d.cached), cacheWrite: Math.max(0, d.write) });
    }
  }
  if (!s.nativeId) s.nativeId = /([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/.exec(file)?.[1] ?? path.basename(file, ".jsonl");
  s.id = `codex:${s.nativeId}`;
  s.title = codexNames().get(s.nativeId) ?? null;
  return s;
}

function readCodex(file: string): { msgs: Msg[] } {
  const msgs: Msg[] = [];
  for (const line of lines(file)) {
    if (!line.includes('"response_item"')) continue;
    const o = json(line) as CodexLine | null;
    const p = o?.payload;
    if (!o || !p) continue;
    const at = stamp(o.timestamp);
    if (p.type === "message" && p.role === "user") {
      const t = codexText(p, "input_text");
      if (t && !injected(t)) msgs.push({ role: "user", text: t, at });
    } else if (p.type === "message" && p.role === "assistant") {
      const t = codexText(p, "output_text");
      if (t) msgs.push({ role: "assistant", text: t, at });
    } else if (p.type === "function_call" || p.type === "custom_tool_call" || p.type === "local_shell_call") {
      const input = typeof p.arguments === "string" ? p.arguments : typeof p.input === "string" ? p.input : JSON.stringify(p.action ?? {});
      msgs.push({ role: "tool", text: "", tool: String(p.name ?? p.type), input, at });
    }
  }
  return { msgs };
}

// --------------------------------------------------------------- OpenCode

/** An OpenCode session as the other agents' summaries read; kept while the session's signature holds. */
function summarizeOpenCode(f: Ref): Summary {
  const o = f.sid ? openCodeSession(f.sid) : null;
  const k = `${f.file}#${f.sid}`;
  const hit = cache.get(k);
  if (o && hit?.key === o.sig) return hit.s;
  const s: Summary = {
    source: "opencode",
    id: `opencode:${f.sid}`,
    nativeId: f.sid ?? "",
    file: f.file,
    cwd: o?.directory ?? null,
    title: o?.title ?? null,
    firstPrompt: o?.firstPrompt ?? null,
    prompts: o?.prompts ?? 0,
    model: o?.model ?? null,
    entry: null,
    branch: null,
    startedAt: o?.startedAt ?? null,
    endedAt: o?.endedAt ?? null,
    usage: (o?.usage ?? []).map((u) => ({ day: day(new Date(u.at).toISOString()), model: u.model, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite })),
    parent: o?.parent ?? null,
  };
  // A subagent's session ran where its parent did.
  if (!s.cwd && s.parent) s.cwd = openCodeSession(s.parent)?.directory ?? null;
  if (o) cache.set(k, { key: o.sig, s });
  return s;
}

// ------------------------------------------------------------- the files

function walk(dir: string, depth: number, match: (n: string) => boolean, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) walk(p, depth - 1, match, out);
    else if (e.isFile() && match(e.name)) out.push(p);
  }
  return out;
}

/**
 * Every session file, newest first, with its modification time. With
 * `nested`, Claude Code's subagent and workflow transcripts too, which it
 * keeps in a folder per session (<session>/subagents/…): they aren't
 * sessions of their own, but their tokens are spent all the same. OpenCode's
 * sessions are rows of one database; `nested` brings its subagents' sessions
 * and the ones you archived, for the same reason.
 */
function files(sources: SessionSource[], sinceMs = 0, nested = false): Ref[] {
  const out: Ref[] = [];
  const add = (file: string, src: SessionSource) => {
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs >= sinceMs) out.push({ file, source: src, mtime: st.mtimeMs, size: st.size });
    } catch {
      /* gone */
    }
  };
  if (sources.includes("claude_code")) for (const f of walk(path.join(CLAUDE_DIR, "projects"), nested ? 4 : 1, (n) => n.endsWith(".jsonl"))) add(f, "claude_code");
  if (sources.includes("codex")) for (const f of walk(path.join(CODEX_DIR, "sessions"), 3, (n) => n.startsWith("rollout-") && n.endsWith(".jsonl"))) add(f, "codex");
  if (sources.includes("opencode")) {
    const db = openCodeDb() ?? "";
    for (const s of openCodeSessions()) if ((nested || (!s.parent && !s.archived)) && s.updated >= sinceMs) out.push({ file: db, source: "opencode", mtime: s.updated, size: 0, sid: s.id });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function summary(f: Ref): Summary {
  if (f.source === "opencode") return summarizeOpenCode(f);
  const key = `${f.size}:${f.mtime}`;
  const hit = cache.get(f.file);
  if (hit?.key === key) return hit.s;
  const s = f.source === "codex" ? summarizeCodex(f.file) : summarizeClaude(f.file);
  cache.set(f.file, { key, s });
  return s;
}

/**
 * Summaries of many files without holding up the engine: the first read of a
 * big ~/.claude takes seconds, and the engine serves every screen, so the
 * loop hands control back every few dozen milliseconds.
 */
async function eachSummary(list: Ref[], fn: (f: Ref, s: Summary) => boolean | void): Promise<void> {
  let t = Date.now();
  for (const f of list) {
    if (fn(f, summary(f)) === false) return;
    if (Date.now() - t > 30) {
      await new Promise((r) => setImmediate(r));
      t = Date.now();
    }
  }
}

/** Reads every session file once, in the background, so Sessions and Usage open quickly. */
export function warmTranscripts(sources: SessionSource[]): void {
  setTimeout(() => void eachSummary(files(sources, Date.now() - 371 * 86_400_000, true), () => undefined), 2000);
}

function toSummary(s: Summary): SessionSummary {
  const title = s.title ?? (s.firstPrompt ? s.firstPrompt.replace(/\s+/g, " ").slice(0, 90) : "Untitled session");
  return {
    id: s.id,
    source: s.source,
    title,
    project: s.cwd,
    projectDisplay: s.cwd ? tilde(s.cwd) : null,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    model: s.model,
    entry: s.entry,
    prompts: s.prompts,
    preview: (s.firstPrompt ?? "").replace(/\s+/g, " ").slice(0, 220),
    match: null,
  };
}

const inProject = (cwd: string | null, project: string) => !!cwd && (cwd === project || isInside(cwd, project) || cwd.startsWith(project + path.sep));

export async function fileSessions(opts: { project: string | null; q: string | null; sources: SessionSource[]; limit?: number }): Promise<{ sessions: SessionSummary[]; total: number }> {
  const limit = opts.limit ?? 300;
  const needle = opts.q?.trim().toLowerCase() ?? "";
  const out: SessionSummary[] = [];
  let total = 0;
  // Newest first; a project's sessions are found by the folder each one ran in.
  await eachSummary(files(opts.sources), (_f, s) => {
    if (!s.prompts) return;
    if (opts.project && !inProject(s.cwd, opts.project)) return;
    if (needle && !(s.title ?? "").toLowerCase().includes(needle) && !(s.firstPrompt ?? "").toLowerCase().includes(needle)) return;
    total++;
    if (out.length < limit) out.push(toSummary(s));
  });
  return { sessions: out, total };
}

/** A line of a session: what was typed, what was said, or a tool call (`step` when it's already classified, `edited` when it changed several files). */
type Msg = { role: "user" | "assistant" | "tool"; text: string; tool?: string; input?: string; step?: SessionStep; edited?: string[]; at: string | null };

function readSession(source: SessionSource, nativeId: string): { s: Summary; msgs: Msg[] } | null {
  if (source === "opencode") {
    const o = openCodeTranscript(nativeId);
    if (!o) return null;
    return { s: summarizeOpenCode({ file: openCodeDb() ?? "", source, mtime: o.session.updated, size: 0, sid: o.session.id }), msgs: o.msgs };
  }
  const f = files([source]).find((x) => (source === "codex" ? x.file.includes(nativeId) : path.basename(x.file, ".jsonl") === nativeId));
  if (!f) return null;
  return { s: summary(f), msgs: (source === "codex" ? readCodex(f.file) : readClaude(f.file)).msgs };
}

export function fileSession(id: string): SessionView | null {
  const [source, nativeId] = id.split(/:(.+)/) as [SessionSource, string];
  const read = nativeId ? readSession(source, nativeId) : null;
  if (!read) return null;
  const { s, msgs } = read;

  const turns: SessionTurn[] = [];
  let cur: SessionTurn | null = null;
  const files_ = new Map<string, number>();
  const commands = new Map<string, number>();
  const skills = new Set<string>();
  const subagents: { type: string; description: string }[] = [];
  let steps = 0;
  for (const m of msgs) {
    if (m.role === "user") {
      cur = { prompt: { text: m.text, at: m.at }, events: [], answer: null, startedAt: m.at, endedAt: m.at, steps: 0 };
      turns.push(cur);
      continue;
    }
    const t: SessionTurn = cur ?? (cur = { prompt: null, events: [], answer: null, startedAt: m.at, endedAt: m.at, steps: 0 });
    if (!turns.includes(t)) turns.push(t);
    t.endedAt = m.at ?? t.endedAt;
    if (m.role === "assistant") t.events.push({ type: "say", text: m.text, at: m.at });
    else {
      const st = { ...(m.step ?? classify(m.tool ?? "tool", m.input ?? "")), at: m.at };
      t.events.push({ type: "step", ...st });
      t.steps++;
      steps++;
      if (st.kind === "edit") for (const p of m.edited ?? (st.target ? [st.target] : [])) files_.set(p, (files_.get(p) ?? 0) + 1);
      if (st.kind === "run" && st.target) {
        const c = st.target.replace(/\s+/g, " ").slice(0, 90);
        commands.set(c, (commands.get(c) ?? 0) + 1);
      }
      if (st.kind === "skill" && st.target) skills.add(st.target);
      if (st.kind === "agent") subagents.push({ type: st.tool, description: st.target ?? "" });
    }
  }
  for (const t of turns) {
    const i = t.events.map((e) => e.type).lastIndexOf("say");
    if (i !== -1) {
      const e = t.events[i] as Extract<SessionEvent, { type: "say" }>;
      t.answer = { text: e.text, at: e.at };
      t.events.splice(i, 1);
    }
  }
  const proj = s.cwd;
  const show = (p: string) => (proj && isInside(p, proj) ? path.relative(proj, p) || path.basename(p) : tilde(p));
  return {
    ...toSummary(s),
    branch: s.branch,
    turns: turns.filter((t) => t.prompt || t.answer || t.events.length),
    files: [...files_].sort((a, b) => b[1] - a[1]).map(([p, edits]) => ({ path: p, display: show(p), edits })),
    commands: [...commands].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([command, count]) => ({ command, count })),
    skills: [...skills],
    subagents,
    resume: resumeCommand(s.source, s.nativeId, proj),
    steps,
  };
}

// ------------------------------------------------------------------ usage

/**
 * Tokens over the last `days` days, from the usage each agent records with
 * every response, and a year of daily totals for the activity grid.
 *
 * Claude Code writes one response as several lines, one per thinking, text
 * or tool block, and repeats the response's usage on each; counting each line
 * would count most responses two or three times. A response is counted once,
 * by its message id, including the ones in subagent and workflow
 * transcripts. Codex counts cached tokens inside its input; they are split
 * out here so the two read the same. OpenCode records each model call once
 * (a step-finish part in 1.x, an assistant row in 2.x; opencode-sessions.ts),
 * its subagents' calls in sessions of their own, which
 * count here but aren't sessions; its reasoning is counted as output.
 */
export async function usageView(opts: { days: number; sources: SessionSource[]; project: string | null }): Promise<UsageView> {
  const YEAR = 371; // 53 weeks, so the grid starts on a full week
  const since = Date.now() - Math.max(opts.days, YEAR) * 86_400_000;
  const firstDay = day(new Date(Date.now() - (opts.days - 1) * 86_400_000).toISOString());
  const firstYearDay = day(new Date(Date.now() - (YEAR - 1) * 86_400_000).toISOString());
  const byDay = new Map<string, UsageRow>();
  const byModel = new Map<string, UsageRow>();
  const byProject = new Map<string, UsageRow & { project: string }>();
  const yearly = new Map<string, number>();
  const zero = (): UsageRow => ({ label: "", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: 0 });
  const totals = zero();
  const counted = new Set<string>();
  let prompts = 0;
  const topLevel = (file: string) => !file.includes(`${path.sep}subagents${path.sep}`) && path.dirname(path.dirname(file)) === path.join(CLAUDE_DIR, "projects");
  await eachSummary(files(opts.sources, since, true), (f, s) => {
    if (opts.project && !inProject(s.cwd, opts.project)) return;
    const session = f.source === "codex" || (f.source === "opencode" ? !s.parent : topLevel(f.file));
    const proj = s.cwd ?? "unknown";
    let inRange = false;
    const seenDay = new Set<string>();
    for (const u of s.usage) {
      if (u.day < firstYearDay) continue;
      if (u.mid) {
        if (counted.has(u.mid)) continue;
        counted.add(u.mid);
      }
      const all = u.input + u.output + u.cacheRead + u.cacheWrite;
      yearly.set(u.day, (yearly.get(u.day) ?? 0) + all);
      if (u.day < firstDay) continue;
      inRange = true;
      const d = byDay.get(u.day) ?? { ...zero(), label: u.day };
      const m = byModel.get(u.model) ?? { ...zero(), label: u.model };
      const pr = byProject.get(proj) ?? { ...zero(), label: s.cwd ? tilde(s.cwd) : "Unknown folder", project: proj };
      for (const r of [totals, d, m, pr]) {
        r.input += u.input;
        r.output += u.output;
        r.cacheRead += u.cacheRead;
        r.cacheWrite += u.cacheWrite;
      }
      if (session && !seenDay.has(u.day)) {
        d.sessions++;
        seenDay.add(u.day);
      }
      byDay.set(u.day, d);
      byModel.set(u.model, m);
      byProject.set(proj, pr);
    }
    if (inRange && session) {
      totals.sessions++;
      prompts += s.prompts;
      byProject.get(proj)!.sessions++;
    }
  });
  const days: UsageRow[] = [];
  for (let i = opts.days - 1; i >= 0; i--) {
    const key = day(new Date(Date.now() - i * 86_400_000).toISOString());
    days.push(byDay.get(key) ?? { ...zero(), label: key });
  }
  const year: { day: string; tokens: number }[] = [];
  for (let i = YEAR - 1; i >= 0; i--) {
    const key = day(new Date(Date.now() - i * 86_400_000).toISOString());
    year.push({ day: key, tokens: yearly.get(key) ?? 0 });
  }
  const sum = (r: UsageRow) => r.input + r.output + r.cacheRead + r.cacheWrite;
  return {
    days: opts.days,
    totals,
    prompts,
    byDay: days,
    year,
    byModel: [...byModel.values()].sort((a, b) => sum(b) - sum(a)),
    byProject: [...byProject.values()].sort((a, b) => sum(b) - sum(a)).slice(0, 12),
  };
}

/** Drops the per-file summaries; for tests. */
export function forgetTranscripts(): void {
  cache.clear();
  codexIndex = null;
  forgetOpenCode();
}
