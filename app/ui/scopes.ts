/**
 * The one set of names for where a setting or definition lives
 * (2026-10-01): the place first, then who it's for. `label` is for menus
 * and lists; `where` finishes a sentence ("Set model in this project, for
 * everyone?").
 */
export const SCOPE = {
  user: { label: "User", where: "in your user settings" },
  project: { label: "This project (everyone)", where: "in this project, for everyone" },
  local: { label: "This project (just you)", where: "in this project, just for you" },
  managed: { label: "Organization", where: "in your organization's settings" },
} as const;

/** Codex has two files you write: yours and the project's. */
export const CODEX_SCOPE = {
  user: { label: "User", where: "in your Codex config" },
  project: { label: "This project", where: "in this project's Codex config" },
} as const;
