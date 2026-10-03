import type { Tip } from "../../shared/types.ts";
import { docRef, docSays } from "./docs.ts";

/**
 * The "Did you know?" card: short facts about how Claude Code reads its files
 * and uses its prompt cache, the kind people only learn by reading the docs.
 * Like the checks, each tip names the sentence of the documentation it rests
 * on (`says`); a tip whose sentence a docs update dropped is left out, and
 * tests/engine.test.ts fails so it gets rewritten.
 */

type Source = Omit<Tip, "doc"> & { slug: string; anchor?: string; says: string };

export const TIP_SOURCES: Source[] = [
  {
    id: "claude-md-mid-session",
    screens: ["instructions"],
    title: "A saved CLAUDE.md waits for the next session",
    body: "Claude reads your own and the project's CLAUDE.md once, when a session starts, and keeps that copy. An edit applies after /clear, /compact or a restart.",
    slug: "prompt-caching",
    anchor: "editing-claude-md-mid-session",
    says: "Your project-root and user-level CLAUDE.md files are read once at session start and held in memory.",
  },
  {
    id: "nested-load-later",
    screens: ["instructions"],
    title: "Subfolder files load when Claude gets there",
    body: "A CLAUDE.md in a subfolder, and a rule with paths:, loads the first time Claude reads a file it covers. Until then, an edit to it still counts in the running session.",
    slug: "prompt-caching",
    anchor: "editing-claude-md-mid-session",
    says: "load later, when Claude first reads a matching file",
  },
  {
    id: "compact-rereads",
    screens: ["instructions", "sessions"],
    title: "/compact re-reads the project's CLAUDE.md",
    body: "After /compact, Claude reads the project's CLAUDE.md from disk again. Instructions you only gave in chat are summarised away, so put the ones that matter in the file.",
    slug: "memory",
    anchor: "instructions-seem-lost-after-/compact",
    says: "Project-root CLAUDE.md survives compaction: after `/compact`, Claude re-reads it from disk",
  },
  {
    id: "agents-md-default",
    screens: ["instructions"],
    title: "One AGENTS.md can serve Claude Code and Codex",
    body: "Claude Code reads a project's AGENTS.md when there's no CLAUDE.md in the folder or above it, so a repository set up for other agents works as it is.",
    slug: "memory",
    anchor: "agents-md",
    says: "so a repository already set up for other coding agents works without adding a `CLAUDE.md`",
  },
  {
    id: "local-md",
    screens: ["instructions"],
    title: "CLAUDE.local.md is for notes only you need",
    body: "It loads next to the project's CLAUDE.md and is treated the same way. Add it to .gitignore so it stays on your Mac.",
    slug: "memory",
    says: "It loads alongside `CLAUDE.md` and is treated the same way.",
  },
  {
    id: "memory-limit",
    screens: ["memory"],
    title: "Only the top of MEMORY.md loads",
    body: "Each session loads the first 200 lines or 25 KB of MEMORY.md, whichever comes first. Claude moves detail into topic files to stay under it.",
    slug: "memory",
    anchor: "how-it-works",
    says: "The first 200 lines of `MEMORY.md`, or the first 25KB, whichever comes first, are loaded at the start of every conversation.",
  },
  {
    id: "model-switch",
    screens: ["settings"],
    title: "Switching models costs one slow turn",
    body: "Each model keeps its own prompt cache. After /model, the next turn re-reads the whole conversation without the cache: slower and dearer, once.",
    slug: "prompt-caching",
    anchor: "switching-models",
    says: "Each model has its own cache.",
  },
  {
    id: "effort-switch",
    screens: ["settings"],
    title: "Changing effort mid-session costs a slow turn",
    body: "On most models, a new effort level means the next turn reads the whole conversation with no cache hits. Set it at the start of a session instead.",
    slug: "prompt-caching",
    anchor: "changing-effort-level",
    says: "mid-session means the next request reads the entire conversation history with no cache hits",
  },
  {
    id: "precedence",
    screens: ["settings"],
    title: "Which settings file wins",
    body: "Highest first: your organization's managed settings, command-line flags, .claude/settings.local.json, .claude/settings.json, then ~/.claude/settings.json.",
    slug: "settings",
    anchor: "settings-precedence",
    says: "In order, highest precedence first:",
  },
  {
    id: "style-switch",
    screens: ["styles"],
    title: "A new output style starts with your next message",
    body: "Switching styles mid-session keeps the prompt cache: Claude Code sends the new style as a message instead of changing the system prompt.",
    slug: "prompt-caching",
    anchor: "changing-output-style",
    says: "Claude uses the new style starting with your next message",
  },
  {
    id: "skills-cache",
    screens: ["skills"],
    title: "Calling a skill doesn't touch the cache",
    body: "A skill's instructions arrive as a message at the point you call it. Nothing earlier in the conversation changes, unless the skill names a different model.",
    slug: "prompt-caching",
    anchor: "invoking-skills-and-commands",
    says: "inject their instructions as user messages at the point of invocation",
  },
  {
    id: "subagent-cache",
    screens: ["agents"],
    title: "A subagent warms a cache of its own",
    body: "A subagent starts a new conversation with its own system prompt, so it doesn't read yours from the cache, and it leaves yours as it was.",
    slug: "prompt-caching",
    anchor: "subagents-and-the-cache",
    says: "The parent's cache is unaffected.",
  },
  {
    id: "cache-lifetime",
    screens: ["sessions", "history"],
    title: "The first turn after a break is slower",
    body: "The prompt cache expires after a gap: an hour on a Claude plan within its usage, five minutes on an API key. Past that, the next turn rebuilds it.",
    slug: "prompt-caching",
    anchor: "which-ttl-each-request-gets",
    says: "Claude Code requests the one-hour TTL only on a Claude subscription within your plan's included usage",
  },
  {
    id: "compact-cold",
    screens: ["sessions"],
    title: "/compact costs most on an old session",
    body: "While the cache is warm, /compact reads your history from it cheaply. After a long break it has to process the whole history again first.",
    slug: "prompt-caching",
    anchor: "compacting-the-conversation",
    says: "This is why `/compact` costs the most when you",
  },
];

/** The tips whose sentence the current documentation still says. */
export function tips(): Tip[] {
  return TIP_SOURCES.filter((t) => docSays(t.slug, t.says)).map(({ slug, anchor, says: _says, ...t }) => ({ ...t, doc: docRef(slug, anchor) }));
}
