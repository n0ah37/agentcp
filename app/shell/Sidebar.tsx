import { useEffect, useMemo, useRef, useState } from "react";

import type { AgentId, CodexView, InstructionsView, ProjectRef } from "../../shared/types.ts";
import { agentName, agentParam, useAgent, useAgentsOn } from "../agent.ts";
import { qs } from "../api.ts";
import { go, href, useRoute, type Screen } from "../router.ts";
import { useResource } from "../store.ts";
import { Icon } from "../ui/icons.tsx";
import { WindowButtons, when } from "../ui/kit.tsx";
import { useApp } from "./app-context.ts";

type Row = { screen: Screen; label: string; icon: keyof typeof Icon; agents: AgentId[]; both?: boolean; labelFor?: Partial<Record<AgentId, string>> };

/**
 * In the View menu's order. The agent picker, under the project picker,
 * chooses whose files the first group shows: Output styles and Plugins are
 * Claude Code's alone, Rules are Codex's; OpenCode has no memory or hooks
 * files, and its agents include the primary ones, so its row says Agents.
 * Sessions and Usage cover every agent that's on, whatever the picker says,
 * so their links don't carry it.
 */
export const NAV: Row[] = [
  { screen: "instructions", label: "Instructions", icon: "instructions", agents: ["claude", "codex", "opencode"] },
  { screen: "memory", label: "Memory", icon: "memory", agents: ["claude", "codex"] },
  { screen: "agents", label: "Subagents", icon: "agents", agents: ["claude", "codex", "opencode"], labelFor: { opencode: "Agents" } },
  { screen: "styles", label: "Output styles", icon: "styles", agents: ["claude"] },
  { screen: "skills", label: "Skills", icon: "skills", agents: ["claude", "codex", "opencode"] },
  { screen: "plugins", label: "Plugins", icon: "plugin", agents: ["claude"] },
  { screen: "mcp", label: "MCP servers", icon: "plug", agents: ["claude", "codex", "opencode"] },
  { screen: "rules", label: "Rules", icon: "shield", agents: ["codex"] },
  { screen: "hooks", label: "Hooks", icon: "hook", agents: ["claude", "codex"] },
  { screen: "settings", label: "Settings", icon: "settings", agents: ["claude", "codex", "opencode"] },
  { screen: "sessions", label: "Sessions", icon: "sessions", agents: ["claude", "codex", "opencode"], both: true },
  { screen: "usage", label: "Usage", icon: "chart", agents: ["claude", "codex", "opencode"], both: true },
];

function NavLink({ n, to, current, count, agent }: { n: Row; to: string; current: boolean; count: { n: number; tone: string } | null; agent: AgentId }) {
  const I = Icon[n.icon];
  return (
    <a href={to} aria-current={current ? "page" : undefined}>
      <I />
      {n.labelFor?.[agent] ?? n.label}
      {count && count.n > 0 && <span className={`count ${count.tone}`}>{count.n.toLocaleString()}</span>}
    </a>
  );
}

export function Sidebar({ onSearch }: { onSearch: () => void }) {
  const route = useRoute();
  const { state, prefs, project, openPrefs } = useApp();
  const agent = useAgent();
  const on = useAgentsOn();
  const keep = { project: project ?? "", agent: agentParam(agent) };
  const { data: stack } = useResource<InstructionsView>(agent === "claude" ? `/api/instructions${qs({ project })}` : null);
  const { data: codex } = useResource<CodexView>(agent === "codex" ? `/api/codex${qs({ project })}` : null);
  const flagged = stack?.entries.reduce((n, e) => n + e.counts.problem + e.counts.warning, 0) ?? 0;
  const bad = stack?.entries.some((e) => e.counts.problem > 0);
  const cut = codex?.entries.filter((e) => e.loads === "cut" || e.loads === "dropped").length ?? 0;
  // The oldest documentation among the agents that are on; missing counts as none.
  const corpus = (a: AgentId) => (a === "claude" ? state!.docs : state!.docs[a]);
  const ages = state ? on.map((a) => (corpus(a).capturedAt ? (corpus(a).ageDays ?? 0) : null)) : [];
  const docsAge = ages.includes(null) ? null : Math.max(0, ...(ages as number[]));
  const count = agent === "claude" ? { n: flagged, tone: bad ? "bad" : "warn" } : { n: cut, tone: "warn" };

  return (
    <aside className="side" aria-label="AgentCP">
      <div className="side-top">
        <WindowButtons />
        <a className="wordmark" href={href("instructions", keep)} aria-label="AgentCP">
          AgentCP
        </a>
      </div>
      <ProjectPicker />
      {/* With one agent on, there's nothing to pick. */}
      {on.length > 1 && <AgentPicker agent={agent} on={on} />}
      {/* One list, no divider between the agent's files and Sessions and Usage (decided 2026-10-01). */}
      <nav className="navgroup" aria-label="Sections">
        {NAV.filter((n) => n.agents.includes(agent) && (n.screen !== "sessions" || prefs?.sessions)).map((n) => (
          <NavLink key={n.screen} n={n} to={href(n.screen, n.both ? { project: project ?? "" } : keep)} current={route.screen === n.screen} count={n.screen === "instructions" ? count : null} agent={agent} />
        ))}
      </nav>
      <div className="navfoot">
        <button type="button" onClick={onSearch}>
          <Icon.search />
          Search
          <kbd>⌘K</kbd>
        </button>
        <a href={href("history", keep)} aria-current={route.screen === "history" ? "page" : undefined}>
          <Icon.history />
          History
        </a>
        <button type="button" onClick={() => openPrefs()}>
          <Icon.prefs />
          Preferences
          <kbd>⌘,</kbd>
        </button>
        {state && (
          <button type="button" className="status-line" onClick={() => openPrefs(docsAge === null || docsAge > 30 ? "docs" : "general")}>
            <span className={`dot ${state.prefs.allowEdits ? "on" : ""}`} />
            {state.prefs.allowEdits ? "Editing on" : "Editing off"}
            {docsAge === null ? <span className="warn"> · No docs</span> : docsAge > 30 ? <span className="warn"> · Docs {docsAge} days old</span> : null}
          </button>
        )}
      </div>
    </aside>
  );
}

