import { AGENT_IDS, AGENT_NAMES } from "../shared/agents.ts";
import type { AgentId } from "../shared/types.ts";
import { useRoute } from "./router.ts";
import { useApp } from "./shell/app-context.ts";

/**
 * Which agents the app shows, and whose files the current screen is about.
 * Preferences turns agents on and off; the route's `agent` parameter picks
 * among the ones that are on, and Claude Code, when it's on, goes unnamed.
 */

/** The agents that are on, in the app's order; every agent until the app's state has loaded. */
export function useAgentsOn(): AgentId[] {
  const { state } = useApp();
  return state ? state.agents.filter((a) => a.on).map((a) => a.id) : AGENT_IDS;
}

/** The agent the screen shows: the route's, if it's on, or else the first agent that is. */
export function useAgent(): AgentId {
  const { params } = useRoute();
  return pickAgent(params.get("agent"), useAgentsOn());
}

export function pickAgent(asked: string | null, on: AgentId[]): AgentId {
  const want = asked || "claude";
  return on.find((a) => a === want) ?? on[0] ?? "claude";
}

/** The route parameter for an agent. */
export const agentParam = (a: AgentId): string => (a === "claude" ? "" : a);

export const agentName = (a: AgentId): string => AGENT_NAMES[a];
