import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BrowserWindow, Menu, app, clipboard, dialog, ipcMain, nativeTheme, screen, shell, type MenuItemConstructorOptions } from "electron";

import { COPYRIGHT, LINKS } from "../shared/links.ts";
import { checkForUpdates, installUpdate, scheduleUpdates, updateState } from "./updates.ts";

/**
 * The desktop app: the engine runs in this process, on a free loopback port
 * with a fresh token, and one window loads the UI it serves. Until setup is
 * finished, a small setup window of its own opens instead.
 *
 * Launched from the Finder, an app gets launchd's environment, not the shell's,
 * so the shell's is read once before anything else loads (see `loginShellEnv`).
 * Nothing from the engine is imported until then: its folders depend on it.
 */

const isMac = process.platform === "darwin";
const DEV_URL = process.env.ACP_DEV_URL ?? null;
const CAPTURE = process.env.ACP_CAPTURE ? (JSON.parse(process.env.ACP_CAPTURE) as Capture) : null;

type Shot = { name: string; hash: string; theme: "light" | "dark"; window?: "setup"; width?: number; height?: number; wait?: number; script?: string };
type Capture = { dir: string; shots: Shot[] };

// Light and dark window backgrounds, so a window never flashes white while the UI loads.
const GROUND = { light: "#f2f3f5", dark: "#0e0e10" };
const PAPER = { light: "#fbfcfd", dark: "#141416" };
const SETUP_SIZE = { width: 620, height: 680 };

/**
 * An app opened from the Finder gets launchd's environment: PATH without Homebrew
 * or ~/.local/bin, and none of the variables set in ~/.zshrc, such as
 * CLAUDE_CONFIG_DIR, so the app would read the wrong folder. The login shell is
 * asked once, as VS Code does: `$SHELL -ilc` prints its environment between
 * markers (rc-file output is ignored, and /usr/bin/env works in any shell), with
 * a 10-second limit. PATH is merged, the shell's entries first; the agents' own
 * variables are taken only when they aren't set already (a launch from a terminal).
 */
const FROM_SHELL = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_CODE_PLUGIN_CACHE_DIR", "CLAUDE_CODE_DISABLE_AUTO_MEMORY", "DEVELOPER_DIR"];

async function loginShellEnv(): Promise<void> {
  if (!isMac && process.platform !== "linux") return;
  const mark = "__AGENTCP_ENV__";
  const shellEnv = await new Promise<Record<string, string>>((resolve) => {
    const child = spawn(process.env.SHELL || "/bin/zsh", ["-ilc", `echo ${mark}; /usr/bin/env; echo ${mark}`], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, AGENTCP_RESOLVING_ENVIRONMENT: "1" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const done = () => {
      clearTimeout(timer);
      const vars: Record<string, string> = {};
      for (const line of (out.split(mark)[1] ?? "").split("\n")) {
        const i = line.indexOf("=");
        if (i > 0) vars[line.slice(0, i)] = line.slice(i + 1);
      }
      resolve(vars);
    };
    child.on("close", done);
    child.on("error", done);
  });
  const fallback = [path.join(os.homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"].filter((d) => fs.existsSync(d));
  const parts = [...(shellEnv.PATH ?? "").split(":"), ...(process.env.PATH ?? "").split(":"), ...fallback];
  process.env.PATH = [...new Set(parts.filter(Boolean))].join(":");
  for (const k of FROM_SHELL) if (!process.env[k] && shellEnv[k]) process.env[k] = shellEnv[k];
}

// ------------------------------------------------------------- window state

type Bounds = { x?: number; y?: number; width: number; height: number; maximized?: boolean };
let stateFile = "";

function loadBounds(): Bounds {
  const fallback = { width: 1360, height: 860 };
  try {
    const b = JSON.parse(fs.readFileSync(stateFile, "utf8")) as Bounds;
    // Only reopen where the window was if that spot is still on a screen.
    const on = screen.getAllDisplays().some((d) => b.x !== undefined && b.y !== undefined && b.x >= d.bounds.x - 40 && b.y >= d.bounds.y - 40 && b.x < d.bounds.x + d.bounds.width && b.y < d.bounds.y + d.bounds.height);
    return on ? b : { ...fallback, width: b.width || fallback.width, height: b.height || fallback.height };
  } catch {
    return fallback;
  }
}

function saveBounds(win: BrowserWindow): void {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
  } catch {
    /* not worth failing over */
  }
}

// -------------------------------------------------------------------- app

let main: BrowserWindow | null = null;
let setupWin: BrowserWindow | null = null;
let baseUrl = "";
let quitting = false;

function webPreferences(offscreen?: boolean): Electron.WebPreferences {
  return {
    preload: path.join(import.meta.dirname, "preload.cjs"),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    spellcheck: false,
    ...(offscreen ? { offscreen: true } : {}),
  };
}

/** Links leave for the browser; a window itself never navigates away from the app. */
function guard(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(baseUrl)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
}

function createWindow(opts: { offscreen?: boolean; width?: number; height?: number } = {}): BrowserWindow {
  const b = opts.offscreen ? { width: opts.width ?? 1440, height: opts.height ?? 900 } : loadBounds();
  const win = new BrowserWindow({
    ...b,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: "AgentCP",
    backgroundColor: nativeTheme.shouldUseDarkColors ? GROUND.dark : GROUND.light,
    // "active": the sidebar stays glass while another app is in front, instead of the flat grey macOS gives an inactive window.
    ...(isMac && !opts.offscreen
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 18, y: 19 }, vibrancy: "sidebar" as const, visualEffectState: "active" as const, backgroundColor: "#00000000" }
      : {}),
    webPreferences: webPreferences(opts.offscreen),
  });
  if ((b as Bounds).maximized) win.maximize();
  guard(win);
  if (!opts.offscreen) {
    win.once("ready-to-show", () => win.show());
    win.on("close", () => saveBounds(win));
  }
  return win;
}

