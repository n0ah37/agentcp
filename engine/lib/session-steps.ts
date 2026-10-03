import path from "node:path";

import type { SessionSource, SessionStep, StepKind } from "../../shared/types.ts";
import { HOME, isInside } from "./paths.ts";

/** How a session file's lines read as a person: what was typed, and what each tool call did. */

function field(text: string, ...names: string[]): string | null {
  for (const n of names) {
    const m = new RegExp(`"${n}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(text);
    if (m) {
      try {
        return JSON.parse(`"${m[1]}"`) as string;
      } catch {
        return m[1];
      }
    }
  }
  return null;
}

/**
 * What you typed, without what the agent's host added to your message: system
 * reminders, command wrappers, hook output. Returns "" when nothing is left.
 */
export function cleanPrompt(text: string): string {
  return text
    .replace(/<(system-reminder|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|user-prompt-submit-hook|task-notification|bash-stdout|bash-stderr)>[\s\S]*?<\/\1>/g, "")
    .replace(/<command-name>\s*([^<]*?)\s*<\/command-name>/g, "$1")
    .replace(/<bash-input>([\s\S]*?)<\/bash-input>/g, "! $1")
    .replace(/^(\s*\[image\]\s*)+/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export function classify(tool: string, input: string): SessionStep {
  const t = tool.toLowerCase();
  const step = (kind: StepKind, target: string | null, name = tool): SessionStep => ({ kind, tool: name, target, at: null });
  if (t === "read" || t === "view_image") return step("read", field(input, "file_path", "path"));
  if (["write", "edit", "multiedit", "notebookedit"].includes(t)) return step("edit", field(input, "file_path", "notebook_path", "path"));
  if (t === "apply_patch") {
    const m = /\*\*\* (?:Update|Add|Delete) File: ([^\\\n"]+)/.exec(input);
    return step("edit", m ? m[1].trim() : null);
  }
  if (["bash", "exec_command", "shell", "local_shell_call", "bashoutput"].includes(t)) return step("run", field(input, "command", "cmd") ?? oneLine(input, 120));
  if (["grep", "glob", "toolsearch", "ls"].includes(t)) return step("search", field(input, "pattern", "query", "path"));
  if (["webfetch", "websearch", "web_search_call", "search_openai_docs"].includes(t)) return step("web", field(input, "url", "query"));
  if (t === "agent" || t === "task") return step("agent", field(input, "description", "subagent_type"), field(input, "subagent_type") ?? "Subagent");
  if (t === "skill") return step("skill", field(input, "skill", "command"));
  if (["todowrite", "exitplanmode", "update_plan", "enterplanmode"].includes(t)) return step("plan", null);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) {
    // Connector servers are named by an id; the tool's own name reads better then.
    const server = /^[0-9a-f-]{20,}$/.test(mcp[1]) ? null : mcp[1].replace(/_/g, " ");
    return step("other", null, server ? `${server} · ${mcp[2].replace(/_/g, " ")}` : mcp[2].replace(/[-_]/g, " "));
  }
  return step("other", null, tool.replace(/^_/, "").replace(/_/g, " "));
}

export function resumeCommand(source: SessionSource, nativeId: string, project: string | null): string | null {
  // ~/Code/app reads better than /Users/you/Code/app, and works the same in a shell.
  const where = project ? (isInside(project, HOME) && /^[\w@%+=:,./-]+$/.test(path.relative(HOME, project)) ? `~/${path.relative(HOME, project)}` : shellQuote(project)) : null;
  const cd = where ? `cd ${where} && ` : "";
  if (source === "claude_code") return `${cd}claude --resume ${nativeId}`;
  if (source === "codex") return `${cd}codex resume ${nativeId}`;
  // OpenCode's CLI page: `opencode [project]` starts the TUI, and `--session` is "Session ID to continue".
  if (source === "opencode") return `${cd}opencode --session ${nativeId}`;
  return null;
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
