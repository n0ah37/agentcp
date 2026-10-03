import { useMemo, useState } from "react";

import type { AgentCommand, AvailablePlugin, PluginInfo, PluginsView } from "../../shared/types.ts";
import { qs } from "../api.ts";
import { desktop } from "../desktop.ts";
import { href, useParams } from "../router.ts";
import { useResource } from "../store.ts";
import { Button, DocLink, Empty, Sheet, when } from "../ui/kit.tsx";
import { Icon } from "../ui/icons.tsx";
import { SCOPE } from "../ui/scopes.ts";
import { useApp } from "../shell/app-context.ts";
import { CommandSheet } from "../shell/CommandSheet.tsx";

type Pending = { title: string; action: string; command: AgentCommand };

const ORIGIN = { marketplace: "From a marketplace", synced: "From your claude.ai account", "skills-dir": "Saved in a skills folder" } as const;
const FOR = { user: "You, in every project", project: "Everyone in this project", local: "You, in this project" } as const;

/** Claude Code's plugins: which load here, why, and what each one adds. Changes go through Claude Code's own plugin commands. */
export function Plugins() {
  const { project, openDoc } = useApp();
  const [params, setParams] = useParams();
  const { data: v, error } = useResource<PluginsView>(`/api/plugins${qs({ project })}`);
  const [pending, setPending] = useState<Pending | null>(null);
  const [adding, setAdding] = useState(false);
  if (error) return <Empty title="Plugins couldn't be read.">{error.message}</Empty>;
  if (!v) return <p className="loading">Reading plugins…</p>;
  const selected = v.plugins.find((p) => p.id === params.get("plugin")) ?? v.plugins[0] ?? null;
  // Grouped by where each came from: two plugins can share a name across origins.
  const groups: [string, PluginInfo[]][] = [
    ["From marketplaces", v.plugins.filter((p) => p.origin === "marketplace")],
    ["From your claude.ai account", v.plugins.filter((p) => p.origin === "synced")],
    ["Saved in a skills folder", v.plugins.filter((p) => p.origin === "skills-dir")],
  ];
  return (
    <>
      <header className="head cols">
        <div className="head-text">
          <h1>Plugins</h1>
        </div>
        <div className="head-file" />
        <div className="head-actions">
          <Button small onClick={() => setAdding(true)}><Icon.plus />Add a plugin…</Button>
        </div>
      </header>
      <div className="body three">
        <nav className="pane list" aria-label="Plugins">
          {groups.map(([label, items]) =>
            items.length ? (
              <div className="group" key={label}>
                <div className="group-h"><h2>{label}</h2><span className="n">{items.length}</span></div>
                {items.map((p) => (
                  <button key={p.id} type="button" className={`item ${p.on ? "" : "dim"}`} aria-selected={selected?.id === p.id} onClick={() => setParams({ plugin: p.id })} title={p.id}>
                    <span className="dot" style={{ ["--c" as string]: p.on ? "var(--sage)" : "var(--faint)" }} />
                    <span className="t">{p.name}</span>
                    <span className="m">{p.on ? "" : <span className="tag">Off</span>}</span>
                    <span className="s">{items.filter((x) => x.name === p.name).length > 1 && p.marketplace ? `From ${p.marketplace}` : p.description || (p.marketplace ? `From ${p.marketplace}` : ORIGIN[p.origin])}</span>
                  </button>
                ))}
              </div>
            ) : null,
          )}
          {!v.plugins.length && <p className="group-note">No plugins yet. Install one in Claude Code with /plugin.</p>}
          <p className="list-foot" title={v.root}>Changes go through Claude Code's own plugin commands, the same as /plugin.</p>
        </nav>
        {selected ? (
          <>
            <section className="pane center" aria-label={selected.name}>
              <div className="note-read">
                <article>
                  <h1>{selected.name}</h1>
                  <p className="note-meta">
                    <span className={`tag ${selected.on ? "on" : ""}`}>{selected.on ? "On" : "Off"}</span>
                    <span>{selected.why}</span>
                  </p>
                  {selected.description && <p>{selected.description}</p>}
                  <Adds p={selected} />
                </article>
              </div>
            </section>
            <aside className="pane inspector" aria-label="About this plugin">
              <div className="insp">
                <Manage p={selected} onRun={setPending} />
                <section className="about">
                  <dl className="facts">
                    <dt>From</dt>
                    <dd>{selected.origin === "marketplace" ? `The ${selected.marketplace} marketplace` : ORIGIN[selected.origin]}</dd>
                    {selected.installedFor && (<><dt>Installed for</dt><dd>{FOR[selected.installedFor]}</dd></>)}
                    {selected.version && (<><dt>Version</dt><dd>{selected.version}</dd></>)}
                    {selected.author && (<><dt>By</dt><dd>{selected.author}</dd></>)}
                    {selected.updated && (<><dt>Updated</dt><dd>{when(selected.updated)}</dd></>)}
                    <dt>Id</dt>
                    <dd className="mono">{selected.id}</dd>
                  </dl>
                  <div className="insp-links">
                    {desktop && (
                      <button type="button" className="linkbtn" onClick={() => void desktop?.reveal(selected.path)}>Show in Finder</button>
                    )}
                    <DocLink doc={v.doc} onOpen={openDoc} label="Where plugins come from" />
                  </div>
                </section>
              </div>
            </aside>
          </>
        ) : (
          <section className="pane center">
            <Empty title="No plugins yet." action={<Button kind="primary" onClick={() => setAdding(true)}><Icon.plus />Add a plugin…</Button>}>
              Plugins add skills, subagents, hooks and MCP servers to Claude Code.
            </Empty>
          </section>
        )}
      </div>
      {adding && <AddPlugin canProject={!!project} onClose={() => setAdding(false)} onPick={(id, scope) => (setAdding(false), setPending({ title: `Install ${id.split("@")[0]}?`, action: "Install", command: { kind: "plugin", action: "install", id, scope } }))} />}
      {pending && <CommandSheet title={pending.title} action={pending.action} command={pending.command} onClose={() => setPending(null)} />}
    </>
  );
}

