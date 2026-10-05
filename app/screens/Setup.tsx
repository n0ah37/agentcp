import { useCallback, useEffect, useState, type ReactNode } from "react";

import type { AgentId, DocsInfo, Preferences, ProjectRef, ScanState, SetupView } from "../../shared/types.ts";
import { ApiError, api } from "../api.ts";
import { DEMO } from "../demo.ts";
import { desktop } from "../desktop.ts";
import { go } from "../router.ts";
import { refreshAll, useResource } from "../store.ts";
import { Icon, Mark } from "../ui/icons.tsx";
import { Button, Switch, WindowButtons, plural, when } from "../ui/kit.tsx";
import { useApp } from "../shell/app-context.ts";

/**
 * First-run setup: one question per screen, and only the questions whose
 * answer changes what you see first. Claude Code and Codex are found on their
 * own and only the ones here are turned on, the home folder is searched for projects, and editing starts off unless
 * you turn it on. The look and the documentation live in Preferences. Answers go to the app's
 * preferences; no file Claude reads is touched.
 *
 * In the desktop app this runs in a small window of its own; in a browser it
 * is a card over the app.
 */

type StepId = "welcome" | "projects" | "editing" | "ready";

export function Setup({ standalone = false }: { standalone?: boolean }) {
  const { prefs, setPrefs, closeSetup, setProject, toast } = useApp();
  const { data: setup, reload } = useResource<SetupView>("/api/setup");
  const { scan, search } = useScan();
  const [at, setAt] = useState<StepId>("welcome");
  const [draft, setDraft] = useState<Partial<Preferences>>({});
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const merged = { ...prefs, ...draft } as Preferences;
  // The agents to show: what setup found here, until a switch on the first screen changes it.
  const agentsOn = draft.agents ?? setup?.agents.filter((a) => a.on).map((a) => a.id) ?? [];
  const setAgent = (id: AgentId, on: boolean) => setDraft((d) => ({ ...d, agents: on ? [...agentsOn, id] : agentsOn.filter((a) => a !== id) }));

  const steps: StepId[] = ["welcome", "projects", "editing", "ready"];
  const i = Math.max(steps.indexOf(at), 0);
  const back = () => setAt(steps[Math.max(i - 1, 0)]);

  const roots = chosenRoots(scan, prefs?.projectRoots ?? [], skipped);
  const next = async () => {
    if (at === "projects") {
      try {
        await setPrefs({ projectRoots: roots });
        refreshAll();
      } catch (e) {
        toast({ text: e instanceof ApiError ? e.message : String(e), tone: "bad" });
        return;
      }
    }
    setAt(steps[Math.min(i + 1, steps.length - 1)]);
  };

  const finish = async (open: string | null) => {
    try {
      // "Open without a project" clears the last one, or the app would reopen on it.
      await setPrefs({ ...draft, agents: agentsOn.length ? agentsOn : null, setupDone: new Date().toISOString(), lastProject: open });
      if (standalone && desktop) {
        await desktop.setupDone(open);
        return;
      }
      // The landing page's setup has no app window to open, so it starts again.
      if (standalone && DEMO) {
        setDraft({});
        setAt("welcome");
        return;
      }
      refreshAll();
      closeSetup();
      if (open) {
        setProject(open);
        go("instructions", { project: open });
      }
    } catch (e) {
      toast({ text: e instanceof ApiError ? e.message : String(e), tone: "bad" });
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !standalone && prefs?.setupDone) closeSetup();
      if (e.key !== "Enter" || e.metaKey || e.ctrlKey || at === "ready") return;
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "BUTTON") return;
      e.preventDefault();
      void next();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const body = !setup ? (
    <div className="skeleton"><i style={{ width: "60%" }} /><i style={{ width: "85%" }} /></div>
  ) : at === "welcome" ? (
    <Welcome setup={setup} on={agentsOn} onChange={setAgent} />
  ) : at === "projects" ? (
    <ProjectsStep
      setup={setup}
      scan={scan}
      search={search}
      earlier={prefs?.projectRoots ?? []}
      skipped={skipped}
      onToggle={(p, on) => setSkipped((s) => { const n = new Set(s); if (on) n.delete(p); else n.add(p); return n; })}
    />
  ) : at === "editing" ? (
    <EditingStep on={merged.allowEdits} onChange={(v) => setDraft((d) => ({ ...d, allowEdits: v }))} />
  ) : (
    <ReadyStep docs={setup.docs} onDocs={reload} onOpen={finish} />
  );

  const card = (
    <div className={`setup-card ${standalone ? "standalone" : ""}`} role="dialog" aria-modal={!standalone} aria-label="Set up AgentCP">
      <div className="setup-drag" aria-hidden="true" />
      {standalone && <WindowButtons zoom={false} />}
      <div className="setup-top">
        {i > 0 ? (
          <button type="button" className="btn round" onClick={back} aria-label="Back"><Icon.back /></button>
        ) : (
          <span className="round-space" />
        )}
        <div className="dots" aria-label={`Step ${i + 1} of ${steps.length}`}>
          {steps.map((s, n) => <i key={s} className={n === i ? "on" : n < i ? "done" : ""} />)}
        </div>
        {!standalone && prefs?.setupDone ? (
          <button type="button" className="btn round quiet" onClick={closeSetup} aria-label="Close setup"><Icon.close /></button>
        ) : (
          <span className="round-space" />
        )}
      </div>
      <div className="setup-body">
        <div className="setup-inner">{body}</div>
      </div>
      <footer className="setup-foot">
        {at === "ready" ? (
          <Button kind="block" onClick={() => finish(null)}>Open without a project</Button>
        ) : (
          <Button kind="block-primary" onClick={() => void next()} disabled={!setup}>{at === "welcome" ? "Get started" : "Continue"}</Button>
        )}
      </footer>
    </div>
  );
  return standalone ? card : <div className="setup">{card}</div>;
}

