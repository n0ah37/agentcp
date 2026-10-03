import path from "node:path";

import { AGENT_NAMES } from "../../shared/agents.ts";
import type { AgentId, ProjectRef } from "../../shared/types.ts";
import { fileView } from "./files.ts";

/**
 * The prompt behind "Write with AI": one block of text to paste into Claude
 * Code, Codex or OpenCode, naming the file, what it is, the docs page that governs it
 * and anything the app flagged in it. The app never starts a session itself;
 * everyone's machine and setup differ, so the person runs it where they work.
 */
export async function aiPrompt(input: { path: string; project: ProjectRef | null; agent: AgentId }): Promise<{ prompt: string }> {
  const view = await fileView(input.path, input.project, undefined, input.agent === "claude" ? null : input.agent);
  const agent = AGENT_NAMES[input.agent];
  const name = path.basename(input.path);
  const lines: string[] = [];
  lines.push(`Help me improve ${name} at ${view.file.display}${input.project ? `, in the project at ${input.project.display}` : ""}.`);
  if (view.about) lines.push("", `What it is: ${view.about.summary}`, `${agent}'s docs for it: ${view.about.doc.url}`);
  if (view.findings.length) {
    lines.push("", "AgentCP found these:");
    for (const f of view.findings) lines.push(`- ${f.title}${f.line ? ` (line ${f.line})` : ""} ${f.detail} See ${f.doc.url}`);
  }
  lines.push(
    "",
    view.file.exists ? "Read the file and that docs page first." : "The file doesn't exist yet. Read that docs page first.",
    "Then suggest the changes as a diff and wait for my OK before writing anything.",
    "Keep it short, and keep only what applies to this project.",
  );
  return { prompt: lines.join("\n") };
}