/** Turn a plugin on or off, update it or remove it, with Claude Code's own plugin commands. */
function Manage({ p, onRun }: { p: PluginInfo; onRun: (x: Pending) => void }) {
  const scope = p.installedFor ?? undefined;
  const toggle = () =>
    onRun(p.on
      ? { title: `Turn off ${p.name}?`, action: "Turn off", command: { kind: "plugin", action: "disable", id: p.id, scope } }
      : { title: `Turn on ${p.name}?`, action: "Turn on", command: { kind: "plugin", action: "enable", id: p.id, scope } });
  return (
    <section className="manage">
      <div className="manage-row">
        <Button small kind={p.on ? undefined : "primary"} onClick={toggle}>{p.on ? "Turn off…" : "Turn on…"}</Button>
        {p.origin === "marketplace" && (
          <>
            <Button small onClick={() => onRun({ title: `Update ${p.name}?`, action: "Update", command: { kind: "plugin", action: "update", id: p.id, scope } })}>Update…</Button>
            <Button small kind="quiet" onClick={() => onRun({ title: `Uninstall ${p.name}?`, action: "Uninstall", command: { kind: "plugin", action: "uninstall", id: p.id, scope: scope ?? "user" } })}>Uninstall…</Button>
          </>
        )}
      </div>
      {p.origin === "synced" && <p className="faint">It comes from your claude.ai account. Remove it there.</p>}
    </section>
  );
}