/** The folders to keep: everything the search found that wasn't unticked, and earlier choices it didn't find. */
function chosenRoots(scan: ScanState | null, earlier: string[], skipped: Set<string>): string[] {
  const found = (scan?.folders ?? []).map((f) => f.display);
  return [...new Set([...found, ...earlier])].filter((r) => !skipped.has(r));
}

/** Start the home-folder search once, and follow it while it runs. */
function useScan() {
  const [scan, setScan] = useState<ScanState | null>(null);
  const search = useCallback(async (folder?: string) => {
    try {
      setScan(await api.post<ScanState>("/api/scan", folder ? { folder } : {}));
    } catch (e) {
      setScan((s) => (s ? { ...s, error: e instanceof ApiError ? e.message : String(e) } : s));
    }
  }, []);
  useEffect(() => {
    let alive = true;
    void api.get<ScanState>("/api/scan").then((s) => {
      if (!alive) return;
      if (!s.startedAt && !s.running) void search();
      else setScan(s);
    });
    return () => {
      alive = false;
    };
  }, [search]);
  useEffect(() => {
    if (!scan?.running) return;
    const id = setTimeout(() => void api.get<ScanState>("/api/scan").then(setScan), 250);
    return () => clearTimeout(id);
  }, [scan]);
  return { scan, search };
}

function Head({ title, children }: { title: string; children: ReactNode }) {
  return (
    <header className="setup-head">
      <h1>{title}</h1>
      <p>{children}</p>
    </header>
  );
}

function Row({ tone = "ok", title, children, right }: { tone?: "ok" | "miss" | "off"; title: ReactNode; children?: ReactNode; right?: ReactNode }) {
  return (
    <div className={`srow ${tone}`}>
      <span className="ic" aria-hidden="true">{tone === "ok" ? <Icon.check /> : tone === "off" ? <Icon.close /> : "!"}</span>
      <div className="txt">
        <b>{title}</b>
        {children && <p>{children}</p>}
      </div>
      {right}
    </div>
  );
}

const INSTALL: Record<AgentId, { url: string; site: string }> = {
  claude: { url: "https://code.claude.com/docs/en/quickstart", site: "code.claude.com" },
  codex: { url: "https://developers.openai.com/codex/cli", site: "developers.openai.com" },
  opencode: { url: "https://opencode.ai/v2/docs/cli/", site: "opencode.ai" },
};

