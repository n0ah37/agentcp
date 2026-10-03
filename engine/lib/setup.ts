import fs from "node:fs";
import path from "node:path";

import type { SetupView } from "../../shared/types.ts";
import { agentStatus, suggested } from "./agents.ts";
import { docsInfo } from "./docs.ts";
import { CLAUDE_DIR, HOME } from "./paths.ts";
import { getPrefs } from "./prefs.ts";

export async function setupView(): Promise<SetupView> {
  let seen = 0;
  try {
    seen = fs.readdirSync(path.join(CLAUDE_DIR, "projects")).length;
  } catch {
    /* Claude Code hasn't run here yet */
  }
  // Setup suggests what's on this Mac, unless an earlier run chose otherwise.
  const prefs = await getPrefs();
  const agents = await agentStatus(prefs);
  const on = prefs.agents ?? suggested(agents);
  return {
    agents: agents.map((a) => ({ ...a, on: on.includes(a.id) })),
    home: HOME,
    seen,
    docs: docsInfo(),
  };
}
