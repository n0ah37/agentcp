import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import "./styles/app.css";
import { agentParam, useAgent } from "./agent.ts";
import { DEMO, demoEmbedded, demoPane } from "./demo.ts";
import { desktop, windowKind } from "./desktop.ts";
import { go, useRoute, type Screen as ScreenName } from "./router.ts";
import { useApp } from "./shell/app-context.ts";
import { AppProvider } from "./shell/context.tsx";
import { Palette } from "./shell/Palette.tsx";
import { PrefsSheet } from "./shell/PrefsSheet.tsx";
import { NAV, Sidebar } from "./shell/Sidebar.tsx";
import { TipCard } from "./shell/TipCard.tsx";
import { MenuHost } from "./shell/menu.tsx";
import { refreshAll, startSync } from "./store.ts";
import { Definitions } from "./screens/Definitions.tsx";
import { History } from "./screens/History.tsx";
import { Instructions } from "./screens/Instructions.tsx";
import { Memory } from "./screens/Memory.tsx";
import { Sessions } from "./screens/Sessions.tsx";
import { Usage } from "./screens/Usage.tsx";
import { Hooks } from "./screens/Hooks.tsx";
import { Settings } from "./screens/Settings.tsx";
import { Setup } from "./screens/Setup.tsx";
import { CodexRules } from "./screens/Codex.tsx";
import { Mcp } from "./screens/Mcp.tsx";
import { Plugins } from "./screens/Plugins.tsx";

// Inside the desktop app the window has no title bar: the sidebar and headers
// become drag regions, leave room for the window buttons, and let the window's
// own sidebar material show through.
if (desktop) document.documentElement.classList.add("desktop");
// The desktop app's setup window is its own small, opaque window.
if (windowKind === "setup") document.documentElement.classList.add("setup-window");
// The landing page's demo: the app in a page, drawn as its window.
if (DEMO) document.documentElement.classList.add("demo");
// One screen of it, for a section of the landing page.
if (demoPane) document.documentElement.classList.add("pane");
// In a frame on the landing page, a link inside the app takes the frame's place in history
// rather than adding to it, so the page's Back button still leaves the page.
if (demoEmbedded) {
  document.addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href^='#']") : null;
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    location.replace(a.href);
  });
}

function Screen() {
  const { screen, params } = useRoute();
  const agent = useAgent();
  // A screen the agent doesn't have (Output styles once Claude Code is off, say) gives way to Instructions.
  const row = NAV.find((n) => n.screen === screen);
  const away = !!row && !row.agents.includes(agent);
  useEffect(() => {
    if (away) go("instructions", { project: params.get("project"), agent: agentParam(agent) }, true);
  }, [away, agent, params]);
  if (away) return null;
  switch (screen) {
    case "memory":
      return <Memory />;
    case "sessions":
      return <Sessions />;
    case "usage":
      return <Usage />;
    case "hooks":
      return <Hooks />;
    case "agents":
      return <Definitions kind="agent" />;
    case "styles":
      return <Definitions kind="style" />;
    case "skills":
      return <Definitions kind="skill" />;
    case "commands":
      return <Definitions kind="command" />;
    case "plugins":
      return agent === "opencode" ? <Definitions kind="plugin" /> : <Plugins />;
    case "mcp":
      return <Mcp />;
    case "settings":
      return <Settings />;
    case "rules":
      return <CodexRules />;
    case "history":
      return <History />;
    default:
      return <Instructions />;
  }
}

function App() {
  const [palette, setPalette] = useState(false);
  const { state, prefsOpen, openPrefs, closePrefs, setupOpen, project, setProject } = useApp();

  useEffect(() => startSync(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      } else if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        openPrefs();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openPrefs]);

  // Commands from the desktop app's menus.
  useEffect(
    () =>
      desktop?.onCommand((c) => {
        if (c === "prefs") openPrefs();
        else if (c === "prefs:about") openPrefs("about");
        else if (c === "search") setPalette(true);
        else if (c === "refresh") refreshAll();
        else if (c.startsWith("open:")) {
          // Setup finished in its own window, on this project.
          refreshAll();
          setProject(c.slice(5));
          go("instructions", { project: c.slice(5) });
        }
        else if (c.startsWith("go:")) {
          // go:<screen>:<agent>. Sessions and Usage cover every agent, so they come with none and keep the one picked.
          const [, screen, agent = ""] = c.split(":");
          const keep = new URLSearchParams(location.hash.split("?")[1] ?? "").get("agent");
          go(screen as ScreenName, { project, agent: agent ? (agent === "codex" || agent === "opencode" ? agent : null) : keep });
        }
        else if (c === "save") window.dispatchEvent(new Event("acp:save"));
      }),
    [openPrefs, project, setProject],
  );

  // Which agents are on comes with the app's state; until then no screen can know whose files to show.
  if (!state) return <div className="app" />;
  return (
    <div className="app">
      <Sidebar onSearch={() => setPalette(true)} />
      <main className="main">
        <Screen />
      </main>
      <TipCard />
      <MenuHost />
      {palette && <Palette onClose={() => setPalette(false)} />}
      {prefsOpen && <PrefsSheet section={prefsOpen} onClose={closePrefs} />}
      {setupOpen && <Setup />}
    </div>
  );
}

function SetupWindow() {
  useEffect(() => startSync(), []);
  return <Setup standalone />;
}

// One root for the page's lifetime, so a hot reload in development re-renders it instead of mounting twice.
const w = window as unknown as { __acpRoot?: ReturnType<typeof createRoot> };
w.__acpRoot ??= createRoot(document.getElementById("root")!);
w.__acpRoot.render(
  <StrictMode>
    <AppProvider>{windowKind === "setup" ? <SetupWindow /> : <App />}</AppProvider>
  </StrictMode>,
);

// When a change reaches this entry module, a clean reload beats patching a live tree whose context changed.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
