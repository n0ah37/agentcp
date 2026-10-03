import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import type { AgentId, AppState, DocRef, Preferences, ProjectRef } from "../../shared/types.ts";
import { AppCtx, type Ctx, type FileMenuOptions, type MenuFile, type SaveRequest, type Toast } from "./app-context.ts";
import { ApiError, api } from "../api.ts";
import { demoSystem } from "../demo.ts";
import { pickAgent } from "../agent.ts";
import { useParams } from "../router.ts";
import { refreshAll, useResource } from "../store.ts";
import { desktop } from "../desktop.ts";
import { DocsSheet } from "./DocsSheet.tsx";
import { SaveSheet } from "./SaveSheet.tsx";
import { PromptSheet } from "./PromptSheet.tsx";
import { RenameSheet } from "./RenameSheet.tsx";
import { FIXED_NAMES } from "../../shared/names.ts";
import { popMenu } from "./menu.tsx";

export function AppProvider({ children }: { children: ReactNode }) {
  const { data: state, reload } = useResource<AppState>("/api/state");
  const [params, setParams] = useParams();
  const [doc, setDoc] = useState<DocRef | null>(null);
  const [pending, setPending] = useState<SaveRequest | null>(null);
  const [toastMsg, setToast] = useState<Toast | null>(null);
  const [prefsOpen, setPrefsOpen] = useState<string | null>(null);
  const [setupAsked, setSetupAsked] = useState(false);
  const [asking, setAsking] = useState<{ path: string; name: string; agent: AgentId } | null>(null);
  const [renaming, setRenaming] = useState<MenuFile | null>(null);

  const prefs = state?.prefs;
  // A choice made here counts at once, before the saved preference comes back.
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  // The project comes from the URL; with none there, the one just chosen, then the last one used.
  const project = params.has("project") ? params.get("project") || null : chosen !== undefined ? chosen : (prefs?.lastProject ?? null);
  const { data: projects } = useResource<ProjectRef[]>("/api/projects");
  const projectRef = useMemo(() => {
    if (!project) return null;
    return projects?.find((p) => p.path === project) ?? { path: project, display: project, name: project.split("/").pop() ?? project, group: "", lastActive: null, isWorktree: false, exists: true };
  }, [project, projects]);

  const setPrefs = useCallback(
    async (p: Partial<Preferences>) => {
      await api.post("/api/prefs", p);
      await reload();
    },
    [reload],
  );

  const setProject = useCallback(
    (p: string | null) => {
      setChosen(p);
      setParams({ project: p ?? "", file: null, key: null });
      void api.post("/api/prefs", { lastProject: p }).then(reload);
    },
    [setParams, reload],
  );

  const toast = useCallback((t: Toast) => setToast(t), []);
  useEffect(() => {
    if (!toastMsg) return;
    const id = setTimeout(() => setToast(null), toastMsg.tone === "bad" ? 9000 : 5000);
    return () => clearTimeout(id);
  }, [toastMsg]);

  // Appearance follows the preference, or the system when set to follow it. The
  // desktop app also sets the window's own theme, so its sidebar material matches.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const a = prefs?.appearance ?? "system";
    void desktop?.setTheme(a);
    const apply = () => {
      document.documentElement.dataset.theme = a === "system" ? demoSystem(mq.matches ? "dark" : "light") : a;
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [prefs?.appearance]);

  const askAI = useCallback(
    (file: { path: string; name: string }, agent?: AgentId) =>
      setAsking({ ...file, agent: agent ?? pickAgent(params.get("agent"), state?.agents.filter((a) => a.on).map((a) => a.id) ?? ["claude"]) }),
    [params, state],
  );

  const fileMenu = useCallback(
    async (at: { clientX: number; clientY: number }, f: MenuFile, o: FileMenuOptions = {}) => {
      const canDelete = !!o.canDelete && f.exists && f.editable;
      const id = await popMenu(
        [
          ...(desktop ? [{ id: "reveal", label: "Show in Finder", enabled: f.exists }, { id: "open", label: "Open in Default App", enabled: f.exists }] : []),
          { id: "copy", label: "Copy Path" },
          { separator: true as const },
          { id: "ai", label: "Write with AI…" },
          ...(o.onRevert ? [{ id: "revert", label: "Revert Changes" }] : []),
          ...(o.canDelete
            ? [{ separator: true as const }, { id: "rename", label: "Rename…", enabled: canDelete && !FIXED_NAMES.test(f.name) }, { id: "delete", label: "Delete…", enabled: canDelete }]
            : []),
        ],
        { x: at.clientX, y: at.clientY },
      );
      if (id === "reveal") void desktop?.reveal(f.path);
      else if (id === "open") void desktop?.openFile(f.path);
      else if (id === "copy") {
        await (desktop ? desktop.copy(f.path) : navigator.clipboard.writeText(f.path));
        toast({ text: `Copied ${f.display}.` });
      } else if (id === "ai") askAI(f, o.agent);
      else if (id === "revert") o.onRevert?.();
      else if (id === "rename") setRenaming(f);
      else if (id === "delete") setPending({ path: f.path, content: null, baseHash: f.hash, project, title: `Delete ${f.name}?`, onSaved: () => o.onDeleted?.() });
    },
    [askAI, project, toast],
  );

  const value: Ctx = {
    state,
    prefs,
    setPrefs,
    project,
    projectRef,
    setProject,
    // Both agents' documentation is downloaded and opens beside the work; anything else opens on its own site.
    openDoc: (d: DocRef) => (d.slug === "external" ? void window.open(d.url, "_blank", "noopener") : setDoc(d)),
    save: setPending,
    toast,
    askAI,
    fileMenu: (at, f, o) => void fileMenu(at, f, o),
    openPrefs: (section = "general") => setPrefsOpen(section),
    prefsOpen,
    closePrefs: () => setPrefsOpen(null),
    // The desktop app runs setup in a window of its own, never over the app.
    setupOpen: !desktop && (setupAsked || (!!prefs && !prefs.setupDone)),
    openSetup: () => (desktop ? void desktop.openSetup() : setSetupAsked(true)),
    closeSetup: () => setSetupAsked(false),
  };

  return (
    <AppCtx.Provider value={value}>
      {children}
      {doc && <DocsSheet doc={doc} onClose={() => setDoc(null)} />}
      {asking && (
        <PromptSheet
          path={asking.path}
          name={asking.name}
          project={project}
          agent={asking.agent}
          onClose={() => setAsking(null)}
          onCopied={(agent) => {
            setAsking(null);
            toast({ text: `Copied. Paste it into ${agent}.` });
          }}
        />
      )}
      {renaming && (
        <RenameSheet
          file={renaming}
          project={project}
          editsOn={!!prefs?.allowEdits}
          onTurnOnEdits={() => setPrefs({ allowEdits: true })}
          onClose={() => setRenaming(null)}
          onDone={(r) => {
            setRenaming(null);
            refreshAll();
            // The open file follows its new name.
            if (params.get("file") === r.from) setParams({ file: r.to });
            toast({ text: `Renamed to ${r.to.split("/").pop()}. History can undo it.` });
          }}
          onError={(e) => toast({ text: e instanceof ApiError ? e.message : String(e), tone: "bad" })}
        />
      )}
      {pending && (
        <SaveSheet
          // A save can open the next one (sharing with Codex is two); each gets a fresh sheet and plan.
          key={`${pending.path}\u0000${pending.title ?? ""}`}
          request={pending}
          editsOn={!!prefs?.allowEdits}
          onTurnOnEdits={() => setPrefs({ allowEdits: true })}
          onClose={() => setPending(null)}
          onDone={(r, name) => {
            setPending(null);
            pending.onSaved?.(r);
            refreshAll();
            toast({ text: pending.content === null ? `Deleted ${name}. History can put it back.` : pending.baseHash === null ? `Created ${name}. History can remove it.` : `Saved ${name}. History keeps the earlier version.` });
          }}
          onError={(e) => {
            // The landing page's demo can't save. That's not a failure: it says so and closes the sheet.
            const demo = e instanceof ApiError && e.code === "demo";
            if (demo) setPending(null);
            toast({ text: e instanceof ApiError ? e.message : String(e), tone: demo ? undefined : "bad" });
          }}
        />
      )}
      {toastMsg && (
        <div className={`toast ${toastMsg.tone ?? ""}`} role="status">
          <span>{toastMsg.text}</span>
          {toastMsg.action && (
            <button type="button" className="linkbtn" onClick={() => (toastMsg.action!.run(), setToast(null))}>
              {toastMsg.action.label}
            </button>
          )}
        </div>
      )}
    </AppCtx.Provider>
  );
}
