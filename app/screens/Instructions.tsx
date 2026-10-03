import type { CodexEntry, CodexView, CombinedView, InstructionsMode, InstructionsView, MissingSlot, SharePlan, StackEntry, WritePlan } from "../../shared/types.ts";
import { useAgent } from "../agent.ts";
import { ApiError, api, qs } from "../api.ts";
import { useParams } from "../router.ts";
import { useResource } from "../store.ts";
import { Button, DocLink, Empty, Tally, plural } from "../ui/kit.tsx";
import { useApp } from "../shell/app-context.ts";
import { FileWorkspace } from "../shell/FileWorkspace.tsx";
import { setHeadSlot } from "../shell/headslot.ts";
import { DocRules } from "./Codex.tsx";
import { OpencodeInstructions } from "./OpenCode.tsx";

const MODES: { value: InstructionsMode; label: string }[] = [
  { value: "claude-md-or-agents-md", label: "CLAUDE.md, else AGENTS.md" },
  { value: "claude-md-and-agents-md", label: "CLAUDE.md and AGENTS.md" },
  { value: "claude-md", label: "CLAUDE.md only" },
  { value: "managed-only", label: "Only your organization's" },
];

const DOT: Record<string, string> = {
  managed: "var(--ink)",
  "user-claude-md": "var(--ink-2)",
  "user-rule": "var(--graphite)",
  "claude-md": "var(--ink-2)",
  local: "var(--sage)",
  rule: "var(--graphite)",
  "agents-md": "var(--focus)",
  import: "var(--faint)",
  "memory-index": "var(--amber)",
};

function subtitle(e: StackEntry): string {
  if (e.file.unreadable) return "AgentCP can't read it";
  if (e.loads === "not-read") return e.reason ?? "Not read";
  if (e.loads === "on-demand") return e.reason ?? "When Claude opens a file here";
  if (e.file.kind === "memory-index") return `${plural(e.file.lines, "line")} · the first 200 load`;
  if (e.file.kind === "import") return `${plural(e.file.lines, "line")} · ${e.where.charAt(0).toLowerCase()}${e.where.slice(1)}`;
  return plural(e.file.lines, "line");
}

function nameOf(e: StackEntry): string {
  if (e.file.kind === "memory-index") return "MEMORY.md";
  if (e.file.kind === "rule" || e.file.kind === "user-rule") return `rules/${e.file.name}`;
  return e.file.kind === "claude-md" && e.file.display.endsWith("/.claude/CLAUDE.md") ? ".claude/CLAUDE.md" : e.file.name;
}

/** Claude Code's files or Codex's, by the agent chosen in the sidebar. */
export function Instructions() {
  const agent = useAgent();
  return agent === "codex" ? <CodexInstructions /> : agent === "opencode" ? <OpencodeInstructions /> : <ClaudeInstructions />;
}