/**
 * Setup's own window: small, fixed in size and opaque, the way a Mac app's
 * first-run assistant is. It has no sidebar material behind it, so nothing
 * from the app can show through.
 */
function createSetupWindow(opts: { offscreen?: boolean } = {}): BrowserWindow {
  const win = new BrowserWindow({
    ...SETUP_SIZE,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: "Set Up AgentCP",
    backgroundColor: nativeTheme.shouldUseDarkColors ? PAPER.dark : PAPER.light,
    ...(isMac && !opts.offscreen ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 17 } } : {}),
    webPreferences: webPreferences(opts.offscreen),
  });
  guard(win);
  if (!opts.offscreen) win.once("ready-to-show", () => win.show());
  return win;
}

function openMain(): void {
  if (main) {
    main.show();
    main.focus();
    return;
  }
  main = createWindow();
  main.on("closed", () => (main = null));
  void main.loadURL(baseUrl);
}

function openSetup(): void {
  if (setupWin) {
    setupWin.focus();
    return;
  }
  const win = createSetupWindow();
  setupWin = win;
  win.on("closed", () => {
    setupWin = null;
    // Closing setup before finishing it still leaves you in the app; it opens again next launch.
    if (!quitting && !main) openMain();
  });
  void win.loadURL(`${baseUrl}/?window=setup`);
}

function send(command: string): void {
  main?.webContents.send("acp:command", command);
}

