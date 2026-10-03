import fs from "node:fs/promises";

import { AGENT_IDS, isAgentId } from "../../shared/agents.ts";
import type { Preferences } from "../../shared/types.ts";
import { atomicWrite } from "./fsx.ts";
import { PREFS_FILE } from "./paths.ts";

const DEFAULTS: Preferences = {
  // Writes stay off until turned on, and the engine enforces it rather than
  // trusting the UI to grey out a button (PRD decision log, 2026-09-07).
  allowEdits: false,
  appearance: "system",
  // Filled by setup's project search; nobody's code is assumed to live anywhere.
  projectRoots: [],
  skipFolders: [],
  showWorktrees: false,
  lastProject: null,
  setupDone: null,
  showTips: true,
  // Instruction files and skills open as text; Formatted is one click away.
  formatted: false,
  sessions: true,
  checkUpdates: true,
  // Chosen in setup; until then the agents found on this Mac are shown (agents.ts).
  agents: null,
};

let current: Preferences | null = null;
const listeners = new Set<(p: Preferences) => void>();

/** Called after every change, such as the desktop app rebuilding its View menu when an agent is turned off. */
export function onPrefsChange(fn: (p: Preferences) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function getPrefs(): Promise<Preferences> {
  if (current) return current;
  try {
    const raw = JSON.parse(await fs.readFile(PREFS_FILE, "utf8")) as Partial<Preferences> & { hideAttic?: unknown };
    // hideAttic (0.3.0) was one person's archive folder; skipFolders does it for any folder.
    delete raw.hideAttic;
    current = { ...DEFAULTS, ...raw };
  } catch {
    current = { ...DEFAULTS };
  }
  return current;
}

export async function setPrefs(patch: Partial<Preferences>): Promise<Preferences> {
  const next = { ...(await getPrefs()), ...patch };
  for (const list of [next.projectRoots, next.skipFolders]) {
    if (!Array.isArray(list) || list.some((r) => typeof r !== "string")) throw new Error("Folders must be a list of paths.");
  }
  if (next.agents !== null && (!Array.isArray(next.agents) || !next.agents.length || !next.agents.every(isAgentId))) {
    throw new Error("Keep at least one agent on.");
  }
  if (next.agents) next.agents = AGENT_IDS.filter((a) => next.agents!.includes(a));
  current = next;
  await atomicWrite(PREFS_FILE, JSON.stringify(next, null, 2) + "\n");
  for (const fn of listeners) fn(next);
  return next;
}
