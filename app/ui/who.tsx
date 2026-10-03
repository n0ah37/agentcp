import type { AgentId } from "../../shared/types.ts";
import { agentName, useAgentsOn } from "../agent.ts";

/**
 * Whose sessions Sessions and Usage show: every agent that's on, unless one is
 * picked here. The sidebar's agent picker is for the agents' files and doesn't apply.
 */
export function useWho(params: URLSearchParams): AgentId | null {
  const on = useAgentsOn();
  return on.find((a) => a === params.get("who")) ?? null;
}

/** What "every agent that's on" reads as: "Claude Code", "either agent", "any agent". */
export function useEveryone(): string {
  const on = useAgentsOn();
  return on.length === 1 ? agentName(on[0]) : on.length === 2 ? "either agent" : "any agent";
}

/** The agent filter; with one agent on there's nothing to choose, so it isn't shown. */
export function WhoFilter({ who, onPick }: { who: AgentId | null; onPick: (a: AgentId | null) => void }) {
  const on = useAgentsOn();
  if (on.length < 2) return null;
  return (
    <div className="seg" role="group" aria-label="Agent">
      <button type="button" aria-pressed={who === null} onClick={() => onPick(null)}>
        {on.length === 2 ? "Both" : "All"}
      </button>
      {on.map((a) => (
        <button key={a} type="button" aria-pressed={who === a} onClick={() => onPick(a)}>
          {agentName(a)}
        </button>
      ))}
    </div>
  );
}
