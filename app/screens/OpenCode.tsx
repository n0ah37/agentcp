import { useMemo, useState } from "react";

import type { CodexEntry, OpencodeLayer, OpencodeSettingsView, OpencodeView } from "../../shared/types.ts";
import { qs } from "../api.ts";
import { useParams } from "../router.ts";
import { useResource } from "../store.ts";
import { Icon } from "../ui/icons.tsx";
import { DocLink, Empty, plural } from "../ui/kit.tsx";
import { useApp } from "../shell/app-context.ts";
import { FileWorkspace } from "../shell/FileWorkspace.tsx";
import { setHeadSlot } from "../shell/headslot.ts";
import { DocRules } from "./Codex.tsx";
import { Ghost } from "./Instructions.tsx";

/**
 * OpenCode's screens that differ from the other agents': its instructions
 * (AGENTS.md, or CLAUDE.md when there's none, the first one found from the
 * project folder up) and its settings (opencode.json's keys, from its schema,
 * with the file that sets each one). Both read what the engine found and are
 * edited as files, through the same save, diff and history as everything else.
 */

function subtitle(e: CodexEntry): string {
  if (e.file.unreadable) return "AgentCP can't read it";
  if (e.loads === "read") return plural(e.file.lines, "line");
  return e.reason ?? "Not read";
}

export function OpencodeInstructions() {
  const { project, fileMenu } = useApp();
  const [params, setParams] = useParams();
  const { data: view, error } = useResource<OpencodeView>(`/api/opencode${qs({ project })}`);
  if (error) return <Empty title="OpenCode's files couldn't be read.">{error.message}</Empty>;
  if (!view) return <p className="loading">Reading OpenCode's files…</p>;

  const chosen = params.get("file");
  const selected = view.entries.find((e) => e.file.path === chosen) ?? view.missing.find((m) => m.path === chosen) ?? view.entries.find((e) => e.loads === "read" && e.level !== "oc-home") ?? view.entries.find((e) => e.loads === "read") ?? view.missing[0];
  const selPath = selected ? ("file" in selected ? selected.file.path : selected.path) : null;
  const entry = selected && "file" in selected ? selected : null;
  const slot = selected && !("file" in selected) ? selected : null;
  const pick = (p: string) => setParams({ file: p });

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
        <nav className="pane list" aria-label="OpenCode instruction files, by folder">
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
                      className={`item ${e.loads === "not-read" ? "dim" : ""}`}
                      aria-selected={selPath === e.file.path}
                      onClick={() => pick(e.file.path)}
                      onContextMenu={(ev) => (ev.preventDefault(), fileMenu(ev, e.file, { canDelete: true, agent: "opencode" }))}
                      title={e.file.display}
                    >
                      <span className="dot" style={{ ["--c" as string]: e.loads === "read" ? "var(--focus)" : "var(--faint)" }} />
                      <span className="t">{e.file.name}</span>
                      <span className="m">{e.loads === "not-read" ? "not read" : ""}</span>
                      <span className="s">{subtitle(e)}</span>
                    </button>
                  ))}
                  {missing.map((m) => (
                    <Ghost key={m.id} m={m} selected={selPath === m.path} onPick={pick} />
                  ))}
                </section>
              );
            })}
          </div>
          {view.remote.length > 0 && (
            <p className="group-note">
              OpenCode also fetches {view.remote.map((r) => r.url).join(", ")} each session, from instructions in opencode.json.
            </p>
          )}
          <DocRules rules={view.rules} from="OpenCode" />
        </nav>
        {selPath ? (
          <FileWorkspace
            key={selPath}
            path={selPath}
            agent="opencode"
            formattable={selPath.endsWith(".md")}
            template={slot?.template}
            canDelete
            onDeleted={() => setParams({ file: null })}
            facts={entry ? [["OpenCode reads", entry.loads === "read" ? "All of it" : "None of it"]] : [["OpenCode would read", "All of it"]]}
          />
        ) : (
          <section className="pane center">
            <Empty title="OpenCode reads nothing here yet.">Create an AGENTS.md in the project to give OpenCode instructions.</Empty>
          </section>
        )}
      </div>
    </>
  );
}

const LAYER_KIND: Record<OpencodeLayer["kind"], string> = { user: "Yours", custom: "From OPENCODE_CONFIG", project: "This project", managed: "Your organization's" };

