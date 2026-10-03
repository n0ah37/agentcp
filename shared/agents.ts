import type { AgentId, SessionSource } from "./types.ts";

/** The agents the app knows, in the order it lists them. */
export const AGENT_IDS: AgentId[] = ["claude", "codex", "opencode"];

export const AGENT_NAMES: Record<AgentId, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };

/** How Sessions and Usage name each agent's session files. */
export const AGENT_SOURCE: Record<AgentId, SessionSource> = { claude: "claude_code", codex: "codex", opencode: "opencode" };

export const isAgentId = (v: unknown): v is AgentId => typeof v === "string" && (AGENT_IDS as string[]).includes(v);
