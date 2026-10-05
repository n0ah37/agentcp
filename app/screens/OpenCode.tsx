import { useMemo, useState } from "react";

import type { CodexEntry, OpencodeLayer, OpencodeSettingRow, OpencodeSettingsView, OpencodeView } from "../../shared/types.ts";
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
 * (yours, then every AGENTS.md from the project up to your home folder, all
 * combined; those below the project when it works there) and its settings
 * (the keys its config page lists, with the file that sets each one, and
 * cli.json's). Both read what the engine found and are edited as files,
 * through the same save, diff and history as everything else.
 */

function subtitle(e: CodexEntry): string {
  if (e.file.unreadable) return "AgentCP can't read it";
  if (e.loads === "read") return plural(e.file.lines, "line");
  return e.reason ?? "Not read";
}

const READS: Record<CodexEntry["loads"], string> = { read: "All of it", "on-demand": "All of it, once it works in this folder", "not-read": "None of it", cut: "Part of it", dropped: "None of it" };

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
  // Only folders with a file are shown, each named from the folder shown above it.
  const shown: { l: (typeof view.levels)[number]; label: string }[] = [];
  for (const l of view.levels) {
    if (!view.entries.some((e) => e.level === l.key) && !view.missing.some((m) => m.level === l.key)) continue;
    const prev = [...shown].reverse().find((s) => s.l.path && l.path?.startsWith(s.l.path + "/"))?.l.path;
    shown.push({ l, label: prev && l.path && l.kind !== "subfolder" ? l.path.slice(prev.length + 1) + "/" : l.label });
  }

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
            {shown.map(({ l, label }, i) => {
              const entries = view.entries.filter((e) => e.level === l.key);
              const missing = view.missing.filter((m) => m.level === l.key);
              const pos = shown.length === 1 ? "only" : i === 0 ? "first" : i === shown.length - 1 ? "last" : "";
              return (
                <section key={l.key} className={`lvl ${l.kind === "project" ? "project" : ""} ${pos}`} aria-label={label}>
                  <div className="lvl-h" title={l.path ?? undefined}>
                    <b>{label}</b>
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
                      <span className="dot" style={{ ["--c" as string]: e.loads === "read" ? "var(--focus)" : e.loads === "on-demand" ? "var(--ink-2)" : "var(--faint)" }} />
                      <span className="t">{e.file.name}</span>
                      <span className="m">{e.loads === "not-read" ? "not read" : e.loads === "on-demand" ? "when needed" : ""}</span>
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
              opencode.json also lists {view.remote.map((r) => r.url).join(", ")} under instructions, which OpenCode 2 doesn't fetch yet.
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
            facts={entry ? [["OpenCode reads", READS[entry.loads]]] : [["OpenCode would read", "All of it"]]}
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

const LAYER_KIND: Record<OpencodeLayer["kind"], string> = { user: "Yours", project: "This project", cli: "The terminal client's" };

/** opencode.json's keys, each with the value in force and the file it comes from, then cli.json's. Change one by editing that file. */
export function OpencodeSettings() {
  const { project, openDoc } = useApp();
  const [params, setParams] = useParams();
  const { data: v, error } = useResource<OpencodeSettingsView>(`/api/opencode/settings${qs({ project })}`);
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hit = (r: OpencodeSettingRow) => !needle || r.key.toLowerCase().includes(needle) || r.description.toLowerCase().includes(needle);
    return { server: (v?.rows ?? []).filter(hit), cli: (v?.cli.rows ?? []).filter(hit) };
  }, [v, q]);
  if (error) return <Empty title="OpenCode's settings couldn't be read.">{error.message}</Empty>;
  if (!v) return <p className="loading">Reading OpenCode's settings…</p>;
  const file = params.get("file");
  const open = [...v.layers, v.cli.layer].find((l) => l.path === file) ?? null;
  const set = rows.server.filter((r) => r.value !== null);
  const rest = rows.server.filter((r) => r.value === null);
  const cliSet = rows.cli.filter((r) => r.value !== null);
  const cliRest = rows.cli.filter((r) => r.value === null);

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
              <LayerItem key={l.path} l={l} selected={open?.path === l.path} onPick={() => setParams({ file: l.path })} />
            ))}
          </div>
          <div className="group">
            <div className="group-h"><h2>Terminal client</h2></div>
            <LayerItem l={v.cli.layer} selected={open?.path === v.cli.layer.path} onPick={() => setParams({ file: v.cli.layer.path })} />
          </div>
          {v.ignored.length > 0 && (
            <p className="group-note">
              Set but not used: {v.ignored.map((u) => `${u.key} in ${u.file}. ${u.why}`).join(" ")}
            </p>
          )}
          {v.unknown.length > 0 && (
            <p className="group-note">
              Not a setting OpenCode's docs list, so not shown: {v.unknown.map((u) => `${u.key} (${u.file})`).join(", ")}. A newer OpenCode than its docs may use them.
            </p>
          )}
          <DocRules rules={v.rules} from="OpenCode" />
        </nav>
        {open ? (
          <FileWorkspace
            key={open.path}
            path={open.path}
            agent="opencode"
            template={open.kind === "cli" ? '{\n  "$schema": "https://opencode.ai/v2/cli.json"\n}\n' : '{\n  "$schema": "https://opencode.ai/config.json"\n}\n'}
            facts={[["Read", LAYER_KIND[open.kind]]]}
          />
        ) : (
          <div className="pane">
            <div className="setlist">
              {!v.capturedAt && <p className="banner warn">OpenCode's documentation isn't downloaded, so its settings can't be listed. Download it in Preferences.</p>}
              {set.length > 0 && <h2>Set here</h2>}
              {set.map((r) => <Row key={r.key} r={r} />)}
              {rest.length > 0 && <h2>Not set</h2>}
              {rest.map((r) => <Row key={r.key} r={r} />)}
              {rows.cli.length > 0 && <h2>The terminal client, in cli.json</h2>}
              {cliSet.map((r) => <Row key={`cli:${r.key}`} r={r} />)}
              {cliRest.map((r) => <Row key={`cli:${r.key}`} r={r} />)}
              {!rows.server.length && !rows.cli.length && v.capturedAt && <Empty title={`Nothing matches “${q}”.`} />}
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

function LayerItem({ l, selected, onPick }: { l: OpencodeLayer; selected: boolean; onPick: () => void }) {
  return (
    <button type="button" className={`item ${l.exists ? "" : "ghost"}`} aria-selected={selected} onClick={onPick} title={l.display}>
      <span className="dot" style={{ ["--c" as string]: l.broken ? "var(--pencil)" : l.exists ? "var(--ink-2)" : "var(--faint)" }} />
      <span className="t">{l.display.split("/").pop()}</span>
      <span className="m">{l.exists ? "" : "new"}</span>
      <span className="s">{l.broken ? `This file ${l.broken}` : (l.note ?? `${LAYER_KIND[l.kind]} · ${l.display}`)}</span>
    </button>
  );
}

function Row({ r }: { r: OpencodeSettingRow }) {
  return (
    <div className={`setrow ${r.value !== null ? "set" : ""}`}>
      <div className="sr-main">
        <div className="k">
          <code>{r.key}</code>
          {r.deprecated && <span className="tag">Deprecated</span>}
        </div>
        {r.description && <p className="d">{r.description}</p>}
        <p className="v">{r.value !== null ? <>In {r.setIn}{r.alsoIn.length > 0 && <>, over {r.alsoIn.join(", ")}</>}</> : r.options ? `One of ${r.options.join(", ")}` : `Not set · ${r.type}`}</p>
        {r.legacy.length > 0 && <p className="v">Set as {r.legacy.map((l) => `${l.name} in ${l.file}`).join(", ")}: OpenCode 1's name, which OpenCode 2 still reads.</p>}
      </div>
      <div className="ctl">{r.value !== null && <code className="oc-val" title={r.value}>{r.value}</code>}</div>
    </div>
  );
}
