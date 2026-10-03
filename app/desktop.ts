import type { UpdateState } from "../shared/types.ts";

export type MenuItem = { id: string; label: string; enabled?: boolean } | { separator: true };

/** What the desktop app's preload script exposes; absent in a browser. */
export type DesktopBridge = {
  platform: string;
  pickFolder: (title: string) => Promise<string | null>;
  reveal: (path: string) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  setTheme: (t: "system" | "light" | "dark") => Promise<void>;
  onCommand: (cb: (command: string) => void) => () => void;
  /** Open the setup window, or bring it forward. */
  openSetup: () => Promise<void>;
  /** Setup is finished: close its window and open the app, on this project if one was picked. */
  setupDone: (project: string | null) => Promise<void>;
  /** Show a native right-click menu; resolves with the chosen item's id, or null when dismissed. */
  contextMenu: (items: MenuItem[]) => Promise<string | null>;
  copy: (text: string) => Promise<void>;
  /** The updater: new versions from GitHub Releases, installed when the app quits. */
  updates: {
    state: () => Promise<UpdateState>;
    check: () => Promise<UpdateState>;
    install: () => Promise<void>;
    schedule: (on: boolean) => Promise<void>;
    onChange: (cb: (state: UpdateState) => void) => () => void;
  };
};

export const desktop: DesktopBridge | null = (window as unknown as { acpDesktop?: DesktopBridge }).acpDesktop ?? null;

/** Which window this page is: the app, or the setup window the desktop app opens on first launch. */
export const windowKind: "app" | "setup" = new URLSearchParams(location.search).get("window") === "setup" ? "setup" : "app";
