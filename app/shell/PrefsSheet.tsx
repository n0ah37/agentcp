import { useEffect, useRef, useState, type ReactNode } from "react";

import { COPYRIGHT, LINKS } from "../../shared/links.ts";
import type { AgentId, AgentStatus, DocsInfo, UpdateState } from "../../shared/types.ts";
import { ApiError, api } from "../api.ts";
import { desktop } from "../desktop.ts";
import { refreshAll, useResource } from "../store.ts";
import { Icon, Mark } from "../ui/icons.tsx";
import { Button, Switch, plural, when } from "../ui/kit.tsx";
import { useApp } from "./app-context.ts";

const SECTIONS: { id: string; label: string; icon: keyof typeof Icon; title: string; lede: string }[] = [
  { id: "general", label: "General", icon: "prefs", title: "General", lede: "Editing, tips and how the app looks." },
  { id: "agents", label: "Agents", icon: "chip", title: "Agents", lede: "Which agents the app shows. An agent that's off leaves the sidebar, Sessions, Usage and Search." },
  { id: "projects", label: "Projects", icon: "folder", title: "Projects", lede: "Where the project switcher finds your projects." },
  { id: "sessions", label: "Sessions", icon: "sessions", title: "Sessions", lede: "The agent sessions on this Mac." },
  { id: "docs", label: "Documentation", icon: "book", title: "Documentation", lede: "The copy of each agent's documentation every check quotes." },
  { id: "about", label: "About", icon: "layers", title: "About AgentCP", lede: "" },
];

/** The app's own preferences, opened with ⌘, like any Mac app. */
export function PrefsSheet({ section, onClose }: { section: string; onClose: () => void }) {
  const { state, prefs } = useApp();
  const [at, setAt] = useState(SECTIONS.some((s) => s.id === section) ? section : "general");
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (!prefs || !state) return null;
  const s = SECTIONS.find((x) => x.id === at)!;
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet prefs-sheet" role="dialog" aria-modal="true" aria-label="Preferences">
        <nav className="prefs-nav" aria-label="Preferences sections">
          <h2>Preferences</h2>
          {SECTIONS.map((x) => {
            const I = Icon[x.icon];
            return (
              <button key={x.id} type="button" aria-pressed={at === x.id} onClick={() => setAt(x.id)}>
                <I />
                {x.label}
              </button>
            );
          })}
          <p className="ver">Version {state.version}</p>
        </nav>
        <div className="prefs-main">
          <div className="prefs-top">
            <div>
              <h3>{s.title}</h3>
              {s.lede && <p>{s.lede}</p>}
            </div>
            <button type="button" className="esc" onClick={onClose} aria-label="Close preferences">
              <span><Icon.close /></span>
              ESC
            </button>
          </div>
          <div className="prefs">
            {at === "general" && <General />}
            {at === "agents" && <Agents />}
            {at === "projects" && <Projects />}
            {at === "sessions" && <SessionsPrefs />}
            {at === "docs" && <Docs />}
            {at === "about" && <About />}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ title, note, children }: { title: string; note?: ReactNode; children?: ReactNode }) {
  return (
    <div className="prefrow">
      <div className="grow">
        <b>{title}</b>
        {note && <p>{note}</p>}
      </div>
      {children}
    </div>
  );
}

