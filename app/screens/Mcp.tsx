import { useState } from "react";

import type { AgentCommand, McpServer, McpView, WritePlan } from "../../shared/types.ts";
import { agentName, useAgent } from "../agent.ts";
import { ApiError, api, qs } from "../api.ts";
import { href } from "../router.ts";
import { CommandSheet } from "../shell/CommandSheet.tsx";
import { SCOPE } from "../ui/scopes.ts";
import { useParams } from "../router.ts";
import { useResource } from "../store.ts";
import { Icon } from "../ui/icons.tsx";
import { Button, DocLink, Empty, FindingList, Sheet, Tally, useRevealSelected } from "../ui/kit.tsx";
import { useApp } from "../shell/app-context.ts";

const STATUS: Record<McpServer["status"], string | null> = { on: null, off: "Off", pending: "Needs approval", replaced: "Not used", skipped: "Skipped", empty: "No address" };
const HOW = { stdio: "Runs a command on this Mac", http: "Connects over HTTP", sse: "Connects over HTTP (server-sent events)", ws: "Connects over WebSocket" } as const;

/** The MCP servers an agent connects to, and the file that decides each one. Read-only: the agents add and remove them. */
export function Mcp() {
  const { project, openDoc } = useApp();
  const [params, setParams] = useParams();
  const id = useAgent();
  const codex = id === "codex";
  // OpenCode's servers are listed, not managed: its config files are edited as files.
  const oc = id === "opencode";
  const agent = agentName(id);
  const { data: v, error } = useResource<McpView>(`/api/mcp${qs({ project, agent: id === "claude" ? null : id })}`);
  const [pending, setPending] = useState<{ title: string; action: string; command: AgentCommand } | null>(null);
  const [adding, setAdding] = useState(false);
  useRevealSelected(params.get("server"), !!v);
  if (error) return <Empty title="MCP servers couldn't be read.">{error.message}</Empty>;
  if (!v) return <p className="loading">Reading MCP servers…</p>;
  const key = (s: McpServer) => `${s.file}\u0000${s.where}\u0000${s.name}`;
  // A link from another screen names the server (plugin:<plugin>:<name>); a click here names the exact entry.
  const asked = params.get("server");
  const selected = v.servers.find((s) => key(s) === asked) ?? v.servers.find((s) => s.name === asked && s.status === "on") ?? v.servers.find((s) => s.name === asked) ?? v.servers.find((s) => s.status === "on") ?? v.servers[0] ?? null;
  const groups = [...new Set(v.servers.map((s) => s.where))].map((w) => [w, v.servers.filter((s) => s.where === w)] as const);
  return (
    <>
      <header className="head cols">
        <div className="head-text">
          <h1>MCP servers</h1>
        </div>
        <div className="head-file" />
        <div className="head-actions">
          {!oc && <Button small onClick={() => setAdding(true)}><Icon.plus />Add a server…</Button>}
        </div>
      </header>
      <div className="body three">
        <nav className="pane list" aria-label="MCP servers">
          {v.files.filter((f) => f.broken).map((f) => (
            <p key={f.display} className="banner warn">{f.display} {f.broken}, so {agent} reads no servers from it.</p>
          ))}
          {groups.map(([where, items]) => (
            <div className="group" key={where}>
              <div className="group-h"><h2>{where}</h2><span className="n">{items.length}</span></div>
              {items.map((s) => (
                <button key={key(s)} type="button" className={`item ${s.status === "on" ? "" : "dim"}`} aria-selected={selected && key(selected) === key(s)} onClick={() => setParams({ server: key(s) })} title={s.endpoint}>
                  <span className="dot" style={{ ["--c" as string]: s.status === "on" ? "var(--sage)" : s.status === "pending" ? "var(--amber)" : "var(--faint)" }} />
                  <span className="t">{s.name.replace(/^plugin:[^:]+:/, "")}</span>
                  <span className="m">
                    {STATUS[s.status] && <span className="tag">{STATUS[s.status]}</span>}
                    <Tally counts={{ problem: s.findings.filter((f) => f.severity === "problem").length, warning: s.findings.filter((f) => f.severity === "warning").length, note: s.findings.filter((f) => f.severity === "note").length }} />
                  </span>
                  <span className="s mono">{s.endpoint || "No command or address"}</span>
                </button>
              ))}
            </div>
          ))}
          {!v.servers.length && <p className="group-note">{agent} has no MCP servers here yet. Add one with {codex ? "codex mcp add" : oc ? "opencode mcp add" : "claude mcp add"}.</p>}
          <p className="list-foot" title={v.files.map((f) => f.display).join("\n")}>
            {codex
              ? "From your config.toml and a trusted project's .codex/config.toml."
              : oc
                ? "From mcp in your opencode.json and this project's, merged in OpenCode's order."
                : "From ~/.claude.json, this project's .mcp.json and your plugins. Connectors added on claude.ai come from your account, so they aren't listed."}
          </p>
        </nav>
        {selected ? (
          <>
            <section className="pane center" aria-label={selected.name}>
              <div className="note-read">
                <article>
                  <h1>{selected.name.replace(/^plugin:[^:]+:/, "")}</h1>
                  <p className="note-meta">
                    <span className={`tag ${selected.status === "on" ? "on" : ""}`}>{STATUS[selected.status] ?? "On"}</span>
                    <span>{selected.note}</span>
                  </p>
                  <dl className="facts wide">
                    <dt>How</dt>
                    <dd>{HOW[selected.transport]}</dd>
                    <dt>{selected.transport === "stdio" ? "Command" : "Address"}</dt>
                    <dd className="mono">{selected.endpoint || "None"}</dd>
                    {selected.secrets.length > 0 && (
                      <>
                        <dt>Sets</dt>
                        <dd>{selected.secrets.join(", ")}. Values aren't shown.</dd>
                      </>
                    )}
                    <dt>Set in</dt>
                    <dd>{selected.where}, in <span className="mono">{selected.file}</span></dd>
                    {selected.scope === "plugin" && (
                      <>
                        <dt>Full name</dt>
                        <dd className="mono">{selected.name}</dd>
                      </>
                    )}
                  </dl>
                </article>
              </div>
            </section>
            <aside className="pane inspector" aria-label="About this server">
              <div className="insp">
                {oc ? (
                  <section className="manage">
                    <p className="clear">To change it, edit mcp in <span className="mono">{selected.file}</span>, or run opencode mcp add.</p>
                  </section>
                ) : (
                  <Manage s={selected} codex={codex} onRun={setPending} />
                )}
                {selected.findings.length > 0 ? (
                  <section>
                    <h3>Suggestions · {selected.findings.length}</h3>
                    <FindingList findings={selected.findings} onOpenDoc={openDoc} empty="" />
                  </section>
                ) : (
                  <p className="insp-ok"><Icon.check />Matches {agent}'s docs</p>
                )}
                <section className="about">
                  <p>
                    {codex
                      ? `Codex reads MCP servers from [mcp_servers] in your config.toml and in a trusted project's .codex/config.toml.`
                      : oc
                        ? "OpenCode merges mcp from its config files; a later file's values win where both set one, and enabled: false turns a server off."
                        : "When the same server is set in more than one place, Claude Code uses the first: this project just for you, this project for everyone, you, then plugins."}
                  </p>
                  <DocLink doc={v.doc} onOpen={openDoc} />
                </section>
              </div>
            </aside>
          </>
        ) : (
          <section className="pane center">
            <Empty title={`No MCP servers for ${agent} here.`} action={oc ? undefined : <Button kind="primary" onClick={() => setAdding(true)}><Icon.plus />Add a server…</Button>}>
              MCP servers give {agent} tools from other apps and services.
            </Empty>
          </section>
        )}
      </div>
      {adding && <AddServer codex={codex} onClose={() => setAdding(false)} onCommand={(c) => (setAdding(false), setPending({ title: `Add ${c.kind === "mcp-add" ? c.name : "the server"}?`, action: "Add", command: c }))} />}
      {pending && <CommandSheet title={pending.title} action={pending.action} command={pending.command} onClose={() => setPending(null)} />}
    </>
  );
}

