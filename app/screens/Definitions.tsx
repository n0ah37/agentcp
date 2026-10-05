import { useMemo, useState } from "react";

import { desktop } from "../desktop.ts";
import { renderMarkdown } from "../ui/markdown.ts";

import type { Definition, DefinitionsView, FileView, WritePlan } from "../../shared/types.ts";
import { useAgent } from "../agent.ts";
import { ApiError, api, qs } from "../api.ts";
import { href, useParams } from "../router.ts";
import { useResource } from "../store.ts";
import { Icon } from "../ui/icons.tsx";
import { Button, DocLink, Empty, FindingList, Sheet, Tally, plural, useRevealSelected } from "../ui/kit.tsx";
import { useApp } from "../shell/app-context.ts";
import { FileWorkspace } from "../shell/FileWorkspace.tsx";
import { setHeadSlot } from "../shell/headslot.ts";
import { SCOPE } from "../ui/scopes.ts";

type Kind = "agent" | "style" | "skill" | "command" | "plugin";

/** What each kind is, for the screen with none yet; `{agent}` is Claude Code or Codex. */
const ABOUT: Record<Kind, string> = {
  agent: "A subagent is a helper {agent} can hand a task to, with its own instructions and tools.",
  style: "",
  skill: "A skill is a folder of instructions and files {agent} loads when a task calls for it.",
  command: "A command is a saved prompt you run as /name in {agent}.",
  plugin: "A plugin is code {agent} loads when it starts: tools, hooks and integrations. Add one under plugins in opencode.json, or put its file in a plugins folder.",
};

const COPY: Record<Kind, { title: string; one: string; many: string; newLabel: string }> = {
  agent: { title: "Subagents", one: "subagent", many: "subagents", newLabel: "New subagent" },
  style: { title: "Output styles", one: "style", many: "styles", newLabel: "New style" },
  skill: { title: "Skills", one: "skill", many: "skills", newLabel: "New skill" },
  command: { title: "Commands", one: "command", many: "commands", newLabel: "New command" },
  plugin: { title: "Plugins", one: "plugin", many: "plugins", newLabel: "" },
};

function template(kind: Kind, name: string, description: string): string {
  const d = description.replace(/\n/g, " ").trim() || "Describe when Claude should use this.";
  if (kind === "agent") return `---\nname: ${name}\ndescription: ${d}\n---\n\nYou are ${name}. Describe the job, what to return, and what not to do.\n`;
  if (kind === "style") return `---\nname: ${name}\ndescription: ${d}\nkeep-coding-instructions: true\n---\n\nDescribe how Claude should respond: tone, length, format.\n`;
  return `---\nname: ${name}\ndescription: ${d}\n---\n\n# ${name}\n\nSteps Claude should follow when this skill is used.\n`;
}

/** An OpenCode agent: Markdown, its name from the file, description required, mode subagent so other agents can hand it work. */
function opencodeAgentTemplate(name: string, description: string): string {
  const d = description.replace(/\n/g, " ").trim() || "Describe when OpenCode should use this agent.";
  return `---\ndescription: ${d}\nmode: subagent\n---\n\nYou are ${name}. Describe the job, what to return, and what not to do.\n`;
}

/** An OpenCode command: Markdown whose body is the prompt; $ARGUMENTS is what follows the command. */
function opencodeCommandTemplate(name: string, description: string): string {
  const d = description.replace(/\n/g, " ").trim() || `What /${name} does`;
  return `---\ndescription: ${d}\n---\n\nDescribe what to do with $ARGUMENTS.\n`;
}

