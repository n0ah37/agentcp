import { useEffect, useMemo, useRef, useState } from "react";

import type { DefinitionsView, SettingRow, SettingScope, SettingsView, WritePlan } from "../../shared/types.ts";
import { useAgent } from "../agent.ts";
import { OpencodeSettings } from "./OpenCode.tsx";
import { ApiError, api, qs } from "../api.ts";
import { useParams } from "../router.ts";
import { useResource } from "../store.ts";
import { Icon } from "../ui/icons.tsx";
import { Button, DocLink, Empty, FindingList, Rich, Sheet } from "../ui/kit.tsx";
import { useApp } from "../shell/app-context.ts";
import { FileWorkspace } from "../shell/FileWorkspace.tsx";
import { setHeadSlot } from "../shell/headslot.ts";
import { CODEX_SCOPE, SCOPE } from "../ui/scopes.ts";

/** Where a change is saved, in the names every scope picker uses. */
const SAVE_TO: Record<"claude" | "codex", { value: SettingScope; label: string; where: string; needsProject: boolean }[]> = {
  claude: [
    { value: "user", ...SCOPE.user, needsProject: false },
    { value: "project", ...SCOPE.project, needsProject: true },
    { value: "local", ...SCOPE.local, needsProject: true },
  ],
  codex: [
    { value: "user", ...CODEX_SCOPE.user, needsProject: false },
    { value: "project", ...CODEX_SCOPE.project, needsProject: true },
  ],
};

function show(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "on" : "off";
  return JSON.stringify(v);
}

/** Each agent's settings as one list: every key its docs list, with a control, the value in force and the file it comes from. OpenCode's are listed by file. */
export function Settings() {
  const agent = useAgent();
  return agent === "opencode" ? <OpencodeSettings /> : <AgentSettings agent={agent} />;
}