const CLAUDE_SCOPE = { local: "local", project: "project", user: "user" } as const;

/** What can be done to this server, and how: a reviewed file change, or Claude Code's own command. */
function Manage({ s, codex, onRun }: { s: McpServer; codex: boolean; onRun: (x: { title: string; action: string; command: AgentCommand }) => void }) {
  const { project, save, toast } = useApp();
  const short = s.name.replace(/^plugin:[^:]+:/, "");
  const plan = async (change: object, title: string) => {
    try {
      const planned = await api.post<{ plan: WritePlan; content: string; baseHash: string | null }>("/api/mcp/plan", { project, change });
      save({ path: planned.plan.path, content: planned.content, baseHash: planned.baseHash, project, planned, title });
    } catch (e) {
      toast({ text: e instanceof ApiError ? e.message : String(e), tone: "bad" });
    }
  };
  if (s.scope === "plugin") {
    const plugin = s.name.split(":")[1];
    return (
      <section className="manage">
        <h3>From a plugin</h3>
        <p className="clear">It comes with the {plugin} plugin and goes when you turn the plugin off.</p>
        <div className="manage-row"><a className="btn small" href={href("plugins", { project })}>Open Plugins</a></div>
      </section>
    );
  }
  if (s.scope === "managed") {
    return <section className="manage"><h3>Set by your organization</h3><p className="clear">Only your organization can change or remove it.</p></section>;
  }
  if (codex) {
    const scope = s.scope === "project" ? "project" : "user";
    return (
      <section className="manage">
        <div className="manage-row">
          {s.status === "off" && s.note.startsWith("Turned off") ? (
            <Button small kind="primary" onClick={() => void plan({ agent: "codex", kind: "enable", name: s.name, scope }, `Turn on ${s.name}?`)}>Turn on…</Button>
          ) : (
            <Button small onClick={() => void plan({ agent: "codex", kind: "disable", name: s.name, scope }, `Turn off ${s.name}?`)}>Turn off…</Button>
          )}
          <Button small kind="quiet" onClick={() => void plan({ agent: "codex", kind: "remove", name: s.name, scope }, `Remove ${s.name}?`)}>Remove…</Button>
        </div>
      </section>
    );
  }
  const remove = () => onRun({ title: `Remove ${short}?`, action: "Remove", command: { kind: "mcp-remove", name: short, scope: CLAUDE_SCOPE[s.scope as keyof typeof CLAUDE_SCOPE] } });
  return (
    <section className="manage">
      <div className="manage-row">
        {s.scope === "project" && s.status !== "on" && <Button small kind="primary" onClick={() => void plan({ agent: "claude", kind: "approve", name: s.name }, `Approve ${s.name} for you in this project?`)}>Approve…</Button>}
        {s.scope === "project" && s.status !== "off" && <Button small onClick={() => void plan({ agent: "claude", kind: "reject", name: s.name }, `Turn off ${s.name} for you in this project?`)}>Turn off…</Button>}
        <Button small kind="quiet" onClick={remove}>Remove…</Button>
      </div>
      {s.scope !== "project" && <p className="faint">To turn it off in one project only, use /mcp in Claude Code.</p>}
    </section>
  );
}