function ClaudeInstructions() {
  const { project, save, toast, openDoc } = useApp();
  const [params, setParams] = useParams();
  const { data: view, error } = useResource<InstructionsView>(`/api/instructions${qs({ project })}`);
  const combined = params.get("view") === "combined";

  if (error) return <Empty title="The instruction files couldn't be read.">{error.message}</Empty>;
  if (!view) return <Loading />;

  const chosen = params.get("file");
  const launch = view.entries.filter((e) => e.loads === "launch");
  const selected =
    view.entries.find((e) => e.file.path === chosen) ??
    view.missing.find((m) => m.path === chosen) ??
    (project ? launch.find((e) => e.level === `dir:${project}` && e.file.kind === "claude-md") : null) ??
    launch[0] ??
    view.missing[0];
  const selPath = selected ? ("file" in selected ? selected.file.path : selected.path) : null;
  const entry = selected && "file" in selected ? selected : null;
  const slot = selected && !("file" in selected) ? selected : null;
  const pick = (p: string) => setParams({ file: p, view: null });

  const setMode = async (mode: InstructionsMode) => {
    try {
      const planned = await api.post<{ plan: WritePlan; content: string; baseHash: string | null }>("/api/settings/plan", {
        project: null,
        scope: "user",
        path: ["pluginConfigs", "agents-md@builtin", "options", "instructionFiles"],
        value: mode === "claude-md-or-agents-md" ? null : mode,
      });
      save({ path: planned.plan.path, content: planned.content, baseHash: planned.baseHash, project, planned, title: "Change which instruction files Claude reads?" });
    } catch (e) {
      toast({ text: e instanceof ApiError ? e.message : String(e), tone: "bad" });
    }
  };

  const { files, lines, tokens } = view.totals;
  return (
    <>
      <header className="head cols">
        <div className="head-text">
          <h1>Instructions</h1>
        </div>
        <div className="head-file" ref={setHeadSlot} />
        <div className="head-actions" />
      </header>
      <div className={`body ${combined ? "two" : "three"}`}>
        <nav className="pane list" aria-label="Instruction files, by folder">
          <div className="listbar">
            <div className="seg" role="group" aria-label="Show">
              <button type="button" aria-pressed={!combined} onClick={() => setParams({ view: null })}>Files</button>
              <button type="button" aria-pressed={combined} onClick={() => setParams({ view: "combined" })}>Combined</button>
            </div>
            <span className="listbar-n" title="Read before your first message">{plural(files, "file")} · {plural(lines, "line")} · ~{approx(tokens)} tokens</span>
          </div>
          <Tree view={view} selected={combined ? null : selPath} onPick={pick} />
          <div className="list-foot">
            {view.agentsMdSupported ? (
              <label>
                <span>In each folder, read</span>
                <span className="row">
                  <select aria-label="Which instruction files Claude reads in each folder" className="select" value={view.mode} onChange={(e) => setMode(e.target.value as InstructionsMode)}>
                    {MODES.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                  <DocLink icon doc={{ slug: "memory", anchor: "choose-which-instruction-files-load", url: "https://code.claude.com/docs/en/memory#choose-which-instruction-files-load" }} onOpen={openDoc} label="Which instruction files load" />
                </span>
              </label>
            ) : (
              <p>Claude Code {view.claudeVersion} reads CLAUDE.md only. Reading AGENTS.md needs version 2.1.277 or later.</p>
            )}
          </div>
        </nav>
        {combined ? (
          <Combined project={project} onOpen={pick} />
        ) : selPath ? (
          <FileWorkspace
            key={selPath}
            path={selPath}
            formattable={selPath.endsWith(".md")}
            template={slot?.template}
            facts={entry ? [["Loads", entry.loads === "launch" ? "At the start of every session" : subtitle(entry)]] : slot ? [["Would load", "At the start of every session"]] : []}
          />
        ) : (
          <section className="pane center">
            <Empty title="No instruction files here.">Claude reads nothing but its own system prompt in this folder.</Empty>
          </section>
        )}
      </div>
    </>
  );
}

/** The folder hierarchy as one spine: each level, the files it holds, and the ones it could hold. */
function Tree({ view, selected, onPick }: { view: InstructionsView; selected: string | null; onPick: (p: string) => void }) {
  const levels = view.levels.filter((l) => view.entries.some((e) => e.level === l.key) || view.missing.some((m) => m.level === l.key));
  const chain = levels.filter((l) => l.kind !== "subfolder");
  return (
    <div className="tree">
      {levels.map((l) => {
        const entries = view.entries.filter((e) => e.level === l.key);
        const missing = view.missing.filter((m) => m.level === l.key);
        const i = chain.indexOf(l);
        const pos = l.kind === "subfolder" ? "" : chain.length === 1 ? "only" : i === 0 ? "first" : i === chain.length - 1 ? "last" : "";
        const skipped = entries.length > 0 && entries.every((e) => e.loads === "not-read") && l.kind === "folder";
        return (
          <section key={l.key} className={`lvl ${l.kind === "subfolder" ? "sub" : ""} ${l.kind === "project" ? "project" : ""} ${skipped ? "skipped" : ""} ${pos}`} style={{ ["--d" as string]: l.depth }} aria-label={l.label}>
            <div className="lvl-h" title={l.path ?? undefined}>
              <b>{l.label}</b>
              <span>{l.covers}</span>
            </div>
            {entries.map((e) => (
              <Row key={e.id} e={e} selected={selected === e.file.path} onPick={onPick} />
            ))}
            {missing.map((m) => (
              <Ghost key={m.id} m={m} selected={selected === m.path} onPick={onPick} />
            ))}
          </section>
        );
      })}
    </div>
  );
}

function Row({ e, selected, onPick }: { e: StackEntry; selected: boolean; onPick: (p: string) => void }) {
  const { fileMenu } = useApp();
  return (
    <button
      type="button"
      className={`item ${e.loads === "not-read" ? "dim" : ""}`}
      aria-selected={selected}
      onClick={() => onPick(e.file.path)}
      onContextMenu={(ev) => (ev.preventDefault(), fileMenu(ev, e.file, { canDelete: e.file.kind !== "managed" && e.file.kind !== "user-claude-md" }))}
      title={e.file.display}
    >
      <span className="dot" style={{ ["--c" as string]: e.loads === "on-demand" ? "var(--faint)" : DOT[e.file.kind] ?? "var(--faint)" }} />
      <span className="t">
        <span className="indent" style={{ ["--depth" as string]: e.depth }} />
        {e.depth > 0 && <span className="faint">↳ </span>}
        {nameOf(e)}
      </span>
      <span className="m"><Tally counts={e.counts} /></span>
      <span className="s">
        <span className="indent" style={{ ["--depth" as string]: e.depth }} />
        {subtitle(e)}
      </span>
    </button>
  );
}

export function Ghost({ m, selected, onPick }: { m: MissingSlot; selected: boolean; onPick: (p: string) => void }) {
  return (
    <button type="button" className="item ghost" aria-selected={selected} onClick={() => onPick(m.path)}>
      <span className="dot" />
      <span className="t">{m.label}</span>
      <span className="m">not created</span>
      <span className="s">{m.hint}</span>
    </button>
  );
}

function Combined({ project, onOpen }: { project: string | null; onOpen: (p: string) => void }) {
  const { data, error } = useResource<CombinedView>(`/api/instructions/combined${qs({ project })}`);
  if (error) return <section className="pane center"><Empty title="The files couldn't be joined.">{error.message}</Empty></section>;
  if (!data) return <section className="pane center"><Loading /></section>;
  return (
    <section className="pane center" aria-label="As Claude reads it">
      <div className="reader">
        <div className="combined">
          <div className="combined-h">
            <h2>What Claude reads, in order</h2>
            <p>
              {plural(data.sections.length, "file")} · {plural(data.totals.lines, "line")} · ~{approx(data.totals.tokens)} tokens. Block comments are left out, as Claude Code leaves them out.
            </p>
          </div>
          {data.sections.map((s, i) => (
            <article key={s.path} className="cmb">
              <div className="cmb-h" title={s.display}>
                <span className="n">{i + 1}</span>
                <b>{s.name}</b>
                <span>{s.where} · {plural(s.lines, "line")}</span>
                <Button small kind="quiet" onClick={() => onOpen(s.path)}>Open</Button>
              </div>
              <pre>{s.text}</pre>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function codexSubtitle(e: CodexEntry): string {
  if (e.file.unreadable) return "AgentCP can't read it";
  if (e.loads === "read") return plural(e.file.lines, "line");
  return e.reason ?? "Not read";
}

/** What Codex reads for the project: one file per folder, root first, up to its budget. */
function CodexInstructions() {
  const { project, save, toast, fileMenu } = useApp();
  const [params, setParams] = useParams();
  const { data: view, error, reload } = useResource<CodexView>(`/api/codex${qs({ project })}`);
  if (error) return <Empty title="Codex's files couldn't be read.">{error.message}</Empty>;
  if (!view) return <Loading />;

  const chosen = params.get("file");
  const selected = view.entries.find((e) => e.file.path === chosen) ?? view.missing.find((m) => m.path === chosen) ?? view.entries.find((e) => e.loads !== "not-read" && e.level !== "codex-home") ?? view.entries[0] ?? view.missing[0];
  const selPath = selected ? ("file" in selected ? selected.file.path : selected.path) : null;
  const entry = selected && "file" in selected ? selected : null;
  const slot = selected && !("file" in selected) ? selected : null;
  const pick = (p: string) => setParams({ file: p });
  const pct = Math.min(100, Math.round((view.totals.bytes / view.totals.budget) * 100));

  const share = async () => {
    try {
      const plan = await api.post<SharePlan>("/api/codex/share", { project });
      if (plan.note) toast({ text: plan.note });
      // Each write is reviewed on its own; the next opens once the one before it is saved.
      const run = (i: number): void => {
        const st = plan.steps[i];
        if (!st) return void reload();
        save({ path: st.path, content: st.content, baseHash: st.baseHash, project, title: st.title, onSaved: () => run(i + 1) });
      };
      run(0);
    } catch (e) {
      toast({ text: e instanceof ApiError ? e.message : String(e), tone: "bad" });
    }
  };

  return (
    <>
      <header className="head cols">
        <div className="head-text">
          <h1>Instructions</h1>
        </div>
        <div className="head-file" ref={setHeadSlot} />
        <div className="head-actions" />
      </header>
      <div className="body three">
        <nav className="pane list" aria-label="Codex instruction files, by folder">
          {view.share && (
            <div className="share">
              <b>{view.share.finish ? "AGENTS.md is a copy of CLAUDE.md" : "Codex doesn't read CLAUDE.md"}</b>
              <p>{view.share.finish ? "Copies drift apart. Make CLAUDE.md import AGENTS.md, so both agents read one file." : "Move it into an AGENTS.md both agents read. CLAUDE.md imports it, so Claude reads the same text."}</p>
              <Button small kind="primary" onClick={() => void share()}>{view.share.finish ? "Use one file…" : "Share with Codex…"}</Button>
            </div>
          )}
          <div className="tree">
            {view.levels.map((l, i) => {
              const entries = view.entries.filter((e) => e.level === l.key);
              const missing = view.missing.filter((m) => m.level === l.key);
              if (!entries.length && !missing.length) return null;
              const pos = view.levels.length === 1 ? "only" : i === 0 ? "first" : i === view.levels.length - 1 ? "last" : "";
              return (
                <section key={l.key} className={`lvl ${l.kind === "project" ? "project" : ""} ${pos}`} aria-label={l.label}>
                  <div className="lvl-h" title={l.path ?? undefined}>
                    <b>{l.label}</b>
                    <span>{l.covers}</span>
                  </div>
                  {entries.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      className={`item ${e.loads === "not-read" || e.loads === "dropped" ? "dim" : ""}`}
                      aria-selected={selPath === e.file.path}
                      onClick={() => pick(e.file.path)}
                      onContextMenu={(ev) => (ev.preventDefault(), fileMenu(ev, e.file, { canDelete: true, agent: "codex" }))}
                      title={e.file.display}
                    >
                      <span className="dot" style={{ ["--c" as string]: e.loads === "cut" ? "var(--amber)" : e.loads === "dropped" ? "var(--pencil)" : "var(--focus)" }} />
                      <span className="t">{e.file.name}</span>
                      <span className="m">{e.loads === "cut" ? "cut" : e.loads === "dropped" ? "not read" : ""}</span>
                      <span className="s">{codexSubtitle(e)}</span>
                    </button>
                  ))}
                  {missing.map((m) => (
                    <Ghost key={m.id} m={m} selected={selPath === m.path} onPick={pick} />
                  ))}
                </section>
              );
            })}
          </div>
          {view.claudeOnly.length > 0 && !view.share && (
            <p className="group-note">Codex doesn't read {view.claudeOnly.map((c) => c.display.split("/").pop()).join(" or ")} here.</p>
          )}
          <DocRules rules={view.rules}>
            {project && (
              <div className="budget" title="Codex reads the project's AGENTS.md files from the root down, and stops at this size">
                <span>Project instructions</span>
                <span className="num">{kib(view.totals.bytes)} of {kib(view.totals.budget)}</span>
                <i style={{ ["--p" as string]: `${pct}%` }} className={pct >= 100 ? "full" : ""} />
              </div>
            )}
            {view.config.fallbacks.length > 0 && <p className="also">Also read: {view.config.fallbacks.join(", ")}</p>}
          </DocRules>
        </nav>
        {selPath ? (
          <FileWorkspace
            key={selPath}
            path={selPath}
            agent="codex"
            formattable={selPath.endsWith(".md")}
            template={slot?.template}
            canDelete
            onDeleted={() => setParams({ file: null })}
            facts={entry ? [["Codex reads", entry.loads === "read" ? "All of it" : entry.loads === "cut" ? `The first ${kib(entry.bytesRead)}` : "None of it"]] : [["Codex would read", "All of it, up to its limit"]]}
          />
        ) : (
          <section className="pane center">
            <Empty title="Codex reads nothing here yet.">Create an AGENTS.md in the project to give Codex instructions.</Empty>
          </section>
        )}
      </div>
    </>
  );
}

function kib(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n % 1024 === 0 ? 0 : 1)} KiB`;
}

function Loading() {
  return (
    <div className="skeleton" aria-label="Loading">
      <i style={{ width: "40%" }} />
      <i style={{ width: "72%" }} />
      <i style={{ width: "58%" }} />
    </div>
  );
}

/** An estimate reads as one: 11,084 becomes 11,100. */
function approx(n: number): string {
  const step = n > 10_000 ? 100 : n > 1000 ? 50 : 10;
  return (Math.round(n / step) * step).toLocaleString();
}
