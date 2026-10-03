import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { HOME } from "./paths.ts";

const run = promisify(execFile);

/** Where each agent's command-line tool is usually installed, after the folders on PATH. */
const PLACES = {
  claude: [path.join(HOME, ".local", "bin", "claude"), path.join(HOME, ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"],
  codex: [path.join(HOME, ".local", "bin", "codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex", "/Applications/Codex.app/Contents/Resources/codex"],
  // OpenCode's install script puts it in ~/.opencode/bin; npm and Homebrew put it on PATH.
  opencode: [path.join(HOME, ".opencode", "bin", "opencode"), "/opt/homebrew/bin/opencode", "/usr/local/bin/opencode", path.join(HOME, ".bun", "bin", "opencode")],
};
type Agent = keyof typeof PLACES;

const versions = new Map<Agent, { at: number; value: string | null }>();

function binary(agent: Agent): string | null {
  // ACP_AGENT_DIRS replaces PATH and the usual places, so a test home can leave an agent out
  // even on a Mac where it's installed system-wide.
  const only = process.env.ACP_AGENT_DIRS;
  const fromPath = (only ?? process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, agent));
  return (
    [...fromPath, ...(only === undefined ? PLACES[agent] : [])].find((p) => {
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }) ?? null
  );
}

/** An agent's installed version, e.g. "2.1.285", checked at most once a minute. */
async function agentVersion(agent: Agent): Promise<string | null> {
  const cached = versions.get(agent);
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  const bin = binary(agent);
  let value: string | null = null;
  if (bin) {
    try {
      const { stdout } = await run(bin, ["--version"], { timeout: 8000 });
      value = /(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null;
    } catch {
      value = null;
    }
  }
  versions.set(agent, { at: Date.now(), value });
  return value;
}

export const claudeBinary = () => binary("claude");
export const claudeVersion = () => agentVersion("claude");
export const codexBinary = () => binary("codex");
export const codexVersion = () => agentVersion("codex");
export const opencodeBinary = () => binary("opencode");
export const opencodeVersion = () => agentVersion("opencode");