/** The agents found here, each with a switch: only the ones installed or used start on. */
function Welcome({ setup, on, onChange }: { setup: SetupView; on: AgentId[]; onChange: (id: AgentId, on: boolean) => void }) {
  const none = !setup.agents.some((a) => a.found || a.used);
  return (
    <>
      <Mark size={64} className="setup-mark" />
      <Head title="Welcome to AgentCP">
        See every file your coding agents read in your projects, such as instructions, rules, memory, skills and settings, in the order they read them and checked against their documentation.
      </Head>
      <div className="srows">
        {setup.agents.map((a) => (
          <Row
            key={a.id}
            tone={a.found || a.used ? "ok" : none ? "miss" : "off"}
            title={a.found ? `${a.name} ${a.version ?? ""}`.trim() : `${a.name} isn't installed`}
            right={<Switch label={`Show ${a.name}`} checked={on.includes(a.id)} disabled={on.includes(a.id) && on.length === 1} onChange={(v) => onChange(a.id, v)} />}
          >
            {a.found ? (
              a.path
            ) : a.used ? (
              `Its folder, ${a.folder}, is here, so its files can still be shown.`
            ) : none ? (
              <>Install it from <a href={INSTALL[a.id].url} target="_blank" rel="noreferrer">{INSTALL[a.id].site}</a>, then run setup again from the app menu.</>
            ) : (
              "Turn it on here or in Preferences if you install it later."
            )}
          </Row>
        ))}
      </div>
      <p className="setup-fine">{none ? "You can look around without any of them." : "The app shows only the agents that are on. You can change this in Preferences."}</p>
    </>
  );
}

function ProjectsStep(props: {
  setup: SetupView;
  scan: ScanState | null;
  search: (folder?: string) => Promise<void>;
  earlier: string[];
  skipped: Set<string>;
  onToggle: (display: string, on: boolean) => void;
}) {
  const { setup, scan, search, earlier, skipped, onToggle } = props;
  const [typed, setTyped] = useState("");
  const running = !scan || scan.running;
  const found = scan?.folders ?? [];
  const extra = earlier.filter((r) => !found.some((f) => f.display === r));
  const total = found.reduce((n, f) => n + f.projects, 0);

  const add = async () => {
    const p = desktop ? await desktop.pickFolder("Choose a folder you keep code in") : typed.trim();
    if (!p) return;
    setTyped("");
    await search(p);
  };

  return (
    <>
      <Head title="Find your projects">
        The app searches your home folder for git repositories and folders with a CLAUDE.md or AGENTS.md. Untick any folder you don't want in the project list.
      </Head>

      <div className="scan-status" aria-live="polite">
        {running ? (
          <>
            <span className="spin" aria-hidden="true" />
            <span className="grow">Searching{scan?.current ? <> <code>{scan.current}</code></> : "…"}</span>
            <span className="num faint">{plural(scan?.checked ?? 0, "folder")}</span>
          </>
        ) : scan?.error ? (
          <span className="grow bad">{scan.error}</span>
        ) : (
          <>
            <Icon.check className="ok" />
            <span className="grow">{total ? `Found ${plural(total, "project")} in ${plural(found.length, "folder")}.` : "No projects in your home folder yet. Add the folder you keep code in."}</span>
            <button type="button" className="linkbtn" onClick={() => void search()}>Search again</button>
          </>
        )}
      </div>

      {(found.length > 0 || extra.length > 0) && (
        <div className="scan-list">
          {found.map((f) => (
            <label key={f.path} className="scan-row">
              <input type="checkbox" checked={!skipped.has(f.display)} onChange={(e) => onToggle(f.display, e.target.checked)} />
              <span className="txt">
                <b>{f.display}</b>
                <span>{f.names.join(", ")}{f.projects > f.names.length ? `, and ${f.projects - f.names.length} more` : ""}</span>
              </span>
              <span className="num">{plural(f.projects, "project")}</span>
            </label>
          ))}
          {extra.map((r) => (
            <label key={r} className="scan-row">
              <input type="checkbox" checked={!skipped.has(r)} onChange={(e) => onToggle(r, e.target.checked)} />
              <span className="txt">
                <b>{r}</b>
                <span>Chosen before</span>
              </span>
              <span />
            </label>
          ))}
        </div>
      )}

      <div className="ask-first">
        <p>macOS asks before an app looks in these folders, so they're searched only when you ask.</p>
        <div className="ask-row">
          {(scan?.askFirst ?? []).map((a) => (
            <span key={a.name} className="ask">
              {a.state === "not-asked" ? (
                <Button small onClick={() => void search(a.name)} disabled={running}>Search {a.name}</Button>
              ) : (
                <span className={`ask-done ${a.state}`}>{a.name}: {a.state === "searched" ? "searched" : a.state === "missing" ? "not on this Mac" : "macOS didn't allow it"}</span>
              )}
            </span>
          ))}
        </div>
      </div>

      <div className="add-row">
        {!desktop && <input className="field" placeholder="/Volumes/Code" value={typed} onChange={(e) => setTyped(e.target.value)} />}
        <Button small onClick={() => void add()} disabled={running}><Icon.plus />{desktop ? "Add a folder…" : "Add"}</Button>
        {setup.seen > 0 && <span className="faint">{setup.seen === 1 ? "The folder Claude Code has worked in is in the list too." : `The ${plural(setup.seen, "folder")} Claude Code has worked in are in the list too.`}</span>}
      </div>
    </>
  );
}

