import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOME = os.homedir();

/** Claude Code honours CLAUDE_CONFIG_DIR; everything under ~/.claude moves with it. */
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR
  ? path.resolve(expandHome(process.env.CLAUDE_CONFIG_DIR))
  : path.join(HOME, ".claude");

/** Codex honours CODEX_HOME the way Claude Code honours CLAUDE_CONFIG_DIR. */
export const CODEX_DIR = process.env.CODEX_HOME ? path.resolve(expandHome(process.env.CODEX_HOME)) : path.join(HOME, ".codex");

/**
 * OpenCode's global folder, ~/.config/opencode (its config docs), under
 * XDG_CONFIG_HOME when that is set (its themes page names
 * $XDG_CONFIG_HOME/opencode); its data, sessions included, sit in
 * ~/.local/share/opencode (its troubleshooting page), under XDG_DATA_HOME
 * when that is set.
 */
export const OPENCODE_DIR = path.join(process.env.XDG_CONFIG_HOME ? path.resolve(expandHome(process.env.XDG_CONFIG_HOME)) : path.join(HOME, ".config"), "opencode");
export const OPENCODE_DATA_DIR = path.join(process.env.XDG_DATA_HOME ? path.resolve(expandHome(process.env.XDG_DATA_HOME)) : path.join(HOME, ".local", "share"), "opencode");

/** The app's own directory: preferences, history, snapshots. */
export const APP_DIR = process.env.ACP_HOME ? path.resolve(expandHome(process.env.ACP_HOME)) : path.join(HOME, ".agentcp");

/**
 * The app was called Agent Control Plane until 2026-10-01 and kept its things
 * in ~/.agent-control-plane. Moved once, before anything reads them, so
 * preferences and the history of every save come along.
 */
export function moveOldAppDir(): void {
  if (process.env.ACP_HOME) return;
  const old = path.join(HOME, ".agent-control-plane");
  try {
    if (fs.existsSync(old) && !fs.existsSync(APP_DIR)) fs.renameSync(old, APP_DIR);
  } catch {
    /* the old folder stays where it is; the app starts fresh */
  }
}

export const SNAPSHOT_DIR = path.join(APP_DIR, "snapshots");
export const HISTORY_FILE = path.join(APP_DIR, "history.jsonl");
export const PREFS_FILE = path.join(APP_DIR, "preferences.json");

export const MANAGED_DIR =
  process.platform === "darwin"
    ? "/Library/Application Support/ClaudeCode"
    : process.platform === "win32"
      ? "C:\\Program Files\\ClaudeCode"
      : "/etc/claude-code";

/**
 * The repository root, resolved from this file whether run by tsx (engine/lib)
 * or bundled (dist/engine, dist/desktop). Inside the packaged app the bundle
 * sits in app.asar, and nothing is read relative to it but the built UI.
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function tilde(p: string): string {
  if (p === HOME) return "~";
  return p.startsWith(HOME + path.sep) ? "~" + p.slice(HOME.length) : p;
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The folder name Claude Code uses under ~/.claude/projects for a directory:
 * every character that is not a letter or digit becomes a dash.
 * /Users/a/Dev/my.app → -Users-a-Dev-my-app
 */
export function encodeProjectDir(abs: string): string {
  return abs.replace(/[^a-zA-Z0-9]/g, "-");
}
