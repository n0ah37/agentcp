import type { ReactNode } from "react";

import type { CodexMemoriesView, CodexRulesView, DocRule } from "../../shared/types.ts";
import { qs } from "../api.ts";
import { href, useParams } from "../router.ts";
import { useResource } from "../store.ts";
import { Empty, bytes, plural, when } from "../ui/kit.tsx";
import { useApp } from "../shell/app-context.ts";
import { FileWorkspace } from "../shell/FileWorkspace.tsx";
import { setHeadSlot } from "../shell/headslot.ts";

/** The rules a Codex screen applies, each quoted from Codex's docs, in one footer under the list with anything else it shows there. */
export function DocRules({ rules, children, from = "Codex" }: { rules: DocRule[]; children?: ReactNode; from?: string }) {
  const { openDoc } = useApp();
  if (!rules.length && !children) return null;
  return (
    <div className="list-foot rules-foot">
      {children}
      {rules.length > 0 && <b>From {from}'s docs</b>}
      {rules.length > 0 && <ul>
        {rules.map((r) => (
          <li key={r.text}>
            <button type="button" className="linkbtn quiet" onClick={() => openDoc(r.doc)} title={r.doc.heading ?? r.doc.url}>
              {r.text}
            </button>
            {!r.docCurrent && <span className="stale"> · no longer in the docs</span>}
          </li>
        ))}
      </ul>}
    </div>
  );
}

/** What Codex remembers from past sessions: generated files, read here, best left to Codex to change. */
export function CodexMemory() {
  const { project, fileMenu } = useApp();
  const [params, setParams] = useParams();
  const { data: v, error } = useResource<CodexMemoriesView>("/api/codex/memories");
  if (error) return <Empty title="Codex's memories couldn't be read.">{error.message}</Empty>;
  if (!v) return <p className="loading">Reading Codex's memories…</p>;
  const files = v.files.filter((f) => f.count === null);
  const selected = params.get("file") ?? files[0]?.path ?? null;
  const on = v.enabled ?? v.enabledByDefault;
  return (
    <>
      <header className="head cols">
        <div className="head-text">
          <h1>Memory</h1>
        </div>
        <div className="head-file" ref={setHeadSlot} />
        <div className="head-actions" />
      </header>
      <div className="body three">
        <nav className="pane list" aria-label="Codex memories">
          <div className="list-switch static">
            <span>
              <b>Memories {on ? "on" : "off"}</b>
              <i>{v.enabled === null ? `Codex's default (${v.enabledByDefault ? "on" : "off"})` : "Set in your Codex config"}</i>
            </span>
            {/* Memories are a Codex setting: [features] memories. */}
            <a className="btn small" href={href("settings", { agent: "codex", key: "features.memories", project: project ?? "" })}>Change</a>
          </div>
          <div className="group">
            <div className="group-h"><h2>{v.dir}</h2></div>
            {v.files.map((f) =>
              f.count === null ? (
                <button
                  key={f.path}
                  type="button"
                  className="item"
                  aria-selected={f.path === selected}
                  onClick={() => setParams({ file: f.path })}
                  onContextMenu={(e) => (e.preventDefault(), fileMenu(e, { path: f.path, display: f.display, name: f.name, exists: true, editable: false, hash: null }, { agent: "codex" }))}
                >
                  <span className="dot" style={{ ["--c" as string]: "var(--codex)" }} />
                  <span className="t">{f.name}</span>
                  <span className="m">{f.modified ? when(f.modified) : ""}</span>
                  <span className="s">{plural(f.lines, "line")} · {bytes(f.bytes)}</span>
                </button>
              ) : (
                <div key={f.path} className="item static">
                  <span className="dot" style={{ ["--c" as string]: "var(--faint)" }} />
                  <span className="t">{f.name}</span>
                  <span className="m">{f.count}</span>
                  <span className="s">{plural(f.count ?? 0, "file")}</span>
                </div>
              ),
            )}
            {!v.files.length && <p className="group-note">Nothing yet. Codex writes memories here once they're on.</p>}
          </div>
          <DocRules rules={v.rules} />
        </nav>
        {selected ? (
          <FileWorkspace key={selected} path={selected} agent="codex" reader />
        ) : (
          <section className="pane center">
            <Empty
              title="No memories yet."
              action={on ? undefined : <a className="btn small" href={href("settings", { agent: "codex", key: "features.memories", project: project ?? "" })}>Turn on memories…</a>}
            >
              {on ? "Codex writes what it learns here as it works." : "Memories are off, so Codex doesn't keep any. Turn them on in Settings and Codex writes what it learns here."}
            </Empty>
          </section>
        )}
      </div>
    </>
  );
}

/** Codex's .rules files: what it may run outside the sandbox, ask about, or refuse. */
export function CodexRules() {
  const { project, fileMenu } = useApp();
  const [params, setParams] = useParams();
  const { data: v, error } = useResource<CodexRulesView>(`/api/codex/rules${qs({ project })}`);
  if (error) return <Empty title="Codex's rules couldn't be read.">{error.message}</Empty>;
  if (!v) return <p className="loading">Reading Codex's rules…</p>;
  const selected = params.get("file") ?? v.files.find((f) => f.exists)?.path ?? v.files[0]?.path ?? null;
  const file = v.files.find((f) => f.path === selected);
  const DECISION = { allow: "Allow", prompt: "Ask", forbidden: "Block" } as const;
  return (
    <>
      <header className="head cols">
        <div className="head-text">
          <h1>Rules</h1>
        </div>
        <div className="head-file" ref={setHeadSlot} />
        <div className="head-actions" />
      </header>
      <div className="body three">
        <nav className="pane list" aria-label="Rules files">
          {v.files.map((f) => (
            <div className="group" key={f.path}>
              <div className="group-h"><h2>{f.label}{f.used ? "" : " · read once you trust this project"}</h2></div>
              <button
                type="button"
                className={`item ${f.exists ? "" : "ghost"}`}
                aria-selected={selected === f.path}
                onClick={() => setParams({ file: f.path })}
                onContextMenu={(e) => (e.preventDefault(), fileMenu(e, { path: f.path, display: f.display, name: f.display.split("/").pop() ?? "", exists: f.exists, editable: true, hash: null }, { canDelete: true, agent: "codex" }))}
                title={f.display}
              >
                <span className="dot" style={{ ["--c" as string]: f.used ? "var(--codex)" : "var(--faint)" }} />
                <span className="t">{f.display.split("/").pop()}</span>
                <span className="m">{f.exists ? plural(f.rules.length, "rule") : "new"}</span>
                <span className="s">{f.display}</span>
              </button>
              {f.rules.map((r) => (
                <button key={`${f.path}:${r.line}`} type="button" className="item rule" onClick={() => setParams({ file: f.path })} title={r.justification ?? undefined}>
                  <span className={`tag rule-${r.decision}`}>{DECISION[r.decision]}</span>
                  <span className="t mono">{r.pattern.join(" ")}</span>
                  <span className="s">{r.justification ?? `Line ${r.line}`}</span>
                </button>
              ))}
            </div>
          ))}
          <DocRules rules={v.rules} />
        </nav>
        {file && (
          <FileWorkspace
            key={file.path}
            path={file.path}
            agent="codex"
            canDelete
            template={v.template}
            facts={[["Applies", file.used ? "Every Codex session" : "Once you trust the project"]]}
          />
        )}
      </div>
    </>
  );
}
