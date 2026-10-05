# AgentCP

AgentCP is a Mac app for every file Claude Code and Codex read (OpenCode too, built 2026-10-03 and off until it ships after 1.0) — CLAUDE.md, CLAUDE.local.md,
AGENTS.md, `.claude/rules`, imports, auto memory, subagents, output styles, skills, plugins,
MCP servers, hooks and settings — shown in the order each agent reads them and checked against
that agent's own documentation, plus the agents' sessions and usage, read from their own
session files. It stands alone: it
needs no other app. It runs against the real `~/.claude`, `~/.codex` and your projects.

## Layout

- `engine/` — Node, no DOM. The only code that reads or writes files. A plain HTTP server
  on 127.0.0.1 with a per-launch token (`x-acp-token`, or `?token=` for the event stream)
  and a Host check. `engine/lib/` holds one module per concern: `instructions.ts` (which
  files load, in what order, on which folder level, and why not), `checks.ts` (every rule,
  each citing the docs), `memory.ts`, `definitions.ts` (subagents, styles, skills),
  `settings.ts` (the catalog parsed from the settings reference, scope resolution),
  `transcripts.ts` (sessions and usage from the agents' own session files, run on a worker
  thread through `transcripts-client.ts` / `transcripts-worker.ts`), `opencode-sessions.ts`
  (OpenCode's sessions and usage, from its SQLite database), `session-steps.ts` (what
  was typed and what each tool call did), `codex.ts` (everything Codex reads:
  AGENTS.md chain, config.toml layers and its settings list, skills, agents, rules, memories,
  and sharing with Claude), `codex-docs.ts` (what the app knows about Codex, read from Codex's
  docs), `opencode.ts` and `opencode-docs.ts` (the same for OpenCode: instructions, opencode.json
  layers, its settings list from the config page and cli.json's from its schema, agents,
  commands, skills, plugins, MCP servers), `jsonc.ts` (JSON with comments), `toml-edit.ts` (line-level writes to config.toml), `hooks.ts` (both agents' hooks),
  `prompt.ts` (Write with AI's prompt), `tips.ts`, `projects.ts` (the project list), `scan.ts`
  (setup's search for projects), `setup.ts` (first-run checks), `plugins.ts` (Claude Code's
  plugins from every origin: marketplace, synced from claude.ai, skills folders), `mcp.ts`
  (both agents' MCP servers, in each agent's order), `claude.ts` (finds both agents'
  commands and versions), `agents.ts` (which agents are on), `write.ts`, `watch.ts`, `docs.ts` and `docs-fetch.ts`.
- `app/` — React 19 SPA built with Vite, CodeMirror 6 as the editor, hand-written CSS in
  `app/styles/app.css`. No component kit: no shadcn, Radix, cva or Tailwind.
- `desktop/` — the Electron app (chosen 2026-10-01). `main.ts` runs the engine in the main
  process on a free port and opens one window on it; until setup is finished it opens a
  small, fixed-size setup window instead (`?window=setup`), never an overlay on the app
  window. `preload.ts` exposes the few native abilities the UI gets (pick a folder, reveal
  a file, a native right-click menu, copy text, theme, open and finish setup, updates, menu
  commands). `updates.ts` is electron-updater on the public repo's GitHub Releases; only a
  Developer ID build updates itself. The browser build (`pnpm dev`, `pnpm start`) uses the
  same UI and API, with setup as a card over the app.
- `shared/links.ts` — the website, the public repo and the copyright, in one place.
- `shared/types.ts` — the contract between the engine and the UI.

## Invariants

- **Read before write, diff before apply, snapshot before every write.** `engine/lib/write.ts`
  is the only writer. A save carries the hash of the version the client opened and is
  refused (409) if the disk moved; writes are atomic (temp file + rename); a link is written
  at its target; every write is snapshotted and journaled to `~/.agentcp/history.jsonl`.
- **Editing is off until turned on**, and the engine enforces it, not the UI.
- **`~/.claude/CLAUDE.md` is edited like any other instruction file** (decided for 1.0 on
  2026-10-03). It reaches every project, which is what the diff before each save is for.
- **Never symlink CLAUDE.md and AGENTS.md.** Claude Code ≥ 2.1.277 reads AGENTS.md itself;
  sharing goes through the Project instructions setting or an `@AGENTS.md` import.
- **Every check cites the docs and names the sentence it relies on.** `docSays()` re-reads
  that sentence on every run; when a docs update drops it, the finding says so and
  `tests/engine.test.ts` fails. Fix the check, not the test.
- **Sessions and Usage read the agents' own session files, read-only**
  (`~/.claude/projects/*/*.jsonl`, `~/.codex/sessions/**/rollout-*.jsonl`), with a summary
  per file cached in memory by size and time and nothing indexed on disk. OpenCode keeps
  every session in one SQLite file (`$XDG_DATA_HOME/opencode/opencode.db`, else
  `~/.local/share/opencode/`, or `OPENCODE_DB`), opened read-only through `node:sqlite` and
  never as immutable, because OpenCode may be writing (WAL); its old `storage/` JSON is never
  read. Its layout comes from OpenCode's source, so every table and column is checked first,
  and an unknown layout shows nothing and says why (`openCodeStore`) rather than wrong numbers.
  The file holds one of two layouts: 1.x (`session`, `message`, `part`) or 2.x (`session_v2`,
  `session_message`); a file with `session_v2` is read as 2.x only, because 2.x leaves the 1.x
  tables it copied from beside its own.
  SQLite itself may leave an empty `-wal`/`-shm` beside the file after a read.
- **Codex comes from Codex's documentation, never from the Codex on this Mac.** Its pages are
  captured like Claude Code's (`codex/` beside `claude-code/`, `codex-manifest.json`, from the
  llms.txt index on developers.openai.com). Every Codex rule is a `RULES` entry in
  `codex-docs.ts` with the sentence it stands on, and the settings list, hook events, skill
  folders and built-in agents are parsed from the pages; `tests/codex.test.ts` fails when a
  page stops saying a sentence. The Codex files themselves are read from disk, because
  showing them is the point. The sidebar's agent picker is a route parameter (`agent=codex`)
  that every screen reads.
- **Each agent can be turned off** (2026-10-03: most people use only one). Preferences →
  Agents has a switch per agent, and setup turns on only the agents installed or used here (every
  agent when none is); at least one stays on. An agent that's off leaves the sidebar, the View menu,
  Sessions, Usage, Search and tips. `engine/lib/agents.ts` decides and `state.agents` carries it;
  in the UI, `useAgent()` (`app/agent.ts`) picks the screen's agent among the ones on, and nothing
  reads the `agent` route parameter directly. `ACP_AGENT_DIRS` limits the search for the agents'
  commands to those folders, so a test home can leave out an agent installed on this Mac.
- **Write with AI never starts anything.** It shows a prompt about the file (what it is, its
  docs page, what the app flagged) to copy into Claude Code or Codex; everyone's machine is
  different, so the person runs it where they work.
- **Usage counts each reply once.** Claude Code writes one reply as a line per part and repeats
  its usage on each; its own /stats adds every line (checked against stats-cache.json,
  2026-10-01). Subagent and workflow transcripts (`<session>/subagents/…`) count toward Usage
  but aren't sessions.
- **Secrets never leave the engine.** `~/.claude.json` holds the sign-in session: read only
  its MCP keys, never show the file in the editor, and list MCP environment variables and
  headers by name; `maskArgs` and `cleanUrl` hide secret-looking arguments and query strings.
  `tests/plugins-mcp.test.ts` fails if a value reaches a view.
- **OpenCode ships after 1.0, together with syncing** (2026-10-03). Its code is on `main`, but
  `offeredAgents()` in `engine/lib/agents.ts` leaves it out of every list unless `ACP_OPENCODE=1`
  (the tests set it; `ACP_OPENCODE=1 pnpm dev` shows it). Releasing it means removing that switch.
- **OpenCode comes from OpenCode 2's documentation, the same way** (2026-10-05). OpenCode 2 went
  GA on 2026-09-11 and is documented at opencode.ai/v2/docs; opencode.ai/docs still describes
  OpenCode 1, and opencode.ai/config.json is still 1's schema. The capture follows the links from
  the v2 home page and asks for each page as Markdown (`Accept: text/markdown`), into `opencode/`
  with `opencode-manifest.json`; cli.json's schema (opencode.ai/v2/cli.json) sits beside them as
  `opencode/cli.schema.json`. A capture of 1's docs is ignored. opencode.json's settings are read
  off the v2 config page's sections; OpenCode 1's names (provider, agent, permission, mcp.<name>…)
  come from its "Migrate from V1" page, because 2 still reads them. What 2 does differently: every
  AGENTS.md from the project up to home is read and none is a CLAUDE.md; `instructions` isn't read
  yet; config is merged from the farthest folder to the root's nearest, then every .opencode file;
  MCP servers live in `mcp.servers` and a later file replaces one whole; a skill's ID is its path.
  Every OpenCode rule is an `OC_RULES` entry in `opencode-docs.ts`; `tests/opencode.test.ts` fails
  when a page stops saying one. Where the docs and OpenCode's source disagree, the app follows the
  docs. Its config files are JSONC: read with `parseJsonc`, edited as files; Settings, MCP servers,
  Commands and Plugins list, they don't write config.
- **Codex plugins aren't listed**: Codex's docs don't say where it keeps them, and nothing
  about Codex comes from the Codex on this Mac.
- **Never present a config file as if it were reality.** Show the file that decided a
  value, and every other file that sets it.
- **Nothing is tuned to one person's Mac.** The app ships to people who don't keep code in
  `~/Dev`: project folders start empty and come from setup's search, and folder rules are generic
  (`skipFolders`, never a hard-coded folder name).
- **The project search stays in the home folder**, never `/`: four levels down, stopping at
  each repository, never entering Library, hidden folders or the media folders. Desktop,
  Documents and Downloads are searched only when the person asks, because macOS asks them
  first (TCC); a refused read is reported as refused. The purpose strings for those
  prompts are in `build.mac.extendInfo`; without them macOS refuses silently.
- **Plain, short copy.** Say what the person is looking at and
  what to do; "you" is fine; no internal nouns (surface, scope tier, resolve). Buttons name
  the outcome: Save, Restore this version, Add to .gitignore. Scopes have one set of names,
  the place first and who it's for after: User, This project (everyone),
  This project (just you), Organization; `app/ui/scopes.ts` holds them. A menu's purpose
  goes in a label beside it ("Save to"), never repeated in every option. No badges or icons
  that only decorate.
- **Instruction files and skills open as text.** Text | Formatted above the file switches every
  one of them at once, and Preferences keeps the choice (`formatted`). Memories open formatted,
  with Edit.
- **The top bar is one row, no subtitles or paths**: the screen's name over the list, the
  open file's name with Write with AI and "…" (Save appears only with changes), and the
  screen's one action. Counts and paths live in the list and the inspector.

## Documentation capture

The agents' docs are not kept in git (they made a refresh a million-line diff). Each
page is saved at its path under `/docs/en/`, so `agent-sdk/skills.md` cannot overwrite
`skills.md`, with a `manifest.json` of URL, size, hash and capture date. Copies:
`vendor/docs/` (gitignored; `pnpm run docs` fills it, the tests download it when missing, and a
build bundles it into the app) and `~/.agentcp/docs/` (setup and Update now).
The newer capture wins. Heading anchors follow Mintlify's live ids: a dot becomes a dash,
runs of dashes collapse (`anchorFor` in `docs.ts`). Codex's site ids headings the GitHub way:
punctuation dropped, dots too (`codexAnchorFor`). Codex slugs start with `codex/`. OpenCode's
site does the same and numbers a repeated heading (`options`, `options-1`); its slugs start with
`opencode/`.

## Commands

```
pnpm dev         # UI on 127.0.0.1:3100, engine on 3101, one shared token
pnpm run docs    # download the Claude Code, Codex and OpenCode documentation into vendor/docs (`pnpm docs` is pnpm's own command: it opens the homepage)
pnpm test        # engine tests, against a throwaway HOME
pnpm typecheck
pnpm lint
pnpm app         # build, then run the desktop app from this checkout
pnpm package     # build release/mac-arm64/AgentCP.app, signed ad hoc
node scripts/capture.mjs <dir> [shots.json]   # screenshots of the built app, light and dark
```

- `pnpm build` also writes `dist/licenses.json` (scripts/licenses.mjs): every package the
  bundles' source maps name, with its license, for About. The maps aren't packaged.

- `pnpm package` signs ad hoc, which runs on this Mac only; another Mac needs a Developer ID
  and notarization. Set `CSC_IDENTITY_AUTO_DISCOVERY=false` so electron-builder doesn't
  try a keychain identity first.
- In an ESM Electron entry, top-level `await` holds back the `ready` event and hangs the
  app; start work in `app.whenReady().then(…)`.
- The app window is transparent where the sidebar is (the native `sidebar` material shows
  through), so anything drawn over it must be opaque. `scripts/capture.mjs` shots are
  offscreen, have no material, and paint the sidebar solid, so they cannot show that
  kind of bug: check the real window with `screencapture -o -l <window id>` (window ids
  from Quartz's `CGWindowListCopyWindowInfo`). Run a test copy with `ACP_HOME` set to a
  scratch folder so its preferences and history aren't the real ones.
- The type is the system sans throughout (2026-10-01); there is no serif token.
- The engine runs in Electron's main process, so anything slow on it freezes every screen.
  Reading the session files (gigabytes on a busy Mac) runs on a worker thread; its bundle
  sits beside the engine's and is unpacked from app.asar (`asarUnpack`) so the worker can
  load it.
- `scripts/capture.mjs` windows appear on screen for the length of each shot's wait; keep
  waits short when someone is using the Mac.
- pnpm here refuses packages published less than two days ago (`minimumReleaseAge`); pick
  the previous release rather than adding an exclusion.