function EditingStep({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <>
      <Head title="Allow editing?">You can start by only looking and turn editing on later, from any file or in Preferences.</Head>
      <div className="choices">
        <button type="button" className="choice" aria-pressed={!on} onClick={() => onChange(false)}>
          <Icon.read className="ic" aria-hidden="true" />
          <b>Look only</b>
          <span>Read every file and suggestion. Nothing on disk changes.</span>
          <span className="mark">{!on && <Icon.check />}</span>
        </button>
        <button type="button" className="choice" aria-pressed={on} onClick={() => onChange(true)}>
          <Icon.edit className="ic" aria-hidden="true" />
          <b>Allow editing</b>
          <span>Edit, create and fix files. You see each change before it's saved, and History keeps the earlier version.</span>
          <span className="mark">{on && <Icon.check />}</span>
        </button>
      </div>
    </>
  );
}

function ReadyStep({ docs, onDocs, onOpen }: { docs: DocsInfo; onDocs: () => void; onOpen: (p: string | null) => void }) {
  const { toast } = useApp();
  const { data: projects } = useResource<ProjectRef[]>("/api/projects");
  const [busy, setBusy] = useState(false);
  const recent = (projects ?? []).filter((p) => p.exists).slice(0, 6);
  const download = async () => {
    setBusy(true);
    try {
      await api.post<DocsInfo>("/api/docs/update", {});
      onDocs();
    } catch (e) {
      toast({ text: e instanceof ApiError ? e.message : String(e), tone: "bad" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Head title="Open a project">Pick one to start with. You can switch projects any time from the top of the sidebar.</Head>
      {docs.where === "none" && (
        <div className="srows" style={{ marginBottom: 12 }}>
          <Row tone="miss" title="The checks need Claude Code's documentation" right={<Button small onClick={() => void download()} disabled={busy}>{busy ? "Downloading…" : "Download"}</Button>}>
            About 8 MB from code.claude.com.
          </Row>
        </div>
      )}
      {!projects ? (
        <div className="skeleton"><i style={{ width: "70%" }} /><i style={{ width: "55%" }} /></div>
      ) : recent.length ? (
        <div className="scan-list">
          {recent.map((p) => (
            <button key={p.path} type="button" className="scan-row pick" onClick={() => onOpen(p.path)}>
              <span className="txt">
                <b>{p.name}</b>
                <span>{p.display}</span>
              </span>
              <span className="num">{p.lastActive ? when(p.lastActive) : ""}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="setup-fine">No projects yet. Open without one to see the files that apply everywhere, then add folders in Preferences.</p>
      )}
    </>
  );
}
