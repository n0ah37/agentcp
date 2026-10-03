/** Files the agents read by name: renaming one would make them stop reading it. Shared by the engine's check and the menu. */
export const FIXED_NAMES = /^(CLAUDE\.md|CLAUDE\.local\.md|AGENTS\.md|AGENTS\.override\.md|SKILL\.md|MEMORY\.md|settings(\.local)?\.json|config\.toml|hooks\.json|\.gitignore)$/;