/** The plugins your marketplaces offer, to install with `claude plugin install`. */
function AddPlugin({ canProject, onClose, onPick }: { canProject: boolean; onClose: () => void; onPick: (id: string, scope: "user" | "project" | "local") => void }) {
  const { data: all, error } = useResource<AvailablePlugin[]>("/api/plugins/available");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [scope, setScope] = useState<"user" | "project" | "local">("user");
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (all ?? []).filter((p) => !n || p.name.toLowerCase().includes(n) || p.description.toLowerCase().includes(n));
  }, [all, q]);
  const choice = (all ?? []).find((p) => p.id === picked);
  return (
    <Sheet
      title="Add a plugin"
      subtitle="From the marketplaces you've added in Claude Code."
      onClose={onClose}
      footer={
        <>
          <label className="note inline-select">
            For
            <select className="select" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} aria-label="Install it for">
              <option value="user">{SCOPE.user.label}</option>
              {canProject && <option value="project">{SCOPE.project.label}</option>}
              {canProject && <option value="local">{SCOPE.local.label}</option>}
            </select>
          </label>
          <Button kind="quiet" onClick={onClose}>Cancel</Button>
          <Button kind="primary" disabled={!choice || choice.installed} onClick={() => choice && onPick(choice.id, scope)}>Continue</Button>
        </>
      }
    >
      <input className="field" data-autofocus placeholder="Find a plugin" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="pick-list">
        {error && <p className="bad">{error.message}</p>}
        {!all && !error && <p className="loading">Reading your marketplaces…</p>}
        {all && !all.length && <p className="faint">No marketplaces yet. Add one in Claude Code with claude plugin marketplace add.</p>}
        {shown.map((p) => (
          <button key={p.id} type="button" className="pick" aria-pressed={picked === p.id} disabled={p.installed} onClick={() => setPicked(p.id)}>
            <b>{p.name}</b>
            <span className="m">{p.installed ? "Installed" : p.marketplace}</span>
            <span className="s">{p.description || "No description."}{p.runsCommand ? " It runs its own install command, so install it in your terminal." : ""}</span>
          </button>
        ))}
      </div>
    </Sheet>
  );
}

type Item = { name: string; to: string | null };

/** What a plugin adds, each item a link to where it opens: the skill, the subagent, the server. */
function Adds({ p }: { p: PluginInfo }) {
  const { project } = useApp();
  const a = p.adds;
  const files = (screen: "skills" | "agents" | "styles", list: { name: string; path: string }[]): Item[] => list.map((x) => ({ name: x.name, to: href(screen, { project, file: x.path }) }));
  // The section titles are plain; only the things themselves link to where they live.
  const rows: [string, Item[], string | null][] = [
    ["Skills", files("skills", a.skills), `Called as ${p.name}:<name>.`],
    ["Subagents", files("agents", a.agents), `Called as ${p.name}:<name>.`],
    ["Commands", a.commands.map((n) => ({ name: n, to: null })), `Typed as /${p.name}:<name>.`],
    ["Output styles", files("styles", a.styles), null],
    ["MCP servers", a.mcp.map((n) => ({ name: n, to: href("mcp", { project, server: `plugin:${p.name}:${n}` }) })), `Listed as plugin:${p.name}:<name>.`],
    ["Language servers", a.lsp.map((n) => ({ name: n, to: null })), null],
  ];
  const any = rows.some(([, l]) => l.length) || a.hooks > 0;
  if (!any) return <p className="faint">It doesn't add skills, subagents, commands, hooks or servers.</p>;
  return (
    <div className="adds">
      {rows.filter(([, l]) => l.length).map(([label, list, how]) => (
        <section key={label}>
          <h2>
            {label} <span className="n">{list.length}</span>
          </h2>
          {how && <p className="how">{how}</p>}
          <ul className="names">
            {list.map((n) => (
              <li key={n.name}>{n.to ? <a href={n.to}>{n.name}</a> : n.name}</li>
            ))}
          </ul>
        </section>
      ))}
      {a.hooks > 0 && (
        <section>
          <h2>Hooks <span className="n">{a.hooks}</span></h2>
          <p>
            {a.hooks === 1 ? "One hook, which runs while the plugin is on. " : `${a.hooks} hooks, which run while the plugin is on. `}
            <a href={href("hooks", { project })}>See {a.hooks === 1 ? "it" : "them"} on the Hooks screen</a>.
          </p>
        </section>
      )}
    </div>
  );
}
