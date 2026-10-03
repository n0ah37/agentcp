import { contextBridge, ipcRenderer } from "electron";

/**
 * The only native abilities the UI gets: pick a folder, show a file in the
 * Finder, open it in its default app, show a right-click menu, copy text,
 * follow the theme, open and finish setup, look for updates, and receive menu
 * commands. Everything else goes through the engine's HTTP API, like the
 * browser build.
 */
contextBridge.exposeInMainWorld("acpDesktop", {
  platform: process.platform,
  pickFolder: (title: string): Promise<string | null> => ipcRenderer.invoke("acp:pick-folder", title),
  reveal: (p: string): Promise<void> => ipcRenderer.invoke("acp:reveal", p),
  openFile: (p: string): Promise<void> => ipcRenderer.invoke("acp:open-in-editor", p),
  setTheme: (t: "system" | "light" | "dark"): Promise<void> => ipcRenderer.invoke("acp:set-theme", t),
  openSetup: (): Promise<void> => ipcRenderer.invoke("acp:open-setup"),
  contextMenu: (items: { id?: string; label?: string; enabled?: boolean; separator?: boolean }[]): Promise<string | null> => ipcRenderer.invoke("acp:context-menu", items),
  copy: (text: string): Promise<void> => ipcRenderer.invoke("acp:copy", text),
  setupDone: (project: string | null): Promise<void> => ipcRenderer.invoke("acp:setup-done", project),
  updates: {
    state: (): Promise<unknown> => ipcRenderer.invoke("acp:update-state"),
    check: (): Promise<unknown> => ipcRenderer.invoke("acp:check-updates"),
    install: (): Promise<void> => ipcRenderer.invoke("acp:install-update"),
    schedule: (on: boolean): Promise<void> => ipcRenderer.invoke("acp:schedule-updates", on),
    onChange: (cb: (state: unknown) => void): (() => void) => {
      const listener = (_e: unknown, state: unknown) => cb(state);
      ipcRenderer.on("acp:update", listener);
      return () => ipcRenderer.removeListener("acp:update", listener);
    },
  },
  onCommand: (cb: (command: string) => void): (() => void) => {
    const listener = (_e: unknown, command: string) => cb(command);
    ipcRenderer.on("acp:command", listener);
    return () => ipcRenderer.removeListener("acp:command", listener);
  },
});
