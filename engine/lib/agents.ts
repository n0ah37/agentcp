import fs from "node:fs";

import { AGENT_IDS, AGENT_NAMES, AGENT_SOURCE } from "../../shared/agents.ts";
import type { AgentId, AgentStatus, Preferences, SessionSource } from "../../shared/types.ts";
import { claudeBinary, claudeVersion, codexBinary, codexVersion, opencodeBinary, opencodeVersion } from "./claude.ts";
import { CLAUDE_DIR, CODEX_DIR, OPENCODE_DATA_DIR, OPENCODE_DIR, tilde } from "./paths.ts";
import { getPrefs } from "./prefs.ts";

/**
 * Which agents the app shows. Many people use one agent, so each can be turned
 * off: its screens leave the sidebar, and Sessions, Usage and Search leave out
 * its files. Until setup or Preferences chooses, every agent that's installed
 * or has its folder is on, and every agent when none is.
 */

/**
 * The agents this build offers. OpenCode is built but ships after 1.0, with
 * syncing (2026-10-03); ACP_OPENCODE=1 turns it on, for development and the tests.
 */
export const offeredAgents = (): AgentId[] => AGENT_IDS.filter((a) => a !== "opencode" || process.env.ACP_OPENCODE === "1");

const FOUND: Record<AgentId, () => string | null> = { claude: claudeBinary, codex: codexBinary, opencode: opencodeBinary };
const VERSION: Record<AgentId, () => Promise<string | null>> = { claude: claudeVersion, codex: codexVersion, opencode: opencodeVersion };
const FOLDER: Record<AgentId, string> = { claude: CLAUDE_DIR, codex: CODEX_DIR, opencode: OPENCODE_DIR };
/** Folders whose presence means the agent has run here: OpenCode keeps its sessions apart from its config. */
const TRACES: Record<AgentId, string[]> = { claude: [CLAUDE_DIR], codex: [CODEX_DIR], opencode: [OPENCODE_DIR, OPENCODE_DATA_DIR] };

/** The agents setup would turn on: the ones here, or all of them when none is. */
export function suggested(found: { id: AgentId; found: boolean; used: boolean }[]): AgentId[] {
  const here = found.filter((a) => a.found || a.used).map((a) => a.id);
  return here.length ? here : offeredAgents();
}

export function enabledFrom(prefs: Preferences, found: { id: AgentId; found: boolean; used: boolean }[]): AgentId[] {
  const chosen = prefs.agents?.filter((a) => offeredAgents().includes(a));
  return chosen?.length ? chosen : suggested(found);
}

function presence(): { id: AgentId; found: boolean; used: boolean }[] {
  return offeredAgents().map((id) => ({ id, found: !!FOUND[id](), used: TRACES[id].some((d) => fs.existsSync(d)) }));
}

export async function agentStatus(prefs?: Preferences): Promise<AgentStatus[]> {
  const here = presence();
  const on = enabledFrom(prefs ?? (await getPrefs()), here);
  return Promise.all(
    here.map(async (a) => {
      const bin = FOUND[a.id]();
      return { ...a, name: AGENT_NAMES[a.id], on: on.includes(a.id), version: bin ? await VERSION[a.id]() : null, path: bin ? tilde(bin) : null, folder: tilde(FOLDER[a.id]) };
    }),
  );
}

/** The agents that are on, without asking their versions. */
export async function enabledAgents(): Promise<AgentId[]> {
  return enabledFrom(await getPrefs(), presence());
}

/**
 * The session files to read: the one agent asked for, if it's on, or every agent that's on.
 * An agent that's off gives nothing, rather than every agent.
 */
export async function sessionSources(asked: string | null): Promise<SessionSource[]> {
  const on = await enabledAgents();
  if (asked === null) return on.map((a) => AGENT_SOURCE[a]);
  return on.filter((a) => a === asked).map((a) => AGENT_SOURCE[a]);
}
