import { createContext, useContext } from "react";

import type { AgentId, AppState, DocRef, Preferences, ProjectRef, WritePlan, WriteResult } from "../../shared/types.ts";

// The context object lives apart from its provider, so a hot reload of the
// provider in development cannot leave components holding a different context.

export type SaveRequest = {
  path: string;
  /** New content, or null to delete the file. */
  content: string | null;
  baseHash: string | null;
  project: string | null;
  /** Server endpoint that builds the plan; defaults to a plain file write. */
  planned?: { plan: WritePlan; content: string | null; baseHash: string | null };
  title?: string;
  verb?: string;
  onSaved?: (r: WriteResult) => void;
  onReload?: () => void;
};

export type Toast = { text: string; tone?: "bad"; action?: { label: string; run: () => void } };

/** What a file's right-click and "…" menus need to know about it. */
export type MenuFile = { path: string; display: string; name: string; exists: boolean; editable: boolean; hash: string | null };
export type FileMenuOptions = { canDelete?: boolean; onDeleted?: () => void; onRevert?: (() => void) | null; agent?: AgentId };

export type Ctx = {
  state: AppState | undefined;
  prefs: Preferences | undefined;
  setPrefs: (p: Partial<Preferences>) => Promise<void>;
  project: string | null;
  projectRef: ProjectRef | null;
  setProject: (p: string | null) => void;
  openDoc: (d: DocRef) => void;
  save: (r: SaveRequest) => void;
  toast: (t: Toast) => void;
  openPrefs: (section?: string) => void;
  prefsOpen: string | null;
  closePrefs: () => void;
  /** Write with AI: a prompt about this file to copy into Claude Code or Codex. */
  askAI: (file: { path: string; name: string }, agent?: AgentId) => void;
  /** The menu for one file, at the pointer: Show in Finder, Copy Path, Write with AI, Rename, Delete. */
  fileMenu: (at: { clientX: number; clientY: number }, file: MenuFile, opts?: FileMenuOptions) => void;
  /** First-run setup: shown until it is finished once, and again from the app menu. */
  setupOpen: boolean;
  openSetup: () => void;
  closeSetup: () => void;
};

export const AppCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp outside AppProvider");
  return c;
}