function codexAgentTemplate(name: string, description: string): string {
  const d = (description.replace(/\n/g, " ").trim() || "Describe when Codex should use this agent.").replace(/"/g, '\\"');
  const q3 = '"""';
  return `name = "${name}"\ndescription = "${d}"\ndeveloper_instructions = ${q3}\nYou are ${name}. Describe the job, what to return, and what not to do.\n${q3}\n`;
}

/** Short group names: where a definition comes from, in the scope pickers' words. */
function groupLabel(d: Definition): string {
  if (d.source === "builtin") return "Built in";
  if (d.source === "user") return SCOPE.user.label;
  if (d.source === "project") return "This project";
  if (d.source === "managed") return SCOPE.managed.label;
  return `Plugin: ${d.where}`;
}

/** Where "Use this style" saves it, in the same words as Settings. */
const USE_IN = [
  { value: "user", ...SCOPE.user, needsProject: false },
  { value: "project", ...SCOPE.project, needsProject: true },
  { value: "local", ...SCOPE.local, needsProject: true },
] as const;

function pathFor(kind: Kind, dir: string, name: string): string {
  return kind === "skill" ? `${dir}/${name}/SKILL.md` : `${dir}/${name}.md`;
}

export function Definitions({ kind }: { kind: Kind }) {
  const { project, save, toast, openDoc, fileMenu } = useApp();
  const [params, setParams] = useParams();
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState("");
  // Skills and agents are the kinds Codex and OpenCode have too, commands and these plugins OpenCode's alone; the screen lists the sidebar's agent's.
  const agent = useAgent();
  const alt = kind !== "style" && agent !== "claude" ? agent : null;
  const codex = alt === "codex";
  const altName = alt === "opencode" ? "OpenCode" : "Codex";
  const { data: view, error } = useResource<DefinitionsView>(`/api/definitions${qs({ kind, project, agent: alt })}`);
  // OpenCode's agents include its primary ones, so they're Agents there.
  const c = alt === "opencode" && kind === "agent" ? { ...COPY.agent, title: "Agents", one: "agent", many: "agents", newLabel: "New agent" } : COPY[kind];

  const groups = useMemo(() => {
    const g = new Map<string, Definition[]>();
    const needle = filter.trim().toLowerCase();
    for (const d of view?.items ?? []) {
      if (needle && !d.name.toLowerCase().includes(needle) && !d.description.toLowerCase().includes(needle)) continue;
      const label = alt ? d.where : groupLabel(d);
      g.set(label, [...(g.get(label) ?? []), d]);
    }
    return [...g.entries()];
  }, [view, filter, alt]);

  useRevealSelected(params.get("file"), !!view);

  if (error) return <Empty title={`${c.title} couldn't be read.`}>{error.message}</Empty>;
  if (!view) return <p className="loading">Reading {c.many}…</p>;

  const selectedPath = params.get("file") ?? view.items.find((i) => i.source !== "builtin")?.file.path ?? view.items[0]?.file.path ?? null;
  // Several of OpenCode's can live in one opencode.json, so the name picks among them.
  const selectedName = params.get("name");
  const selected = view.items.find((i) => i.file.path === selectedPath && (!selectedName || i.name === selectedName)) ?? view.items.find((i) => i.file.path === selectedPath) ?? null;
  const isSelected = (d: Definition) => d === selected;

  const useStyle = async (name: string, scope: "user" | "project" | "local") => {
    try {
      const planned = await api.post<{ plan: WritePlan; content: string; baseHash: string | null }>("/api/settings/plan", { project, scope, path: ["outputStyle"], value: name === "Default" ? null : name });
      save({ path: planned.plan.path, content: planned.content, baseHash: planned.baseHash, project, planned, title: `Use ${name} ${SCOPE[scope].where}?` });
    } catch (e) {
      toast({ text: e instanceof ApiError ? e.message : String(e), tone: "bad" });
    }
  };

  return (
    <>
      <header className="head cols">
        <div className="head-text">
          <h1>{c.title}</h1>
        </div>
        <div className="head-file" ref={setHeadSlot} />
        <div className="head-actions">
          {kind !== "plugin" && <Button small onClick={() => setCreating(true)}><Icon.plus />{c.newLabel}</Button>}
        </div>
      </header>
      <div className="body three">
        <nav className="pane list" aria-label={c.title}>
          {view.items.length > 12 && (
            <div style={{ padding: "12px 12px 0" }}>
              <label className="search" style={{ minWidth: 0 }}>
                <Icon.search />
                <input placeholder={`Filter ${plural(view.items.length, c.one, c.many)}`} value={filter} onChange={(e) => setFilter(e.target.value)} />
              </label>
            </div>
          )}
          {filter && !groups.length && <p className="group-note" style={{ marginTop: 14 }}>Nothing matches “{filter}”.</p>}
          {view.findings && view.findings.length > 0 && (
            <div className="list-findings">
              <FindingList findings={view.findings} onOpenDoc={openDoc} empty="" />
            </div>
          )}
          {groups.map(([label, items]) => {
            // A plugin brings its own bundle; it folds away unless you're looking inside it.
            const bundle = items[0].source === "plugin";
            const open = !bundle || !!filter || items.some((d) => d.file.path === selectedPath);
            const rows = items.map((d) => (
                <button
                  key={`${d.file.path}#${d.name}`}
                  type="button"
                  className={`item ${(d.active === false || d.shadowedBy) && alt ? "dim" : ""}`}
                  aria-selected={isSelected(d)}
                  onClick={() => setParams({ file: d.file.path, name: d.name })}
                  onContextMenu={(e) => {
                    if (d.source === "builtin") return;
                    e.preventDefault();
                    fileMenu(e, d.file, { canDelete: d.source === "user" || d.source === "project", onDeleted: () => setParams({ file: null }), agent: alt ?? undefined });
                  }}
                  title={d.file.display}
                >
                  <span className="dot" style={{ ["--c" as string]: (alt ? false : d.active) ? "var(--sage)" : d.source === "plugin" || d.source === "builtin" ? "var(--faint)" : "var(--ink-2)" }} />
                  <span className="t">{d.name}</span>
                  <span className="m">
                    {alt && d.active === false ? <span className="tag">Off</span> : !alt && d.active ? <span className="tag on">In use</span> : d.shadowedBy ? <span className="tag" title={alt ? `${d.shadowedBy} wins` : "A custom agent by this name replaces it"}>{alt && d.source !== "builtin" ? "Overridden" : "Replaced"}</span> : <Tally counts={d.counts} />}
                  </span>
                  <span className="s">{d.description || d.file.name}</span>
                </button>
              ));
            return bundle ? (
              <details className="group bundle" key={label} open={open}>
                <summary className="group-h"><h2>{label}</h2><span className="n">{items.length}</span></summary>
                {rows}
              </details>
            ) : (
              <div className="group" key={label}>
                <div className="group-h"><h2>{label}</h2></div>
                {rows}
              </div>
            );
          })}
          {!view.items.length && <p className="group-note">None yet.</p>}
          <p className="list-foot folders-foot">
            Folders:{" "}
            {view.locations.map((l, i) => (
              <span key={l.path}>
                {i > 0 && " · "}
                <button type="button" className="linkbtn quiet" title={l.display} disabled={!desktop || !l.exists} onClick={() => void desktop?.reveal(l.path)}>
                  {l.label}
                </button>
              </span>
            ))}
          </p>
        </nav>
        {selected?.source === "builtin" ? (
          <Builtin d={selected} kind={kind} agentName={alt ? altName : "Claude Code"} onUse={useStyle} canProject={!!project} docs={view.doc} onOpenDoc={openDoc} />
        ) : selectedPath ? (
          <FileWorkspace
            key={selectedPath}
            path={selectedPath}
            canDelete={selected?.source === "user" || selected?.source === "project"}
            onDeleted={() => setParams({ file: null })}
            agent={alt ?? undefined}
            formattable={kind === "skill" || kind === "command"}
            facts={selected ? [["From", selected.source === "plugin" ? `${selected.where} plugin` : selected.where]] : []}
            top={kind === "style" && selected ? <StyleUse d={selected} onUse={useStyle} canProject={!!project} /> : selected?.twin ? <Twin twin={selected.twin} name={selected.name} /> : undefined}
            bottom={alt ? undefined : <Fields kind={kind} path={selectedPath} />}
          />
        ) : (
          <section className="pane center">
            <Empty title={`No ${c.many} yet.`} action={kind === "plugin" ? undefined : <Button kind="primary" onClick={() => setCreating(true)}><Icon.plus />{c.newLabel}</Button>}>
              {ABOUT[kind].replace("{agent}", alt ? altName : "Claude Code") || undefined}
            </Empty>
          </section>
        )}
      </div>
      {creating && (
        <CreateSheet
          kind={kind}
          agentName={alt ? altName : "Claude"}
          locations={view.locations}
          onClose={() => setCreating(false)}
          onCreate={(dir, name, description) => {
            setCreating(false);
            // Codex's custom agents are TOML files with name, description and developer_instructions; OpenCode's are Markdown.
            const p = codex && kind === "agent" ? `${dir}/${name}.toml` : pathFor(kind, dir, name);
            const content =
              codex && kind === "agent"
                ? codexAgentTemplate(name, description)
                : alt === "opencode" && kind === "agent"
                  ? opencodeAgentTemplate(name, description)
                  : kind === "command"
                    ? opencodeCommandTemplate(name, description)
                    : alt
                    ? template(kind, name, description).replace(/Claude/g, altName)
                    : template(kind, name, description);
            save({ path: p, content, baseHash: null, project, onSaved: () => setParams({ file: p, name: null }) });
          }}
        />
      )}
    </>
  );
}

function StyleUse({ d, onUse, canProject }: { d: Definition; onUse: (n: string, s: "user" | "project" | "local") => void; canProject: boolean }) {
  const [scope, setScope] = useState<"user" | "project" | "local">("user");
  if (d.active) return <section><h3>In use</h3><p className="clear">Shapes every reply from your next message on.</p></section>;
  return (
    <section>
      <h3>Use this style</h3>
      <div className="use-row">
        <select className="select" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} aria-label="Where to set it">
          {USE_IN.filter((u) => canProject || !u.needsProject).map((u) => (
            <option key={u.value} value={u.value}>{u.label}</option>
          ))}
        </select>
        <button type="button" className="btn primary" onClick={() => onUse(d.name, scope)}>Use</button>
      </div>
    </section>
  );
}

