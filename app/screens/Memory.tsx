import type { MemoryFolder, MemoryItem, MemoryView, WritePlan } from "../../shared/types.ts";
import { useAgent } from "../agent.ts";
import { ApiError, api, qs } from "../api.ts";
import { useParams } from "../router.ts";
import { useResource } from "../store.ts";
import { Empty, Meter, Switch, Tally, bytes, humanize, plural, when } from "../ui/kit.tsx";
import { useApp } from "../shell/app-context.ts";
import { CodexMemory } from "./Codex.tsx";
import { FileWorkspace } from "../shell/FileWorkspace.tsx";
import { setHeadSlot } from "../shell/headslot.ts";

const TYPES: { key: string; label: string }[] = [
  { key: "user", label: "About you" },
  { key: "feedback", label: "How you like to work" },
  { key: "project", label: "About the project" },
  { key: "reference", label: "Where to find things" },
];

export function Memory() {
  if (useAgent() === "codex") return <CodexMemory />;
  return <ClaudeMemory />;
}

function ClaudeMemory() {
  const { project } = useApp();
  return project ? <MemoryScreen key={project} url={`/api/memory${qs({ project })}`} /> : <FolderMemory />;
}

/**
 * With no project open: the home folder's memory, which is what sessions
 * started in ~ save to, with every other folder Claude keeps memory for listed
 * under it. Reading one doesn't make it the project.
 */
function FolderMemory() {
  const [params, setParams] = useParams();
  const { data, error } = useResource<{ folders: MemoryFolder[]; home: string }>("/api/memory");
  if (error) return <Empty title="Memory couldn't be read.">{error.message}</Empty>;
  if (!data) return <p className="loading">Reading memory…</p>;
  const folder = params.get("folder") ?? data.home;
  const here = data.folders.find((f) => f.project === folder);
  return <MemoryScreen key={folder} url={`/api/memory${qs({ folder })}`} label={here?.name ?? (folder === data.home ? "Home folder" : folder.split("/").pop())} folders={data.folders} current={folder} onFolder={(p) => setParams({ folder: p, file: null })} />;
}