/** opencode.json's keys, each with the value in force and the file it comes from. Change one by editing that file. */
export function OpencodeSettings() {
  const { project, openDoc } = useApp();
  const [params, setParams] = useParams();
  const { data: v, error } = useResource<OpencodeSettingsView>(`/api/opencode/settings${qs({ project })}`);
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (v?.rows ?? []).filter((r) => !needle || r.key.toLowerCase().includes(needle) || r.description.toLowerCase().includes(needle));
  }, [v, q]);
  if (error) return <Empty title="OpenCode's settings couldn't be read.">{error.message}</Empty>;
  if (!v) return <p className="loading">Reading OpenCode's settings…</p>;
  const file = params.get("file");
  const open = v.layers.find((l) => l.path === file) ?? null;
  const set = rows.filter((r) => r.value !== null);
  const rest = rows.filter((r) => r.value === null);

  return (
    <>
      <header className="head cols">
        <div className="head-text">
          <h1>Settings</h1>
        </div>
        <div className="head-file" ref={setHeadSlot} />
        <div className="head-actions">
          <label className="search">
            <Icon.search />
            <input placeholder="Find a setting" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
        </div>
      </header>
      <div className={`body ${file ? "three" : "two"}`}>
        <nav className="pane list" aria-label="OpenCode's config files">
          <div className="group">
            <div className="group-h"><h2>Files, in the order OpenCode merges them</h2></div>
            <button type="button" className="item" aria-selected={!open} onClick={() => setParams({ file: null })}>
              <span className="dot" style={{ ["--c" as string]: "var(--focus)" }} />
              <span className="t">Every setting</span>
              <span className="m">{v.rows.length}</span>
              <span className="s">{plural(v.rows.filter((r) => r.value !== null).length, "setting")} set here</span>
            </button>
            {v.layers.map((l) => (
              <button key={l.path} type="button" className={`item ${l.exists ? "" : "ghost"}`} aria-selected={open?.path === l.path} onClick={() => setParams({ file: l.path })} title={l.display}>
                <span className="dot" style={{ ["--c" as string]: l.broken ? "var(--pencil)" : l.exists ? "var(--ink-2)" : "var(--faint)" }} />
                <span className="t">{l.display.split("/").pop()}</span>
                <span className="m">{l.exists ? "" : "new"}</span>
                <span className="s">{l.broken ? `This file ${l.broken}` : (l.note ?? `${LAYER_KIND[l.kind]} · ${l.display}`)}</span>
              </button>
            ))}
          </div>
          {v.unknown.length > 0 && (
            <p className="group-note">
              Not in OpenCode's published schema, so not listed: {v.unknown.map((u) => `${u.key} (${u.file})`).join(", ")}. A newer OpenCode than its docs may use them.
            </p>
          )}
          <DocRules rules={v.rules} from="OpenCode" />
        </nav>
        {open ? (
          <FileWorkspace key={open.path} path={open.path} agent="opencode" template={'{\n  "$schema": "https://opencode.ai/config.json"\n}\n'} facts={[["Read", LAYER_KIND[open.kind]]]} />
        ) : (
          <div className="pane">
            <div className="setlist">
              {!v.capturedAt && <p className="banner warn">OpenCode's documentation isn't downloaded, so its settings can't be listed. Download it in Preferences.</p>}
              {set.length > 0 && <h2>Set here</h2>}
              {set.map((r) => <Row key={r.key} r={r} />)}
              {rest.length > 0 && <h2>Not set</h2>}
              {rest.map((r) => <Row key={r.key} r={r} />)}
              {!rows.length && v.capturedAt && <Empty title={`Nothing matches “${q}”.`} />}
              <p className="faint" style={{ marginTop: 18 }}>
                To change a setting, open its file on the left and edit it there; every save shows the change first. <DocLink doc={v.doc} onOpen={openDoc} />
              </p>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function Row({ r }: { r: OpencodeSettingsView["rows"][number] }) {
  return (
    <div className={`setrow ${r.value !== null ? "set" : ""}`}>
      <div className="sr-main">
        <div className="k">
          <code>{r.key}</code>
          {r.deprecated && <span className="tag">Deprecated</span>}
        </div>
        {r.description && <p className="d">{r.description}</p>}
        <p className="v">{r.value !== null ? <>In {r.setIn}{r.alsoIn.length > 0 && <>, over {r.alsoIn.join(", ")}</>}</> : r.options ? `One of ${r.options.join(", ")}` : `Not set · ${r.type}`}</p>
      </div>
      <div className="ctl">{r.value !== null && <code className="oc-val" title={r.value}>{r.value}</code>}</div>
    </div>
  );
}