/** A definition built into the agent: no file, so what its docs say about it. */
function Builtin(props: { d: Definition; kind: Kind; agentName: string; onUse: (n: string, s: "user" | "project" | "local") => void; canProject: boolean; docs: DefinitionsView["doc"]; onOpenDoc: (d: DefinitionsView["doc"]) => void }) {
  const html = useMemo(() => renderMarkdown(props.d.body || props.d.description), [props.d.body, props.d.description]);
  const agent = props.agentName;
  return (
    <>
      <section className="pane center">
        <div className="note-read">
          <article>
            <h1>{props.d.name}</h1>
            <p className="note-meta"><span className="tag">Built into {agent}</span><span>{props.d.description}</span></p>
            <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
          </article>
        </div>
      </section>
      <aside className="pane inspector">
        <div className="insp">
          {props.kind === "style" && <StyleUse d={props.d} onUse={props.onUse} canProject={props.canProject} />}
          <section className="about">
            <p>{props.kind === "style" ? "Built-in styles keep Claude Code's software engineering instructions and add their own. To change one, write your own style." : `Built into ${agent}. A custom one with the same name replaces it.`}</p>
            <DocLink doc={props.docs} onOpen={props.onOpenDoc} />
          </section>
        </div>
      </aside>
    </>
  );
}