/** The app's menus. The View menu lists the screens of the agents that are on, rebuilt when one is turned on or off. */
function buildMenu(on: string[]): void {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { label: "Check for Updates…", click: () => send("prefs:about") },
              { type: "separator" },
              { label: "Preferences…", accelerator: "Cmd+,", click: () => send("prefs") },
              { label: "Run Setup Again…", click: openSetup },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        { label: "Search…", accelerator: "CmdOrCtrl+K", click: () => send("search") },
        { label: "Save", accelerator: "CmdOrCtrl+S", click: () => send("save") },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        // The sidebar's order: Claude Code's rows on ⌘1 to ⌘7, Codex's on ⌥⌘1 to ⌥⌘7.
        ...(on.includes("claude") ? claudeItems() : []),
        ...(on.includes("claude") && on.includes("codex") ? [{ type: "separator" } as MenuItemConstructorOptions] : []),
        ...(on.includes("codex") ? codexItems(!on.includes("claude")) : []),
        ...(on.includes("opencode") && (on.includes("claude") || on.includes("codex")) ? [{ type: "separator" } as MenuItemConstructorOptions] : []),
        ...(on.includes("opencode") ? opencodeItems(on.length === 1) : []),
        { type: "separator" },
        { label: "Sessions", accelerator: "CmdOrCtrl+8", click: () => send("go:sessions:") },
        { label: "Usage", accelerator: "CmdOrCtrl+9", click: () => send("go:usage:") },
        { type: "separator" },
        // Reload and the inspector are for working on the app, not for using it.
        ...(app.isPackaged ? [] : ([{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }] as MenuItemConstructorOptions[])),
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "AgentCP Website", click: () => void shell.openExternal(LINKS.site) },
        { label: "What's New", click: () => void shell.openExternal(LINKS.releases) },
        { label: "Report a Problem…", click: () => void shell.openExternal(LINKS.issues) },
        { type: "separator" },
        ...(on.includes("claude")
          ? [
              { label: "Claude Code Documentation", click: () => void shell.openExternal("https://code.claude.com/docs/en/overview") },
              { label: "How Claude Code Reads CLAUDE.md", click: () => void shell.openExternal("https://code.claude.com/docs/en/memory") },
            ]
          : []),
        ...(on.includes("codex") ? [{ label: "Codex Documentation", click: () => void shell.openExternal("https://learn.chatgpt.com/docs/configuration") }] : []),
        ...(on.includes("opencode") ? [{ label: "OpenCode Documentation", click: () => void shell.openExternal("https://opencode.ai/v2/docs/") }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function claudeItems(): MenuItemConstructorOptions[] {
  return [
    ...(
      [
        ["Instructions", "instructions"],
        ["Memory", "memory"],
        ["Subagents", "agents"],
        ["Output Styles", "styles"],
        ["Skills", "skills"],
        ["Hooks", "hooks"],
        ["Settings", "settings"],
      ] as const
    ).map(([label, screen], i) => ({ label: `Claude Code ${label}`, accelerator: `CmdOrCtrl+${i + 1}`, click: () => send(`go:${screen}:claude`) })),
    { label: "Claude Code Plugins", click: () => send("go:plugins:claude") },
    { label: "Claude Code MCP Servers", click: () => send("go:mcp:claude") },
  ];
}

/** Codex's rows take ⌘1 to ⌘7 when Claude Code is off. */
function codexItems(alone: boolean): MenuItemConstructorOptions[] {
  return [
    ...(
      [
        ["Instructions", "instructions"],
        ["Memory", "memory"],
        ["Subagents", "agents"],
        ["Skills", "skills"],
        ["Rules", "rules"],
        ["Hooks", "hooks"],
        ["Settings", "settings"],
      ] as const
    ).map(([label, screen], i) => ({ label: `Codex ${label}`, accelerator: `${alone ? "" : "Alt+"}CmdOrCtrl+${i + 1}`, click: () => send(`go:${screen}:codex`) })),
    { label: "Codex MCP Servers", click: () => send("go:mcp:codex") },
  ];
}

/** OpenCode's rows take ⌘1 to ⌘7 when it's the only agent on; otherwise they have no shortcut. */
function opencodeItems(alone: boolean): MenuItemConstructorOptions[] {
  return (
    [
      ["Instructions", "instructions"],
      ["Agents", "agents"],
      ["Commands", "commands"],
      ["Skills", "skills"],
      ["Plugins", "plugins"],
      ["MCP Servers", "mcp"],
      ["Settings", "settings"],
    ] as const
  ).map(([label, screen], i) => ({ label: `OpenCode ${label}`, ...(alone ? { accelerator: `CmdOrCtrl+${i + 1}` } : {}), click: () => send(`go:${screen}:opencode`) }));
}

function registerIpc(): void {
  ipcMain.handle("acp:pick-folder", async (e, title: string) => {
    const parent = BrowserWindow.fromWebContents(e.sender);
    const opts: Electron.OpenDialogOptions = { title, message: title, properties: ["openDirectory", "createDirectory"] };
    const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  ipcMain.handle("acp:reveal", (_e, p: string) => {
    if (typeof p === "string" && path.isAbsolute(p)) shell.showItemInFolder(p);
  });
  ipcMain.handle("acp:open-in-editor", async (_e, p: string) => {
    if (typeof p === "string" && path.isAbsolute(p)) await shell.openPath(p);
  });
  ipcMain.handle("acp:open-setup", () => openSetup());
  // A native right-click menu for a file or list row; resolves with the chosen item's id, or null.
  ipcMain.handle("acp:context-menu", (e, items: unknown) => {
    if (!Array.isArray(items)) return null;
    return new Promise<string | null>((resolve) => {
      let chosen: string | null = null;
      const menu = Menu.buildFromTemplate(
        (items as { id?: string; label?: string; enabled?: boolean; separator?: boolean }[]).map((i) =>
          i.separator ? { type: "separator" as const } : { label: String(i.label ?? ""), enabled: i.enabled !== false, click: () => (chosen = String(i.id ?? "")) },
        ),
      );
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
      menu.popup({ window: win, callback: () => resolve(chosen) });
    });
  });
  ipcMain.handle("acp:copy", (_e, text: unknown) => {
    if (typeof text === "string") clipboard.writeText(text);
  });
  ipcMain.handle("acp:setup-done", (_e, project: unknown) => {
    const p = typeof project === "string" && path.isAbsolute(project) ? project : null;
    // The app window opens first, so closing setup's window doesn't open a second one.
    if (main) main.webContents.send("acp:command", p ? `open:${p}` : "refresh");
    openMain();
    setupWin?.close();
  });
  ipcMain.handle("acp:update-state", () => updateState());
  ipcMain.handle("acp:check-updates", () => checkForUpdates());
  ipcMain.handle("acp:install-update", () => installUpdate());
  ipcMain.handle("acp:schedule-updates", (_e, on: unknown) => scheduleUpdates(on === true));
  ipcMain.handle("acp:set-theme", (_e, theme: "system" | "light" | "dark") => {
    // A capture sets the theme per shot; the page's own preference must not undo it.
    if (!CAPTURE && (theme === "system" || theme === "light" || theme === "dark")) nativeTheme.themeSource = theme;
  });
}

async function capture(c: Capture): Promise<void> {
  fs.mkdirSync(c.dir, { recursive: true });
  for (const shot of c.shots) {
    nativeTheme.themeSource = shot.theme;
    const win = shot.window === "setup" ? createSetupWindow({ offscreen: true }) : createWindow({ offscreen: true, width: shot.width, height: shot.height });
    win.webContents.setFrameRate(30);
    await win.loadURL(`${baseUrl}/${shot.window ? `?window=${shot.window}` : ""}#${shot.hash.replace(/^#/, "")}`);
    await win.webContents.executeJavaScript(`document.documentElement.classList.add("capture")`);
    await new Promise((r) => setTimeout(r, shot.wait ?? 1800));
    if (shot.script) {
      await win.webContents.executeJavaScript(shot.script);
      await new Promise((r) => setTimeout(r, 900));
    }
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(c.dir, `${shot.name}.png`), image.toPNG());
    win.destroy();
  }
}

async function boot(): Promise<void> {
  if (app.isPackaged) {
    await loginShellEnv();
    process.env.ACP_BUNDLED_DOCS ??= path.join(process.resourcesPath, "docs");
  }
  const { APP_DIR, moveOldAppDir } = await import("../engine/lib/paths.ts");
  moveOldAppDir();
  stateFile = path.join(APP_DIR, "window.json");
  if (DEV_URL) process.env.ACP_DEV = "1";
  const { start } = await import("../engine/main.ts");
  const engine = await start({ port: DEV_URL ? Number(process.env.ACP_ENGINE_PORT ?? 3101) : 0 });
  baseUrl = DEV_URL ?? engine.url;

  registerIpc();
  if (CAPTURE) {
    await capture(CAPTURE);
    app.exit(0);
    return;
  }
  const { getPrefs, onPrefsChange } = await import("../engine/lib/prefs.ts");
  const { enabledAgents } = await import("../engine/lib/agents.ts");
  buildMenu(await enabledAgents());
  onPrefsChange(() => void enabledAgents().then(buildMenu));
  const prefs = await getPrefs();
  scheduleUpdates(prefs.checkUpdates);
  if (prefs.setupDone) openMain();
  else openSetup();
}

// A test copy (ACP_USERDATA, with ACP_HOME) keeps its own window state and lock, so it runs beside the real app.
if (process.env.ACP_USERDATA) app.setPath("userData", process.env.ACP_USERDATA);
if (!CAPTURE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName("AgentCP");
  app.setAboutPanelOptions({
    applicationName: "AgentCP",
    applicationVersion: app.getVersion(),
    copyright: `${COPYRIGHT}\nReleased under the MIT License.`,
    website: LINKS.site,
  });
  app.on("second-instance", () => {
    const w = setupWin ?? main;
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });
  app.on("before-quit", () => (quitting = true));
  app.on("window-all-closed", () => {
    // A capture closes a window per shot and quits on its own when done.
    if (!isMac && !CAPTURE) app.quit();
  });
  app.on("activate", () => {
    if (!main && !setupWin && baseUrl) openMain();
  });
  app
    .whenReady()
    .then(boot)
    .catch((e: unknown) => {
      dialog.showErrorBox("AgentCP couldn't start", e instanceof Error ? e.message : String(e));
      app.exit(1);
    });
}