function MemoryScreen({ url, label, folders, current, onFolder }: { url: string; label?: string; folders?: MemoryFolder[]; current?: string; onFolder?: (p: string) => void }) {
  const { project, save, toast, fileMenu } = useApp();
  const [params, setParams] = useParams();
  const { data, error } = useResource<MemoryView>(url);

  if (error) return <Empty title="Memory couldn't be read.">{error.message}</Empty>;
  if (!data) return <p className="loading">Reading memory…</p>;

  const v = data;
  const selected = params.get("file") ?? v.index?.path ?? v.items[0]?.file.path ?? `${v.dir}/MEMORY.md`;
  const isIndex = selected.endsWith("/MEMORY.md");
  const byType = new Map<string, MemoryItem[]>();
  for (const i of v.items) {
    const k = TYPES.some((t) => t.key === i.type) ? i.type! : "other";
    byType.set(k, [...(byType.get(k) ?? []), i]);
  }

  const toggle = async (on: boolean) => {
    try {
      // Written where the current value comes from when that is a file this app may write; otherwise user settings.
      const setIn = v.enabledSetBy;
      const scope = setIn.endsWith(".claude/settings.local.json") ? "local" : setIn.endsWith(".claude/settings.json") && !setIn.startsWith("~/.claude/") ? "project" : "user";
      const planned = await api.post<{ plan: WritePlan; content: string; baseHash: string | null }>("/api/settings/plan", { project, scope, path: ["autoMemoryEnabled"], value: on ? null : false });
      save({ path: planned.plan.path, content: planned.content, baseHash: planned.baseHash, project, planned, title: on ? "Turn auto memory on?" : "Turn auto memory off?" });
    } catch (e) {
      toast({ text: e instanceof ApiError ? e.message : String(e), tone: "bad" });
    }
  };

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
        <nav className="pane list" aria-label="Memories">
          <label className="list-switch" title={`Set by ${v.enabledSetBy}`}>
            <span>
              <b>Auto memory</b>
              <i>{v.enabled ? "Claude saves what it learns here" : "Off: Claude saves nothing new"}</i>
            </span>
            <Switch label="Auto memory" checked={v.enabled} onChange={toggle} disabled={v.enabledSetBy.includes("environment")} />
          </label>
          <div className="group">
            <div className="group-h"><h2>{label ? `${label} · index` : "Index"}</h2></div>
            <button type="button" className="item" aria-selected={isIndex} onClick={() => setParams({ file: `${v.dir}/MEMORY.md` })}>
              <span className="dot" style={{ ["--c" as string]: "var(--amber)" }} />
              <span className="t">MEMORY.md</span>
              <span className="m"><Tally counts={{ problem: v.findings.filter((f) => f.severity === "problem").length, warning: v.findings.filter((f) => f.severity === "warning").length, note: 0 }} /></span>
              <span className="s">{v.index ? `${plural(v.used.lines, "line")} · ${bytes(v.used.bytes)}` : "Not created yet"}</span>
            </button>
            <div style={{ padding: "8px 16px 4px" }}>
              <Meter value={v.used.lines} max={v.limits.lines} label="Lines that load" right={`${v.used.lines} / ${v.limits.lines}`} />
            </div>
          </div>
          {[...TYPES, { key: "other", label: "Other" }].map((t) =>
            byType.get(t.key)?.length ? (
              <div className="group" key={t.key}>
                <div className="group-h"><h2>{t.label}</h2></div>
                {byType.get(t.key)!.map((i) => (
                  <button
                    key={i.file.path}
                    type="button"
                    className="item"
                    aria-selected={selected === i.file.path}
                    onClick={() => setParams({ file: i.file.path })}
                    onContextMenu={(e) => (e.preventDefault(), fileMenu(e, { ...i.file, editable: i.file.editable }, { canDelete: true, onDeleted: () => setParams({ file: null }) }))}
                    title={i.file.display}
                  >
                    <span className="dot" style={{ ["--c" as string]: i.indexed ? "var(--sage)" : "var(--faint)" }} />
                    <span className="t">{humanize(i.title)}</span>
                    <span className="m">{when(i.file.modified)}</span>
                    <span className="s">{i.indexed ? i.description || i.file.name : `Not in the index`}</span>
                  </button>
                ))}
              </div>
            ) : null,
          )}
          {v.broken.length > 0 && (
            <div className="group">
              <div className="group-h"><h2>In the index, but missing</h2></div>
              {v.broken.map((b) => (
                <button key={b.line} type="button" className="item dim" onClick={() => setParams({ file: `${v.dir}/MEMORY.md` })}>
                  <span className="dot" style={{ ["--c" as string]: "var(--pencil)" }} />
                  <span className="t">{b.title}</span>
                  <span className="m">line {b.line}</span>
                  <span className="s">{b.target}</span>
                </button>
              ))}
            </div>
          )}
          {v.items.length === 0 && <p className="group-note">Nothing saved yet. Claude adds notes here as it learns how you work.</p>}
          {folders && onFolder && (
            <div className="group">
              <div className="group-h"><h2>Other folders</h2></div>
              {folders
                .filter((f) => f.project !== current)
                .map((f) => (
                  <button key={f.dir} type="button" className={`item ${f.exists ? "" : "dim"}`} onClick={() => f.project && onFolder(f.project)} disabled={!f.project} title={f.display}>
                    <span className="dot" style={{ ["--c" as string]: "var(--amber)" }} />
                    <span className="t">{f.name}</span>
                    <span className="m">{f.memories}</span>
                    <span className="s">{f.exists ? f.display : `${f.display} · folder gone`}</span>
                  </button>
                ))}
            </div>
          )}
          <p className="list-foot" title={`${v.dirDisplay}. Every worktree of this repository shares it.`}>
            On this Mac only{v.cutAfterLine !== null ? ` · the index stops loading after line ${v.cutAfterLine}` : ""}
          </p>
        </nav>
        <FileWorkspace
          key={selected}
          path={selected}
          cutAfterLine={isIndex ? v.cutAfterLine : null}
          canDelete={!isIndex}
          reader={!isIndex}
          onDeleted={() => setParams({ file: null })}
          template={isIndex ? "# Memory index\n\n" : undefined}
          facts={isIndex ? [["Loads", "First 200 lines or 25 KB, every session"]] : [["Loads", "When Claude needs it"]]}
        />
      </div>
    </>
  );
}