/** The documented frontmatter fields for this kind of file, with the values this file sets. */
function Fields({ kind, path }: { kind: Kind; path: string }) {
  const { project } = useApp();
  const { data } = useResource<FileView>(`/api/file${qs({ path, project })}`);
  const fm = data?.frontmatter;
  if (!fm || !fm.fields.length) return null;
  const set = fm.fields.filter((f) => fm.values[f.name] !== undefined);
  const unset = fm.fields.filter((f) => fm.values[f.name] === undefined);
  const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  return (
    <section>
      <h3>Frontmatter</h3>
      <dl className="fields">
        {set.map((f) => (
          <FieldRow key={f.name} name={f.name} value={show(fm.values[f.name])} />
        ))}
      </dl>
      {unset.length > 0 && (
        <details className="more-fields">
          <summary>{unset.length} more fields you can set</summary>
          <p>{unset.map((f) => f.name).join(", ")}. {kind === "agent" ? "Field names are case-sensitive and use camelCase." : "Field names use lowercase words and hyphens."}</p>
        </details>
      )}
    </section>
  );
}

function FieldRow({ name, value }: { name: string; value: string }) {
  return (
    <div>
      <dt><code>{name}</code></dt>
      <dd title={value}>{value.length > 160 ? value.slice(0, 160) + "…" : value}</dd>
    </div>
  );
}