/** Whose files the app shows, among the agents that are on. The screen stays when the other agent has it too. */
function AgentPicker({ agent, on }: { agent: AgentId; on: AgentId[] }) {
  const route = useRoute();
  const { project, state } = useApp();
  // Turned on without being installed: the screens show what it would read.
  const missing = state?.agents.find((a) => a.id === agent && !a.found);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const pick = (a: AgentId) => {
    setOpen(false);
    const here = NAV.find((n) => n.screen === route.screen);
    go(here && !here.agents.includes(a) ? "instructions" : route.screen, { project: project ?? "", agent: agentParam(a) });
  };
  return (
    <div className="picker agent-picker" ref={box}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} title="Which agent's files to show">
        <span className="pk-name">{agentName(agent)}</span>
        {missing && <span className="pk-path">Not installed on this Mac</span>}
        <Icon.updown className="pk-chev" />
      </button>
      {open && (
        <div className="pop small" role="listbox">
          <div className="pop-list">
            {on.map((a) => (
              <button key={a} type="button" className="pop-item" aria-selected={a === agent} onClick={() => pick(a)}>
                <b>{agentName(a)}</b>
                {a === agent && <Icon.check className="sel" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectPicker() {
  const { project, projectRef, setProject } = useApp();
  const { data: projects } = useResource<ProjectRef[]>("/api/projects");
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const list = useMemo(() => {
    const all = projects ?? [];
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((p) => p.name.toLowerCase().includes(needle) || p.display.toLowerCase().includes(needle)) : all;
  }, [projects, q]);
  const options: (ProjectRef | null)[] = [null, ...list];
  // The keyboard cursor starts on the project that's open, not on the first row.
  useEffect(() => {
    if (open) setActive(Math.max(0, list.findIndex((p) => p.path === project) + 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = (p: ProjectRef | null) => {
    setProject(p?.path ?? null);
    setOpen(false);
    setQ("");
  };

  return (
    <div className="picker" ref={box}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open} title={projectRef?.display}>
        <span className="pk-name">{projectRef?.name ?? "No project"}</span>
        <span className="pk-path">{projectRef ? parentOf(projectRef.display) : "Everywhere"}</span>
        <Icon.updown className="pk-chev" />
      </button>
      {open && (
        <div className="pop" role="listbox">
          <label className="search">
            <Icon.search />
            <input
              autoFocus
              placeholder="Find a project"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, options.length - 1));
                else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
                else if (e.key === "Enter") pick(options[active] ?? null);
                else if (e.key === "Escape") setOpen(false);
                else return;
                e.preventDefault();
              }}
            />
          </label>
          <div className="pop-list">
            <button type="button" className="pop-item" data-active={active === 0} onClick={() => pick(null)} aria-selected={!project}>
              <b>No project</b>
              {!project && <Icon.check className="sel" />}
              <span>Only the files that apply everywhere.</span>
            </button>
            <div className="pop-h">{q ? `${list.length} matching` : "Recently used first"}</div>
            {list.map((p, i) => (
              <button key={p.path} type="button" className="pop-item" data-active={active === i + 1} onClick={() => pick(p)} aria-selected={p.path === project}>
                <b>{p.name}</b>
                {p.path === project ? <Icon.check className="sel" /> : <i>{p.lastActive ? when(p.lastActive) : ""}</i>}
                <span>{p.display}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function parentOf(display: string): string {
  const i = display.lastIndexOf("/");
  return i > 0 ? display.slice(0, i) : display;
}
