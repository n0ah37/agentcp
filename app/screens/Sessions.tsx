import { useMemo, useRef, useState } from "react";

import type { SessionEvent, SessionSource, SessionSummary, SessionTurn, SessionView, SessionsView, StepKind } from "../../shared/types.ts";
import { agentName, useAgentsOn } from "../agent.ts";
import { qs } from "../api.ts";
import { go, useParams } from "../router.ts";
import { useDebounced, useResource } from "../store.ts";
import { Icon } from "../ui/icons.tsx";
import { Button, Empty, plural, when } from "../ui/kit.tsx";
import { renderMarkdown } from "../ui/markdown.ts";
import { WhoFilter, useEveryone, useWho } from "../ui/who.tsx";
import { useApp } from "../shell/app-context.ts";

/**
 * Agent sessions, from the agents' own session files: what an agent was asked in a project,
 * what it did about it, what it changed, and how to pick it up again.
 */

export const SOURCE: Record<SessionSource, string> = { claude_code: "Claude Code", codex: "Codex", opencode: "OpenCode" };
const ENTRY: Record<string, string> = { "claude-desktop": "Claude app", cli: "Terminal", "claude-vscode": "VS Code", vscode: "VS Code", "sdk-ts": "Agent SDK", "sdk-py": "Agent SDK", codex_cli_rs: "Terminal", codex_vscode: "VS Code", "Codex Desktop": "Codex app" };