function AgentSettings({ agent }: { agent: "claude" | "codex" }) {
  const { project, projectRef, save, toast, openDoc } = useApp();
  const [params, setParams] = useParams();
  const { data: view, error } = useResource<SettingsView>(agent === "codex" ? `/api/codex/settings${qs({ project })}` : `/api/settings${qs({ project })}`);
  const { data: styles } = useResource<DefinitionsView>(agent === "claude" ? `/api/definitions${qs({ kind: "style", project })}` : null);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<SettingScope>("user");
  const [editing, setEditing] = useState<SettingRow | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const focusKey = params.get("key");
  const file = params.get("file");

  const topic = params.get("topic") ?? (focusKey ? null : "Most used");
  useEffect(() => {
    if (!project && scope !== "user") setScope("user");
  }, [project, scope]);
  useEffect(() => setScope("user"), [agent]);

  const rows = useMemo(() => {
    if (!view) return [] as SettingRow[];
    const needle = q.trim().toLowerCase();
    if (needle) return view.rows.filter((r) => r.key.toLowerCase().includes(needle) || r.description.toLowerCase().includes(needle) || r.topic.toLowerCase().includes(needle));
    if (focusKey) return view.rows.filter((r) => r.key === focusKey);
    if (topic === "Most used") return view.featured.map((k) => view.rows.find((r) => r.key === k)!).filter(Boolean);
    if (topic === "Set here") return view.rows.filter((r) => r.effective);
    return view.rows.filter((r) => r.topic === topic);
  }, [view, q, topic, focusKey]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [topic, q]);

  if (error) return <Empty title="Settings couldn't be read.">{error.message}</Empty>;
  if (!view) return <p className="loading">Reading settings…</p>;

  const name = agent === "codex" ? "Codex" : "Claude Code";
  const setCount = view.rows.filter((r) => r.effective).length;
  const broken = view.files.filter((f) => f.error);
  const scopes = SAVE_TO[agent];
  const scopeWhere = (s: SettingScope) => scopes.find((x) => x.value === s)?.where ?? "";

  const plan = async (sets: { row: SettingRow; value: unknown }[], title: string) => {
    const target = sets.every((x) => x.row.allowed.includes(scope)) ? scope : "user";
    try {
      if (agent === "codex") {
        const planned = await api.post<{ path: string; content: string; baseHash: string | null }>("/api/codex/settings/plan", { project, scope: target, sets: sets.map((x) => ({ key: x.row.key, value: x.value })) });
        save({ path: planned.path, content: planned.content, baseHash: planned.baseHash, project, title });
      } else {
        const x = sets[0];
        const planned = await api.post<{ plan: WritePlan; content: string; baseHash: string | null }>("/api/settings/plan", { project, scope: target, path: x.row.path, value: x.value });
        save({ path: planned.plan.path, content: planned.content, baseHash: planned.baseHash, project, planned, title });
      }
    } catch (e) {
      toast({ text: e instanceof ApiError ? e.message : String(e), tone: "bad" });
    }
  };
  const apply = (row: SettingRow, value: unknown) => {
    const target = row.allowed.includes(scope) ? scope : row.allowed[0];
    if (!target) return toast({ text: `${row.key} can only be set by ${row.scopeText.toLowerCase()}.` });
    void plan([{ row, value }], value === null ? `Remove ${row.key} ${scopeWhere(target)}?` : `Set ${row.key} ${scopeWhere(target)}?`);
  };

  const cx = view.codex;
  const topics = ["Most used", "Set here", ...view.topics];
  const count = (t: string) => (t === "Most used" ? view.featured.length : t === "Set here" ? setCount : view.rows.filter((r) => r.topic === t).length);
  const pick = (patch: Record<string, string | null>) => (setQ(""), setParams({ key: null, file: null, ...patch }));
  const layer = cx?.layers.find((l) => l.path === file);

  return (
    <>
      {file ? (
        <header className="head cols">
          <div className="head-text">
            <h1>Settings</h1>
          </div>
          <div className="head-file" ref={setHeadSlot} />
          <div className="head-actions" />
        </header>
      ) : (
        <header className="head">
          <div className="head-text">
            <h1>Settings</h1>
          </div>
          <div className="head-actions">
            <label className="search">
              <Icon.search />
              <input placeholder="Find a setting" value={q} onChange={(e) => (setQ(e.target.value), focusKey && setParams({ key: null }, true))} />
            </label>
            <label className="labelled">
              <span>Save to</span>
              <select className="select" value={scope} onChange={(e) => setScope(e.target.value as SettingScope)}>
                {scopes.map((s) => (
                  <option key={s.value} value={s.value} disabled={s.needsProject && !project}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </header>
      )}
      {broken.length > 0 && (
        <div className="banner bad">
          <span className="grow">{broken.map((b) => `${b.display}: ${b.error}`).join(" · ")} {name} skips a settings file it can't read.</span>
        </div>
      )}
      <div className={`body ${layer ? "three" : "two"}`}>
        <nav className="pane list topics" aria-label="Topics">
          {topics.map((t) => (
            <button key={t} type="button" aria-pressed={!q && !focusKey && !file && topic === t} onClick={() => pick({ topic: t })}>
              <span>{t}</span>
              <span className="n">{count(t)}</span>
            </button>
          ))}
          {cx && (
            <>
              <h4 className="topics-h">Files</h4>
              {cx.layers.map((l) => (
                <button key={l.path} type="button" aria-pressed={file === l.path} onClick={() => pick({ file: l.path })} title={l.display} className={l.used ? "" : "dim"}>
                  <span>{l.label}</span>
                  <span className={`n ${l.problems ? "warn" : ""}`}>{l.problems || (!l.exists ? "new" : l.used ? "" : "off")}</span>
                </button>
              ))}
              <h4 className="topics-h">MCP servers</h4>
              {cx.mcp.length ? (
                cx.mcp.map((m) => (
                  <div key={m.name} className="topic-static" title={`${m.run} · ${m.from}`}>
                    <span>{m.name}</span>
                    <span className="n">{m.enabled ? "" : "off"}</span>
                  </div>
                ))
              ) : (
                <p className="topics-note">None set.</p>
              )}
            </>
          )}
        </nav>
        {layer ? (
          <FileWorkspace
            key={layer.path}
            path={layer.path}
            agent="codex"
            template={"# Codex settings. Every key is in the configuration reference.\n"}
            facts={[["Applies", layer.note ?? (layer.used ? "In every Codex session here" : "Not until you trust this project")]]}
            top={cx!.findings[layer.path]?.length ? <section><h3>Suggestions · {cx!.findings[layer.path].length}</h3><FindingList findings={cx!.findings[layer.path]} onOpenDoc={openDoc} /></section> : undefined}
          />
        ) : (
          <div className="pane" ref={listRef}>
            <div className="setlist">
              {cx?.trust && (
                <p className={`banner-line ${cx.trust.level === "trusted" ? "" : "warn"}`}>
                  {cx.trust.level === "trusted" ? "Codex trusts this project, so its .codex folder loads." : `Codex ${cx.trust.level === "untrusted" ? "has this project marked untrusted" : "hasn't been told to trust this project"}, so its .codex folder doesn't load.`}{" "}
                  <DocLink doc={cx.doc} onOpen={openDoc} label="How trust works" />
                </p>
              )}
              <h2>{q ? `Matching “${q}”` : focusKey ? focusKey : topic}</h2>
              {cx && topic === "Most used" && !q && !focusKey && cx.permissions.length > 0 && <Permissions view={view} onPlan={plan} />}
              {rows.length === 0 && <p className="muted">No setting matches.</p>}
              {rows.map((r) => (
                <Row key={r.key} row={r} agent={agent} scope={scope} scopeWhere={scopeWhere} styleNames={styles?.items.map((s) => s.name) ?? []} onApply={apply} onEdit={() => setEditing(r)} onOpenDoc={openDoc} />
              ))}
              {projectRef && agent === "claude" && <p className="usage-note">{setCount} set for {projectRef.name}.</p>}
            </div>
          </div>
        )}
      </div>
      {editing && <JsonSheet row={editing} onClose={() => setEditing(null)} onSave={(v) => (setEditing(null), apply(editing, v))} />}
    </>
  );
}

/** Codex's sandbox and approval combinations, from its docs, as one choice. */
function Permissions({ view, onPlan }: { view: SettingsView; onPlan: (sets: { row: SettingRow; value: unknown }[], title: string) => void }) {
  const presets = view.codex!.permissions;
  const row = (k: string) => view.rows.find((r) => r.key === k);
  const cur = (k: string) => row(k)?.effective?.value ?? null;
  // With none of the three set, Codex does what its docs call "no flags needed".
  const none = cur("sandbox_mode") === null && cur("approval_policy") === null && cur("approvals_reviewer") === null;
  const active = presets.find((p) => (none ? p.byDefault : cur("sandbox_mode") === p.sets.sandbox_mode && cur("approval_policy") === p.sets.approval_policy && (cur("approvals_reviewer") ?? null) === p.sets.approvals_reviewer));
  const choose = (name: string) => {
    const p = presets.find((x) => x.name === name);
    if (!p) return;
    const sets = (["sandbox_mode", "approval_policy", "approvals_reviewer"] as const).filter((k) => row(k)).map((k) => ({ row: row(k)!, value: p.sets[k] }));
    onPlan(sets, `Switch Codex to ${p.name}?`);
  };
  return (
    <div className="setrow set">
      <div className="sr-main">
        <div className="k"><b>Permissions</b></div>
        <p className="d">{active ? active.effect : "Your sandbox and approval settings don't match one of the combinations in Codex's docs."}</p>
        <p className="v">Sets sandbox_mode, approval_policy and approvals_reviewer together.</p>
      </div>
      <div className="ctl">
        <select className="select" value={active?.name ?? ""} onChange={(e) => choose(e.target.value)} aria-label="Permissions">
          {!active && <option value="">Custom</option>}
          {presets.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>
      </div>
    </div>
  );
}

function Row(props: { row: SettingRow; agent: "claude" | "codex"; scope: SettingScope; scopeWhere: (s: SettingScope) => string; styleNames: string[]; onApply: (r: SettingRow, v: unknown) => void; onEdit: () => void; onOpenDoc: (d: SettingRow["doc"]) => void }) {
  const r = props.row;
  const eff = r.effective;
  const writable = r.allowed.length > 0;
  const blockedHere = writable && !r.allowed.includes(props.scope);
  const control = (() => {
    if (!writable) return <span className="tag" title={r.scopeText}>{r.scopeText}</span>;
    const c = r.control;
    const current = eff?.value;
    if (r.key === "outputStyle" && props.styleNames.length) {
      return (
        <select className="select" value={typeof current === "string" ? current : ""} onChange={(e) => props.onApply(r, e.target.value || null)} aria-label={r.key}>
          <option value="">Default</option>
          {props.styleNames.filter((n) => n !== "Default").map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      );
    }
    if (c.type === "boolean") {
      return (
        <select className="select" value={current === true ? "on" : current === false ? "off" : ""} onChange={(e) => props.onApply(r, e.target.value === "" ? null : e.target.value === "on")} aria-label={r.key}>
          <option value="">Not set</option>
          <option value="on">On</option>
          <option value="off">Off</option>
        </select>
      );
    }
    if (c.type === "enum") {
      return (
        <select className="select" value={typeof current === "string" ? current : ""} onChange={(e) => props.onApply(r, e.target.value || null)} aria-label={r.key}>
          <option value="">Not set</option>
          {/* A value the docs no longer list, such as a deprecated one, still shows as what's set. */}
          {typeof current === "string" && current && !c.options.some((o) => o.value === current) && <option value={current}>{current}</option>}
          {c.options.map((o) => <option key={o.value} value={o.value} title={o.label}>{o.value}</option>)}
        </select>
      );
    }
    if (c.type === "number" || c.type === "string") return <Inline row={r} onApply={props.onApply} />;
    return <Button small onClick={props.onEdit}>{eff ? "Edit" : "Set"}</Button>;
  })();
  // The API sends the value in force and the list apart, so match by file rather than by object.
  const others = r.values.filter((v) => !(eff && v.file === eff.file && !v.inactive));

  return (
    <div className={`setrow ${eff ? "set" : ""}`} id={`k-${r.key}`}>
      <div className="sr-main">
        <div className="k">
          <code>{r.key}</code>
          <DocLink icon doc={r.doc} onOpen={props.onOpenDoc} label={`${r.key} in the docs`} />
          {/* Only a key that some files can't hold says where it can go. */}
          {r.scopeText && r.allowed.length > 0 && (props.agent === "codex" || r.allowed.length < 3) && <span className="tag">{r.scopeText}</span>}
        </div>
        <p className="d"><Rich text={r.description} /></p>
        <p className="v">
          {eff ? (
            <>
              <b>{show(eff.value).slice(0, 120)}</b> in {eff.file}
              {others.length > 0 && <> · also in {others.map((v) => (v.inactive ? v.label : v.file)).join(", ")}{r.merges ? " (lists combine)" : others.some((v) => v.inactive) ? "" : ", which loses"}</>}
            </>
          ) : (
            <>
              Not set{r.defaultText ? <> · default <Rich text={r.defaultText} /></> : null}
              {others.length > 0 && <> · {others.map((v) => `${show(v.value).slice(0, 40)} in ${v.inactive ? v.label : v.file}`).join(", ")}</>}
            </>
          )}
        </p>
        {r.overridesText && <p className="o">For one session: <Rich text={r.overridesText} /></p>}
        {blockedHere && <p className="o warn">{props.agent === "codex" ? "Codex" : "Claude Code"} ignores this key {props.scopeWhere(props.scope)}, so it's saved {props.scopeWhere(r.allowed[0])}.</p>}
      </div>
      <div className="ctl">{control}</div>
    </div>
  );
}

function Inline({ row, onApply }: { row: SettingRow; onApply: (r: SettingRow, v: unknown) => void }) {
  const cur = row.effective?.value;
  const [v, setV] = useState(cur === undefined ? "" : String(cur));
  useEffect(() => setV(cur === undefined ? "" : String(cur)), [cur]);
  const changed = v !== (cur === undefined ? "" : String(cur));
  const submit = () => {
    if (!v.trim()) return onApply(row, null);
    if (row.control.type === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) return;
      return onApply(row, n);
    }
    onApply(row, v);
  };
  return (
    <form className="inline" onSubmit={(e) => (e.preventDefault(), submit())}>
      <input className="field" value={v} placeholder="Not set" inputMode={row.control.type === "number" ? "numeric" : undefined} onChange={(e) => setV(e.target.value)} aria-label={row.key} />
      {changed && <Button small type="submit">Set</Button>}
    </form>
  );
}

function JsonSheet({ row, onClose, onSave }: { row: SettingRow; onClose: () => void; onSave: (v: unknown) => void }) {
  const [text, setText] = useState(row.effective ? JSON.stringify(row.effective.value, null, 2) : "");
  let err: string | null = null;
  let parsed: unknown = null;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      err = (e as Error).message;
    }
  }
  return (
    <Sheet
      title={row.key}
      subtitle={row.typeText || row.description}
      width="narrow"
      onClose={onClose}
      footer={
        <>
          <span className="note">{err ? `Not valid JSON: ${err}` : text.trim() ? "Next, review the change." : "Leave it empty to remove the key."}</span>
          <Button kind="quiet" onClick={onClose}>Cancel</Button>
          <Button kind="primary" disabled={!!err} onClick={() => onSave(text.trim() ? parsed : null)}>Review</Button>
        </>
      }
    >
      <textarea className="field" data-autofocus rows={12} style={{ width: "100%" }} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
    </Sheet>
  );
}