type Row = [string, string];

/** Add a server: Claude Code's own command for Claude Code, a reviewed config.toml change for Codex. */
function AddServer({ codex, onClose, onCommand }: { codex: boolean; onClose: () => void; onCommand: (c: AgentCommand) => void }) {
  const { project, save, toast } = useApp();
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [url, setUrl] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [tokenVar, setTokenVar] = useState("");
  const [scope, setScope] = useState<"user" | "project" | "local">(project ? "local" : "user");
  const ready = !!name.trim() && (transport === "http" ? !!url.trim() : !!command.trim());
  const argv = args.trim() ? args.trim().split(/\s+/) : [];
  const submit = async () => {
    if (!ready) return;
    if (!codex) {
      const kv = rows.filter(([k]) => k.trim());
      onCommand({ kind: "mcp-add", name: name.trim(), scope, transport, ...(transport === "http" ? { url: url.trim(), headers: kv } : { command: command.trim(), args: argv, env: kv }) });
      return;
    }
    try {
      const change = { agent: "codex", kind: "add", name: name.trim(), scope: scope === "user" ? "user" : "project", transport, url: url.trim(), tokenVar: tokenVar.trim() || undefined, command: command.trim(), args: argv, envVars: rows.map(([k]) => k.trim()).filter(Boolean) };
      const planned = await api.post<{ plan: WritePlan; content: string; baseHash: string | null }>("/api/mcp/plan", { project, change });
      onClose();
      save({ path: planned.plan.path, content: planned.content, baseHash: planned.baseHash, project, planned, title: `Add ${name.trim()} to Codex?` });
    } catch (e) {
      toast({ text: e instanceof ApiError ? e.message : String(e), tone: "bad" });
    }
  };
  const rowLabel = transport === "http" ? (codex ? null : "Headers") : codex ? "Environment variables to pass on" : "Environment variables";
  return (
    <Sheet
      title={`Add an MCP server to ${codex ? "Codex" : "Claude Code"}`}
      subtitle={codex ? "Saved in config.toml. Secrets stay in your environment: give the variable's name, not its value." : "Claude Code adds it with claude mcp add. You see the command before it runs."}
      onClose={onClose}
      footer={
        <>
          <Button kind="quiet" onClick={onClose}>Cancel</Button>
          <Button kind="primary" disabled={!ready} onClick={() => void submit()}>Continue</Button>
        </>
      }
    >
      <form className="form" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <label>
          <span>Name</span>
          <input className="field" data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="github" spellCheck={false} />
        </label>
        <label>
          <span>Type</span>
          <div className="seg" role="group" aria-label="Type">
            <button type="button" aria-pressed={transport === "http"} onClick={() => setTransport("http")}>A web address</button>
            <button type="button" aria-pressed={transport === "stdio"} onClick={() => setTransport("stdio")}>A command on this Mac</button>
          </div>
        </label>
        {transport === "http" ? (
          <label>
            <span>Address</span>
            <input className="field" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" spellCheck={false} />
          </label>
        ) : (
          <>
            <label>
              <span>Command</span>
              <input className="field" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" spellCheck={false} />
            </label>
            <label>
              <span>Arguments</span>
              <input className="field" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-github" spellCheck={false} />
            </label>
          </>
        )}
        {codex && transport === "http" && (
          <label>
            <span>Token variable</span>
            <input className="field" value={tokenVar} onChange={(e) => setTokenVar(e.target.value)} placeholder="GITHUB_TOKEN (optional)" spellCheck={false} />
          </label>
        )}
        {rowLabel && (
          <div className="form-rows">
            <span className="label">{rowLabel}</span>
            {rows.map(([k, val], i) => (
              <div className="kv" key={i}>
                <input className="field" value={k} onChange={(e) => setRows(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} placeholder={transport === "http" ? "Authorization" : "API_KEY"} spellCheck={false} />
                {codex ? <span /> : <input className="field" type="password" value={val} onChange={(e) => setRows(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))} placeholder="Value" />}
                <button type="button" className="linkbtn quiet" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</button>
              </div>
            ))}
            <button type="button" className="linkbtn" onClick={() => setRows([...rows, ["", ""]])}>Add one</button>
          </div>
        )}
        <label>
          <span>Save to</span>
          <select className="select" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
            {codex ? (
              <>
                <option value="user">Your Codex config</option>
                {project && <option value="project">This project's Codex config</option>}
              </>
            ) : (
              <>
                {project && <option value="local">{SCOPE.local.label}</option>}
                {project && <option value="project">{SCOPE.project.label}</option>}
                <option value="user">{SCOPE.user.label}</option>
              </>
            )}
          </select>
        </label>
      </form>
    </Sheet>
  );
}