export function Sessions() {
  const { project, projectRef } = useApp();
  const [params, setParams] = useParams();
  const scope = params.get("scope") === "project" && project ? project : null;
  const who = useWho(params);
  const on = useAgentsOn();
  const everyone = useEveryone();
  const [q, setQ] = useState(params.get("q") ?? "");
  const query = useDebounced(q.trim(), 250);
  const key = `/api/sessions${qs({ project: scope, q: query || null, limit: "300", agent: who })}`;
  const { data, error } = useResource<SessionsView>(key);

  const selected = params.get("id") ?? data?.sessions[0]?.id ?? null;
  const groups = useMemo(() => byDay(data?.sessions ?? []), [data]);

  if (error) return <Empty title="Sessions couldn't be read.">{error.message}</Empty>;
  return (
    <>
      <header className="head">
        <div className="head-text">
          <h1>Sessions</h1>
        </div>
        <div className="head-actions">
          <WhoFilter who={who} onPick={(a) => setParams({ who: a, id: null })} />
          <select className="select" value={scope ? "project" : "all"} onChange={(e) => setParams({ scope: e.target.value === "project" ? "project" : null, id: null })} aria-label="Projects">
            <option value="all">All projects</option>
            {projectRef && <option value="project">{projectRef.name}</option>}
          </select>
        </div>
      </header>
      {(
        <div className="body three">
          <nav className="pane list sess-list" aria-label="Sessions">
            <div className="listbar">
              {data && <span className="listbar-n">{plural(data.total, "session")}</span>}
              {data?.problem && <p className="banner warn">{data.problem}</p>}
              <label className="search">
                <Icon.search />
                <input type="search" placeholder="Search titles and prompts" value={q} onChange={(e) => setQ(e.target.value)} />
              </label>
            </div>
            {!data ? (
              <Skeleton />
            ) : data.sessions.length === 0 ? (
              <p className="group-note">{query ? `Nothing matches “${query}”.` : `No sessions from ${who ? agentName(who) : everyone}${scope ? " in this project" : ""} yet.`}</p>
            ) : (
              groups.map(([label, items]) => (
                <div key={label} className="group">
                  <div className="group-h"><h2>{label}</h2></div>
                  {items.map((s) => (
                    <button key={s.id} type="button" className="sess" aria-selected={s.id === selected} onClick={() => setParams({ id: s.id })}>
                      <span className="st">{s.title}</span>
                      <span className="sp">{s.match ? <Hit text={s.match} /> : s.preview || "No prompt text."}</span>
                      <span className="sm">
                        {on.length > 1 && (
                          <>
                            <span className={`src ${s.source}`}>{SOURCE[s.source]}</span>
                            <span>·</span>
                          </>
                        )}
                        <span>{plural(s.prompts, "prompt")}</span>
                        {!scope && s.projectDisplay && (
                          <>
                            <span>·</span>
                            <span className="sproj">{repoName(s.projectDisplay)}</span>
                          </>
                        )}
                        <span className="sdate">{clock(s.endedAt)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </nav>
          {selected ? (
            <Reader key={selected} id={selected} />
          ) : (
            <section className="pane center">
              {data && !data.sessions.length && !query ? (
                <Empty title="No sessions yet.">Start {who ? agentName(who) : on.length === 1 ? agentName(on[0]) : "an agent"} in a project, and each session shows up here with what it did.</Empty>
              ) : (
                <Empty title="No session chosen." />
              )}
            </section>
          )}
        </div>
      )}
    </>
  );
}

function Reader({ id }: { id: string }) {
  const { data: s, error } = useResource<SessionView>(`/api/session${qs({ id })}`);
  const turnsRef = useRef<HTMLDivElement>(null);
  if (error) return <section className="pane center"><Empty title="This session couldn't be opened.">{error.message}</Empty></section>;
  if (!s) {
    return (
      <>
        <section className="pane center"><Skeleton /></section>
        <aside className="pane inspector" />
      </>
    );
  }
  const max = Math.max(1, ...s.turns.map((t) => t.steps));
  const jump = (i: number) => turnsRef.current?.querySelectorAll(".turn")[i]?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <>
      <section className="pane center" aria-label={s.title}>
        <div className="reader">
          <div className="reader-in">
            <header className="reader-h">
              <h1>{s.title}</h1>
              <div className="reader-meta">
                <span className={`src ${s.source}`}>{SOURCE[s.source]}{s.entry && ENTRY[s.entry] ? ` · ${ENTRY[s.entry]}` : ""}</span>
                {s.projectDisplay && <span title={s.projectDisplay}><Icon.folder />{short(s.projectDisplay)}</span>}
                {s.branch && <span><Icon.branch />{s.branch}</span>}
                {s.model && <span><Icon.chip />{s.model}</span>}
                {s.startedAt && <span><Icon.clock />{new Date(s.startedAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {span(s.startedAt, s.endedAt)}</span>}
              </div>
              {s.turns.length > 1 && (
                <>
                  <div className="strip" aria-label="Activity, one bar per prompt">
                    {s.turns.map((t, i) => (
                      <i
                        key={i}
                        className={t.events.some((e) => e.type === "step" && e.kind === "edit") ? "e" : t.events.some((e) => e.type === "step" && e.kind === "run") ? "r" : "p"}
                        style={{ ["--h" as string]: `${18 + 82 * Math.sqrt(t.steps / max)}%` }}
                        title={t.prompt ? t.prompt.text.slice(0, 80) : "Agent turn"}
                        onClick={() => jump(i)}
                      />
                    ))}
                  </div>
                  <div className="strip-legend">
                    <span style={{ ["--c" as string]: "var(--sage)" }}>Changed files</span>
                    <span style={{ ["--c" as string]: "var(--amber)" }}>Ran commands</span>
                    <span style={{ ["--c" as string]: "var(--ink-2)" }}>Talked it through</span>
                  </div>
                </>
              )}
            </header>
            <div ref={turnsRef}>
              {s.turns.map((t, i) => (
                <Turn key={i} t={t} source={s.source} />
              ))}
            </div>
          </div>
        </div>
      </section>
      <SessionInspector s={s} />
    </>
  );
}

function Turn({ t, source }: { t: SessionTurn; source: SessionSource }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const [full, setFull] = useState(false);
  const steps = t.events.filter((e): e is Extract<SessionEvent, { type: "step" }> => e.type === "step");
  const edited = new Set(steps.filter((e) => e.kind === "edit" && e.target).map((e) => e.target)).size;
  const ran = steps.filter((e) => e.kind === "run").length;
  const shown = all ? t.events : t.events.slice(0, 60);
  const long = (t.answer?.text.length ?? 0) > 2400;
  return (
    <article className="turn">
      {t.prompt && (
        <>
          <p className="you">{t.prompt.at ? `You · ${clock(t.prompt.at)}` : "You"}</p>
          <p className={`prompt ${t.prompt.text.length > 420 ? "long" : ""}`}>{t.prompt.text}</p>
        </>
      )}
      {t.events.length > 0 && (
        <div className="work" data-open={open}>
          <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <Icon.layers className="glyph" />
            <span>
              <b>Worked {span(t.startedAt, t.endedAt)}</b> · {plural(steps.length, "step")}
              {edited > 0 && <> · changed {plural(edited, "file")}</>}
              {ran > 0 && <> · ran {plural(ran, "command")}</>}
            </span>
            <Icon.chevron className="chev" />
          </button>
          {open && (
            <ol className="events">
              {shown.map((e, i) =>
                e.type === "say" ? (
                  <li key={i} className="ev say">
                    <span />
                    <p>{e.text}</p>
                    <time>{offset(t.startedAt, e.at)}</time>
                  </li>
                ) : (
                  <li key={i} className={`ev ${e.kind}`}>
                    <StepIcon kind={e.kind} />
                    <span className="k" title={e.tool}>{verb(e.kind, e.tool)}</span>
                    <code title={e.target ?? ""}>{e.target ?? ""}</code>
                    <time>{offset(t.startedAt, e.at)}</time>
                  </li>
                ),
              )}
              {!all && t.events.length > 60 && (
                <li className="ev-more"><button type="button" className="linkbtn" onClick={() => setAll(true)}>Show all {t.events.length} steps</button></li>
              )}
            </ol>
          )}
        </div>
      )}
      {t.answer && (
        <div className="answer">
          <p className="answer-h"><span className={`src ${source}`}>{SOURCE[source]}</span> · {clock(t.answer.at)}</p>
          <div className={long && !full ? "clip" : ""}>
            <div className="prose" dangerouslySetInnerHTML={{ __html: renderMarkdown(t.answer.text) }} />
          </div>
          {long && !full && <Button small kind="quiet" onClick={() => setFull(true)}>Show the whole reply</Button>}
        </div>
      )}
    </article>
  );
}

function SessionInspector({ s }: { s: SessionView }) {
  const { toast, setProject } = useApp();
  const copy = async () => {
    if (!s.resume) return;
    try {
      await navigator.clipboard.writeText(s.resume);
      toast({ text: "Copied. Paste it in a terminal to pick the session up where it stopped." });
    } catch {
      toast({ text: "The clipboard wasn't available. Select the command and copy it instead.", tone: "bad" });
    }
  };
  const openInstructions = () => {
    if (!s.project) return;
    setProject(s.project);
    go("instructions", { project: s.project, agent: s.source === "claude_code" ? null : s.source });
  };
  return (
    <aside className="pane inspector" aria-label="About this session">
      <div className="insp">
        {s.resume && (
          <section>
            <h3>Pick it up again</h3>
            <div className="cmdbox">
              <code title={s.resume}>{s.resume}</code>
              <Button small kind="quiet" onClick={copy}><Icon.copy />Copy</Button>
            </div>
          </section>
        )}
        <section>
          <h3>{s.files.length ? `Files it changed · ${s.files.length}` : "Files it changed"}</h3>
          {s.files.length ? (
            <ul className="filelist">
              {s.files.slice(0, 14).map((f) => (
                <li key={f.path} title={f.path}>
                  <code>{tail(f.display, 3)}</code>
                  <span>{f.edits > 1 ? `${f.edits}×` : ""}</span>
                </li>
              ))}
              {s.files.length > 14 && <li className="faint">and {s.files.length - 14} more</li>}
            </ul>
          ) : (
            <p className="clear">It didn't change any files.</p>
          )}
        </section>
        {s.commands.length > 0 && (
          <section>
            <h3>Commands it ran most</h3>
            <ul className="filelist">
              {s.commands.slice(0, 6).map((c) => (
                <li key={c.command} title={c.command}>
                  <code>{c.command}</code>
                  <span>{c.count > 1 ? `${c.count}×` : ""}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {(s.skills.length > 0 || s.subagents.length > 0) && (
          <section>
            <h3>Skills and subagents</h3>
            <div className="chips">
              {s.skills.map((k) => <span key={k} className="tag">{k}</span>)}
              {s.subagents.slice(0, 8).map((a, i) => <span key={i} className="tag" title={a.description}>{a.type}</span>)}
            </div>
          </section>
        )}
        <section>
          <h3>About this session</h3>
          <dl className="facts">
            <dt>Prompts</dt><dd>{s.prompts}</dd>
            <dt>Steps</dt><dd>{s.steps.toLocaleString()}</dd>
            {s.startedAt && <><dt>Started</dt><dd>{new Date(s.startedAt).toLocaleString()}</dd></>}
            {s.endedAt && <><dt>Last active</dt><dd>{when(s.endedAt)}</dd></>}
            {s.entry && <><dt>Ran in</dt><dd>{ENTRY[s.entry] ?? s.entry}</dd></>}
          </dl>
          {s.project && (
            <button type="button" className="doclink" onClick={openInstructions}>
              <Icon.instructions />
              {s.source === "codex" ? "The instruction files Codex reads there" : s.source === "opencode" ? "The instruction files OpenCode reads there" : "The instruction files Claude reads there"}
            </button>
          )}
        </section>
      </div>
    </aside>
  );
}

function StepIcon({ kind }: { kind: StepKind }) {
  const I = { read: Icon.read, edit: Icon.edit, run: Icon.run, search: Icon.search, web: Icon.web, agent: Icon.agent, skill: Icon.skills, plan: Icon.plan, other: Icon.tool }[kind];
  return <I />;
}

function verb(kind: StepKind, tool: string): string {
  switch (kind) {
    case "read": return "Read";
    case "edit": return tool === "Write" || tool === "write" ? "Wrote" : "Edited";
    case "run": return "Ran";
    case "search": return "Searched";
    case "web": return "Looked up";
    case "agent": return tool === "Subagent" ? "Asked a subagent" : tool;
    case "skill": return "Used a skill";
    case "plan": return "Updated the plan";
    default: return tool;
  }
}

function Hit({ text }: { text: string }) {
  const parts = text.split(/(\[\[.*?\]\])/g);
  return <>{parts.map((p, i) => (p.startsWith("[[") ? <mark key={i}>{p.slice(2, -2)}</mark> : <span key={i}>{p}</span>))}</>;
}

function Skeleton() {
  return (
    <div className="skeleton" aria-label="Loading">
      <i style={{ width: "55%" }} />
      <i style={{ width: "90%" }} />
      <i style={{ width: "70%" }} />
      <i style={{ width: "40%", marginTop: 12 }} />
      <i style={{ width: "85%" }} />
    </div>
  );
}

function byDay(list: SessionSummary[]): [string, SessionSummary[]][] {
  const out = new Map<string, SessionSummary[]>();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const s of list) {
    const d = s.endedAt ? new Date(s.endedAt) : null;
    let label = "Undated";
    if (d) {
      const day = new Date(d);
      day.setHours(0, 0, 0, 0);
      const diff = Math.round((today.getTime() - day.getTime()) / 86_400_000);
      label = diff <= 0 ? "Today" : diff === 1 ? "Yesterday" : diff < 7 ? d.toLocaleDateString(undefined, { weekday: "long" }) : d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
    }
    out.set(label, [...(out.get(label) ?? []), s]);
  }
  return [...out];
}

function clock(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function span(a: string | null, b: string | null): string {
  if (!a || !b) return "";
  const s = Math.max(0, (Date.parse(b) - Date.parse(a)) / 1000);
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

function offset(start: string | null, at: string | null): string {
  if (!start || !at) return "";
  const s = Math.max(0, (Date.parse(at) - Date.parse(start)) / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/** A session's project by its repository's name, not its worktree's: …/shop/.claude/worktrees/x is "shop". */
function repoName(p: string): string {
  const at = p.indexOf("/.claude/worktrees/");
  const base = at === -1 ? p : p.slice(0, at);
  return base.split("/").filter(Boolean).pop() ?? p;
}

/** The last few parts of a path, which is where files differ: …/lib/sources/chatgpt.py */
function tail(p: string, n: number): string {
  const parts = p.split("/");
  return parts.length > n + 1 ? `…/${parts.slice(-n).join("/")}` : p;
}

function short(p: string): string {
  const parts = p.split("/");
  return parts.length > 4 ? `…/${parts.slice(-2).join("/")}` : p;
}