function General() {
  const { prefs, setPrefs, openSetup, closePrefs } = useApp();
  if (!prefs) return null;
  return (
    <>
      <h4>Editing</h4>
      <Row title="Allow editing" note="Lets the app save, create and delete instruction, memory and settings files. Every change is shown before it's made, and the earlier version is kept in History.">
        <Switch label="Allow editing" checked={prefs.allowEdits} onChange={(v) => setPrefs({ allowEdits: v })} />
      </Row>
      <h4>Tips</h4>
      <Row title="Show tips" note="A small card in the corner with one fact at a time from Claude Code's documentation, such as when an edit to CLAUDE.md reaches a running session.">
        <Switch label="Show tips" checked={prefs.showTips} onChange={(v) => setPrefs({ showTips: v })} />
      </Row>
      <h4>Appearance</h4>
      <Row title="Theme">
        <div className="seg" role="group" aria-label="Theme">
          {(["system", "light", "dark"] as const).map((a) => (
            <button key={a} type="button" aria-pressed={prefs.appearance === a} onClick={() => setPrefs({ appearance: a })}>
              {a === "system" ? "Match the system" : a === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
      </Row>
      <h4>Setup</h4>
      <Row title="Run setup again" note="Search your home folder for projects again, and choose whether the app can edit files.">
        <Button onClick={() => { closePrefs(); openSetup(); }}>Run setup…</Button>
      </Row>
    </>
  );
}

/** One switch per agent. The last one that's on stays on: with no agent there's nothing to show. */
function Agents() {
  const { state, setPrefs, toast } = useApp();
  if (!state) return null;
  const on = state.agents.filter((a) => a.on).map((a) => a.id);
  const set = (id: AgentId, v: boolean) =>
    void setPrefs({ agents: v ? [...on, id] : on.filter((x) => x !== id) })
      // Sessions, Usage and Search change with it.
      .then(refreshAll)
      .catch((e: unknown) => toast({ text: e instanceof ApiError ? e.message : String(e), tone: "bad" }));
  return (
    <>
      {state.agents.map((a) => (
        <Row key={a.id} title={a.name} note={agentNote(a, a.on && on.length === 1)}>
          <Switch label={`Show ${a.name}`} checked={a.on} disabled={a.on && on.length === 1} onChange={(v) => set(a.id, v)} />
        </Row>
      ))}
    </>
  );
}

function agentNote(a: AgentStatus, last: boolean): string {
  const where = a.found ? `Version ${a.version ?? "unknown"}, at ${a.path}.` : a.used ? `Not installed. Its folder, ${a.folder}, is still here.` : "Not installed on this Mac.";
  return last ? `${where} At least one agent stays on.` : where;
}

function Projects() {
  const { prefs, setPrefs } = useApp();
  if (!prefs) return null;
  return (
    <>
      <h4>Project folders</h4>
      <FolderList
        note="Git repositories and folders with a CLAUDE.md or AGENTS.md in these folders, up to three levels down, are listed as projects, next to every folder Claude Code has worked in. Setup's search fills this in."
        folders={prefs.projectRoots}
        add="Add a folder…"
        empty="No folders yet. Run setup again to search your home folder, or add one."
        onChange={(projectRoots) => setPrefs({ projectRoots })}
      />
      <h4>Leave out</h4>
      <FolderList
        note="Projects in these folders aren't searched or listed, such as an archive or vendored code."
        folders={prefs.skipFolders}
        add="Leave out a folder…"
        empty="Nothing left out."
        onChange={(skipFolders) => setPrefs({ skipFolders })}
      />
      <h4>What's listed</h4>
      <Row title="Show worktrees" note="Lists git worktrees as projects of their own. They share their repository's memory.">
        <Switch label="Show worktrees" checked={prefs.showWorktrees} onChange={(v) => setPrefs({ showWorktrees: v })} />
      </Row>
    </>
  );
}

function FolderList({ note, folders, add, empty, onChange }: { note: string; folders: string[]; add: string; empty: string; onChange: (f: string[]) => void }) {
  const { state } = useApp();
  const [typed, setTyped] = useState("");
  const tilde = (p: string) => (state && p.startsWith(state.home + "/") ? "~" + p.slice(state.home.length) : p);
  const put = (p: string) => {
    const d = tilde(p.trim());
    if (d && !folders.includes(d)) onChange([...folders, d]);
  };
  const pick = async () => {
    const p = await desktop?.pickFolder(add.replace("…", ""));
    if (p) put(p);
  };
  return (
    <div className="prefrow" style={{ alignItems: "flex-start" }}>
      <div className="grow">
        <p style={{ marginTop: 0 }}>{note}</p>
        <ul className="folders">
          {folders.map((f) => (
            <li key={f}>
              <Icon.folder />
              <code>{f}</code>
              <button type="button" className="linkbtn" onClick={() => onChange(folders.filter((x) => x !== f))} aria-label={`Remove ${f}`}>Remove</button>
            </li>
          ))}
          {!folders.length && <li className="none">{empty}</li>}
        </ul>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          {desktop ? (
            <Button small onClick={() => void pick()}><Icon.plus />{add}</Button>
          ) : (
            <>
              <input className="field" style={{ flex: 1 }} placeholder="~/Code" value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (put(typed), setTyped(""))} />
              <Button small onClick={() => (put(typed), setTyped(""))}><Icon.plus />Add</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SessionsPrefs() {
  const { prefs, setPrefs } = useApp();
  if (!prefs) return null;
  return (
    <Row title="Show sessions" note="Adds Sessions to the sidebar: every session of the agents that are on, read from their own session files. Nothing is copied or kept.">
      <Switch label="Show sessions" checked={prefs.sessions} onChange={(v) => setPrefs({ sessions: v })} />
    </Row>
  );
}

function Docs() {
  const { state, toast } = useApp();
  const [updating, setUpdating] = useState(false);
  if (!state) return null;
  const update = async () => {
    setUpdating(true);
    try {
      const info = await api.post<DocsInfo>("/api/docs/update", {});
      refreshAll();
      toast({ text: `Documentation updated: ${info.pages} pages. Every file is checked against it.` });
    } catch (e) {
      toast({ text: e instanceof ApiError ? e.message : String(e), tone: "bad" });
    } finally {
      setUpdating(false);
    }
  };
  const d = state.docs;
  const on = state.agents.filter((a) => a.on).map((a) => a.id);
  const day = (iso: string) => new Date(iso + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
  const from = d.where === "shipped" ? "The copy this version of the app came with." : "Downloaded on this Mac, into ~/.agentcp/docs.";
  // One download fetches every agent's documentation, so the button sits on the first row shown.
  const button = <Button onClick={update} disabled={updating}>{updating ? "Downloading…" : "Update now"}</Button>;
  return (
    <>
      {on.includes("claude") && (
        <>
          <h4>Claude Code documentation</h4>
          <Row
            title={d.capturedAt ? `${plural(d.pages, "page")}, captured ${day(d.capturedAt)}` : "Not downloaded yet"}
            note={d.capturedAt ? <>{d.ageDays ? `${plural(d.ageDays, "day")} old. ` : ""}{from} Every check and explanation quotes it.</> : "About 8 MB from code.claude.com. The checks need it."}
          >
            {button}
          </Row>
        </>
      )}
      {on.includes("codex") && (
        <>
          <h4>Codex documentation</h4>
          <Row
            title={d.codex.capturedAt ? `${plural(d.codex.pages, "page")}, captured ${day(d.codex.capturedAt)}` : "Not downloaded yet"}
            note={d.codex.capturedAt ? <>{d.codex.ageDays ? `${plural(d.codex.ageDays, "day")} old. ` : ""}{from} Every Codex rule quotes it.</> : "From developers.openai.com. The Codex rules need it."}
          >
            {!on.includes("claude") && button}
          </Row>
        </>
      )}
      {on.includes("opencode") && (
        <>
          <h4>OpenCode documentation</h4>
          <Row
            title={d.opencode.capturedAt ? `${plural(d.opencode.pages, "page")}, captured ${day(d.opencode.capturedAt)}` : "Not downloaded yet"}
            note={d.opencode.capturedAt ? <>{d.opencode.ageDays ? `${plural(d.opencode.ageDays, "day")} old. ` : ""}{from} Every OpenCode rule quotes it, and Settings lists its keys from the schema it links to.</> : "From opencode.ai. The OpenCode rules and its settings list need it."}
          >
            {!on.includes("claude") && !on.includes("codex") && button}
          </Row>
        </>
      )}
      <Row title="When a check's source changes" note="Each check names the sentence of the documentation it relies on. If an update drops that sentence, the check still runs and says the docs no longer put it that way." />
    </>
  );
}

type Package = { name: string; version: string; license: string; url: string | null; text: string | null };

/** What a released Mac app says about itself: version, license, links, updates, privacy, and the software it's built on. */
function About() {
  const { state, prefs, setPrefs } = useApp();
  const [reading, setReading] = useState<"license" | "credits" | null>(null);
  const { data: packages } = useResource<Package[]>("/api/licenses");
  const { data: license } = useResource<{ text: string }>("/api/license");
  if (!state || !prefs) return null;
  const others = (packages ?? []).filter((p) => !["electron", "react", "@codemirror/view"].includes(p.name)).length;
  if (reading) {
    return (
      <>
        <button type="button" className="linkbtn about-back" onClick={() => setReading(null)}>
          <Icon.back />About AgentCP
        </button>
        {reading === "license" ? (
          <>
            <h4>MIT License</h4>
            <pre className="license-text">{license?.text ?? ""}</pre>
          </>
        ) : (
          <>
            <h4>{plural(packages?.length ?? 0, "open-source package")} built into AgentCP</h4>
            <div className="credits">
              {(packages ?? []).map((p) => (
                <details key={`${p.name}@${p.version}`}>
                  <summary>
                    <b>{p.name}</b>
                    <span>{p.version}</span>
                    <span className="lic">{p.license}</span>
                  </summary>
                  {p.text ? <pre className="license-text">{p.text}</pre> : <p className="faint">{p.license}. The package has no license file of its own.</p>}
                </details>
              ))}
            </div>
          </>
        )}
      </>
    );
  }
  return (
    <>
      <div className="about-head">
        <Mark size={64} />
        <div>
          <b>AgentCP</b>
          <p>Version {state.version}{state.build ? ` (${state.build})` : ""}</p>
          <p>{COPYRIGHT} Released under the MIT License.</p>
        </div>
      </div>
      <div className="about-links">
        <a className="btn small" href={LINKS.site} target="_blank" rel="noreferrer">Website</a>
        <a className="btn small" href={LINKS.repo} target="_blank" rel="noreferrer">Source on GitHub</a>
        <a className="btn small" href={LINKS.releases} target="_blank" rel="noreferrer">What's new</a>
        <a className="btn small" href={LINKS.issues} target="_blank" rel="noreferrer">Report a problem</a>
      </div>

      <h4>Updates</h4>
      <Updates on={prefs.checkUpdates} onChange={(v) => void setPrefs({ checkUpdates: v }).then(() => desktop?.updates.schedule(v))} />

      <h4>Privacy</h4>
      <Row title="Your files stay on your Mac" note="AgentCP has no account, analytics or crash reporting, and sends nothing about you or your files anywhere. It goes online only to download documentation when you ask, and to check GitHub for a new version." />
      <Row title="What the app keeps" note="Preferences, the history of every save, and the earlier versions History restores, in ~/.agentcp. To remove AgentCP, quit it, move it to the Trash, and delete that folder.">
        {desktop && <Button small onClick={() => void desktop?.reveal(state.appDir)}>Show in Finder</Button>}
      </Row>

      <h4>Open source</h4>
      <Row title="MIT License" note="You can use, change and share AgentCP, including in other software, as long as the license and copyright notice go with it.">
        <Button small onClick={() => setReading("license")}>Read the license</Button>
      </Row>
      <Row title="Built with open-source software" note={packages?.length ? `Electron, React, CodeMirror and ${others} more packages.` : "Electron, React and CodeMirror."}>
        <Button small onClick={() => setReading("credits")} disabled={!packages?.length}>See all</Button>
      </Row>

    </>
  );
}

/** The updater's state in words, with the one action that fits it. */
function Updates({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  const [u, setU] = useState<UpdateState | null>(null);
  useEffect(() => {
    if (!desktop) return;
    void desktop.updates.state().then(setU);
    return desktop.updates.onChange(setU);
  }, []);
  const status = !desktop
    ? { title: "Updates come with the Mac app", note: "Download the newest version from the website." }
    : !u || u.status === "idle"
      ? { title: "Not checked yet", note: "" }
      : u.status === "unavailable"
        ? { title: "This copy doesn't update itself", note: u.message ?? "" }
        : u.status === "checking"
          ? { title: "Checking for a new version…", note: "" }
          : u.status === "current"
            ? { title: "AgentCP is up to date", note: u.checkedAt ? `Checked ${when(u.checkedAt)}.` : "" }
            : u.status === "downloading"
              ? { title: `Downloading version ${u.version}…`, note: "It installs the next time you quit AgentCP." }
              : u.status === "ready"
                ? { title: `Version ${u.version} is ready`, note: "Restart AgentCP to finish updating." }
                : { title: "Couldn't check for updates", note: `${u.message ?? ""} Try again later, or download the newest version from the website.`.trim() };
  return (
    <>
      {desktop && (
        <Row title="Check for updates automatically" note="Once a day, AgentCP looks for a new version on GitHub, downloads it, and installs it the next time you quit.">
          <Switch label="Check for updates automatically" checked={on} onChange={onChange} />
        </Row>
      )}
      <Row title={status.title} note={status.note || undefined}>
        {desktop && u?.status === "ready" ? (
          <Button small kind="primary" onClick={() => void desktop?.updates.install()}>Restart to update</Button>
        ) : desktop ? (
          <Button small onClick={() => void desktop?.updates.check().then(setU)} disabled={u?.status === "checking" || u?.status === "downloading" || u?.status === "unavailable"}>Check now</Button>
        ) : (
          <a className="btn small" href={LINKS.site} target="_blank" rel="noreferrer">Website</a>
        )}
      </Row>
    </>
  );
}