function CreateSheet(props: { kind: Kind; agentName: string; locations: DefinitionsView["locations"]; onClose: () => void; onCreate: (dir: string, name: string, description: string) => void }) {
  const [dir, setDir] = useState(props.locations[props.locations.length > 1 ? 1 : 0]?.path ?? "");
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const c = COPY[props.kind];
  return (
    <Sheet
      title={c.newLabel}
      width="narrow"
      onClose={props.onClose}
      footer={
        <>
          <span className="note">{slug ? pathFor(props.kind, props.locations.find((l) => l.path === dir)?.display ?? dir, slug) : ""}</span>
          <Button kind="quiet" onClick={props.onClose}>Cancel</Button>
          <Button kind="primary" disabled={!slug} onClick={() => props.onCreate(dir, slug, desc)}>Continue</Button>
        </>
      }
    >
      <div className="prefs">
        <div className="prefrow" style={{ display: "grid", gap: 6 }}>
          <b>Name</b>
          <input className="field" data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder={props.kind === "agent" ? "code-reviewer" : props.kind === "style" ? "Terse" : props.kind === "command" ? "review" : "release-notes"} />
        </div>
        <div className="prefrow" style={{ display: "grid", gap: 6 }}>
          <b>{props.kind === "command" ? "What does it do?" : `When should ${props.agentName} use it?`}</b>
          <textarea className="field" rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} style={{ fontFamily: "var(--sans)", fontSize: 13 }} />
          <p>{props.kind === "style" ? "Shown in the style picker." : props.kind === "command" ? "Shown in the command list." : `${props.agentName} reads this to decide. Put the main use first.`}</p>
        </div>
        <div className="prefrow" style={{ display: "grid", gap: 6 }}>
          <b>Where</b>
          <select className="select" value={dir} onChange={(e) => setDir(e.target.value)}>
            {props.locations.map((l) => (
              <option key={l.path} value={l.path}>{l.label}</option>
            ))}
          </select>
        </div>
      </div>
    </Sheet>
  );
}

/** Whether the other agent has this skill, and whether a change here reaches it. */
function Twin({ twin, name }: { twin: NonNullable<Definition["twin"]>; name: string }) {
  const { project } = useApp();
  const other = twin.agent === "codex" ? "Codex" : "Claude Code";
  const text =
    twin.relation === "same"
      ? `${other} reads this same file, so a change here reaches both.`
      : twin.relation === "copy"
        ? `${other} has its own copy of this skill, with the same text. A change here doesn't reach it.`
        : `${other} has a different skill named ${name}. A change here doesn't reach it.`;
  return (
    <section>
      <h3>In {other}</h3>
      <p className="clear">{text}</p>
      {twin.relation !== "same" && (
        <a className="btn small" href={href("skills", { project, agent: twin.agent === "codex" ? "codex" : null, file: twin.path })}>
          {twin.relation === "copy" ? `Open ${other}'s copy` : `Open ${other}'s skill`}
        </a>
      )}
    </section>
  );
}
