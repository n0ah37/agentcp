import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { LIMITS, checkDefinition, checkInstruction, findImports } from "../engine/lib/checks.ts";
import { anchorFor, docRef, docSays } from "../engine/lib/docs.ts";
import { fieldsFor } from "../engine/lib/definitions.ts";
import { ABOUT } from "../engine/lib/files.ts";
import { forget } from "../engine/lib/git.ts";
import { combinedView, resolveStack } from "../engine/lib/instructions.ts";
import { cutLine, memoryView, parseIndex } from "../engine/lib/memory.ts";
import { CLAUDE_DIR, HOME, encodeProjectDir } from "../engine/lib/paths.ts";
import { getPrefs, setPrefs } from "../engine/lib/prefs.ts";
import { projectRef } from "../engine/lib/projects.ts";
import { planSetting, settingsCatalog } from "../engine/lib/settings.ts";
import { TIP_SOURCES } from "../engine/lib/tips.ts";
import { WriteError, applyRename, applyWrite, listHistory, planRename, planWrite, refusalFor } from "../engine/lib/write.ts";
import { hashText } from "../engine/lib/fsx.ts";

const write = (p: string, text: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-C", cwd, ...args], { stdio: "ignore" });

let n = 0;
function repo(files: Record<string, string>, opts: { commit?: boolean } = {}): string {
  const dir = path.join(HOME, "Dev", `repo-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) write(path.join(dir, rel), text);
  git(dir, "init", "-q");
  if (opts.commit) {
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");
  }
  forget();
  return dir;
}

const userSettings = (data: object) => write(path.join(CLAUDE_DIR, "settings.json"), JSON.stringify(data));

beforeAll(() => {
  expect(HOME).toContain("acp-test-home");
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

beforeEach(() => {
  userSettings({});
  forget();
});

describe("the documentation the checks cite", () => {
  const cited: [string, string, string][] = [
    ["memory", "write-effective-instructions", "target under 200 lines per CLAUDE.md file"],
    ["memory", "import-additional-files", "A path wrapped in quotes isn't imported at all"],
    ["memory", "import-additional-files", "maximum depth of four hops"],
    ["memory", "import-additional-files", "Add `CLAUDE.local.md` to your `.gitignore`"],
    ["memory", "when-claude-code-reads-agents-md", "By default, Claude reads `AGENTS.md` only when you have no `CLAUDE.md`"],
    ["memory", "share-one-file-with-other-coding-tools", "refuse to write through a symlink"],
    ["memory", "how-it-works", "The first 200 lines of `MEMORY.md`, or the first 25KB"],
    ["memory", "choose-which-instruction-files-load", "claude-md-and-agents-md"],
    ["skills", "frontmatter-reference", "truncated at 1,536 characters"],
    ["skills", "frontmatter-reference", "If the YAML between the markers doesn't parse, the skill still loads with no fields set"],
    ["sub-agents", "frontmatter-reference", "Only `name` and `description` are required"],
    ["output-styles", "frontmatter-reference", "A misspelled field is ignored without an error"],
  ];

  // When this fails after a docs refresh, a check is built on a sentence that moved: review it.
  it.each(cited)("%s#%s still says what the check relies on", (slug, anchor, says) => {
    expect(docRef(slug, anchor).heading, `${slug}#${anchor} heading`).toBeTruthy();
    expect(docSays(slug, says)).toBe(true);
  });

  // The "Did you know?" card is held to the same rule as the checks.
  it.each(TIP_SOURCES.map((t) => [t.id, t] as const))("tip %s still rests on a sentence the docs say", (_id, t) => {
    if (t.anchor) expect(docRef(t.slug, t.anchor).heading, `${t.slug}#${t.anchor} heading`).toBeTruthy();
    expect(docSays(t.slug, t.says), t.says).toBe(true);
    expect(t.title.length, "a title fits the card").toBeLessThanOrEqual(56);
    expect(t.body.length, "a body fits the card").toBeLessThanOrEqual(190);
  });

  it("resolves every section the inspector links to", () => {
    for (const [kind, a] of Object.entries(ABOUT)) expect(a.doc().heading, kind).toBeTruthy();
  });

  it("makes Mintlify's anchors", () => {
    expect(anchorFor("Organize rules with `.claude/rules/`")).toBe("organize-rules-with-claude/rules/");
    expect(anchorFor("When Claude Code reads AGENTS.md")).toBe("when-claude-code-reads-agents-md");
    expect(anchorFor("Use the `--advisor` flag")).toBe("use-the-advisor-flag");
    expect(anchorFor("Set up a project CLAUDE.md")).toBe("set-up-a-project-claude-md");
  });

  it("reads the documented frontmatter fields", () => {
    expect(fieldsFor("agent").map((f) => f.name)).toEqual(expect.arrayContaining(["name", "description", "tools", "model"]));
    expect(fieldsFor("agent").find((f) => f.name === "name")?.required).toBe("yes");
    expect(fieldsFor("skill").map((f) => f.name)).toEqual(expect.arrayContaining(["description", "when_to_use", "allowed-tools"]));
    expect(fieldsFor("style").map((f) => f.name)).toContain("keep-coding-instructions");
  });

  it("parses every settings key from the reference", () => {
    const { entries, topics } = settingsCatalog();
    expect(entries.length).toBeGreaterThan(200);
    expect(topics.length).toBeGreaterThan(10);
    const effort = entries.find((e) => e.key === "effortLevel");
    expect(effort?.control.type).toBe("enum");
    expect(effort?.control.type === "enum" && effort.control.options.map((o) => o.value)).toContain("high");
    expect(entries.find((e) => e.key === "autoMemoryEnabled")?.control.type).toBe("boolean");
    expect(entries.find((e) => e.key === "askUserQuestionTimeout")?.allowed).toEqual(["user"]);
  });
});

describe("imports", () => {
  it("skips code, keeps quotes as not imported, and unescapes spaces", () => {
    const imps = findImports(["See @README and @docs/a.md.", "`@not/this.md`", "```", "@nor/this.md", "```", 'Quoted @"x y.md"', "Escaped @Design\\ Docs/api.md", "mail me@host.com or ping @claude"].join("\n"));
    expect(imps.map((i) => [i.target, i.quoted])).toEqual([
      ["README", false],
      ["docs/a.md", false],
      ["x y.md", true],
      ["Design Docs/api.md", false],
    ]);
  });
});

describe("which instruction files load", () => {
  it("reads CLAUDE.md, not AGENTS.md, when both exist (the default)", async () => {
    const dir = repo({ "CLAUDE.md": "# C\n", "AGENTS.md": "# A\n" });
    const { entries } = await resolveStack(await projectRef(dir));
    expect(entries.find((e) => e.file.path === path.join(dir, "CLAUDE.md"))?.loads).toBe("launch");
    const agents = entries.find((e) => e.file.path === path.join(dir, "AGENTS.md"));
    expect(agents?.loads).toBe("not-read");
    expect(agents?.counts.warning).toBe(1);
  });

  it("reads AGENTS.md when there is no CLAUDE.md", async () => {
    const dir = repo({ "AGENTS.md": "# A\n" });
    const { entries } = await resolveStack(await projectRef(dir));
    expect(entries.find((e) => e.file.path === path.join(dir, "AGENTS.md"))?.loads).toBe("launch");
  });

  it("counts CLAUDE.local.md as a CLAUDE.md for that rule", async () => {
    const dir = repo({ "CLAUDE.local.md": "# L\n", "AGENTS.md": "# A\n" });
    const { entries } = await resolveStack(await projectRef(dir));
    expect(entries.find((e) => e.file.name === "AGENTS.md")?.loads).toBe("not-read");
  });

  it("reads both when Project instructions says so, from user settings only", async () => {
    const dir = repo({ "CLAUDE.md": "# C\n", "AGENTS.md": "# A\n" });
    write(path.join(dir, ".claude", "settings.json"), JSON.stringify({ pluginConfigs: { "agents-md@builtin": { options: { instructionFiles: "claude-md-and-agents-md" } } } }));
    let { entries } = await resolveStack(await projectRef(dir));
    expect(entries.find((e) => e.file.name === "AGENTS.md")?.loads).toBe("not-read");
    userSettings({ pluginConfigs: { "agents-md@builtin": { options: { instructionFiles: "claude-md-and-agents-md" } } } });
    ({ entries } = await resolveStack(await projectRef(dir)));
    expect(entries.find((e) => e.file.name === "AGENTS.md")?.loads).toBe("launch");
  });

  it("nests imports under their file and stops after four hops", async () => {
    const dir = repo({ "CLAUDE.md": "@a.md\n", "a.md": "@b.md\n", "b.md": "@c.md\n", "c.md": "@d.md\n", "d.md": "@e.md\n", "e.md": "end\n" });
    const { entries, findings } = await resolveStack(await projectRef(dir));
    const names = entries.filter((e) => e.file.kind === "import").map((e) => [e.file.name, e.depth]);
    expect(names).toEqual([["a.md", 1], ["b.md", 2], ["c.md", 3], ["d.md", 4]]);
    expect(findings.get(path.join(dir, "d.md"))?.some((f) => f.id.startsWith("import:depth"))).toBe(true);
  });

  it("puts path-scoped rules and nested CLAUDE.md files on demand", async () => {
    const dir = repo({ "CLAUDE.md": "# C\n", ".claude/rules/ts.md": '---\npaths: ["src/**/*.ts"]\n---\nUse strict.\n', ".claude/rules/all.md": "Always.\n", "packages/api/CLAUDE.md": "# API\n" });
    const { entries } = await resolveStack(await projectRef(dir));
    const by = (n: string) => entries.find((e) => e.file.path.endsWith(n))?.loads;
    expect(by("rules/ts.md")).toBe("on-demand");
    expect(by("rules/all.md")).toBe("launch");
    expect(by("packages/api/CLAUDE.md")).toBe("on-demand");
  });

  it("loads a rule with broken frontmatter everywhere and says so", async () => {
    const dir = repo({ ".claude/rules/bad.md": '---\npaths: ["src/**"\n---\nX\n' });
    const { entries, findings } = await resolveStack(await projectRef(dir));
    const rule = entries.find((e) => e.file.name === "bad.md");
    expect(rule?.loads).toBe("launch");
    expect(findings.get(rule!.file.path)?.map((f) => f.id)).toContain("rule:yaml");
  });

  it("applies claudeMdExcludes", async () => {
    const dir = repo({ "CLAUDE.md": "# C\n", "vendor-team/CLAUDE.md": "# other\n" });
    userSettings({ claudeMdExcludes: ["**/vendor-team/CLAUDE.md"] });
    const { entries } = await resolveStack(await projectRef(dir));
    expect(entries.find((e) => e.file.path.endsWith("vendor-team/CLAUDE.md"))?.loads).toBe("not-read");
  });

  it("places every file on a level of the folder hierarchy, top down", async () => {
    // A folder of its own, so its CLAUDE.md doesn't sit above the other tests' repositories.
    write(path.join(HOME, "Work", "CLAUDE.md"), "# Work\n");
    const dir = path.join(HOME, "Work", "shop");
    for (const [rel, text] of Object.entries({ "CLAUDE.md": "# Shop\n", "CLAUDE.local.md": "# me\n", "packages/api/CLAUDE.md": "# API\n", "packages/api/db/CLAUDE.md": "# DB\n" })) write(path.join(dir, rel), text);
    git(dir, "init", "-q");
    forget();
    const { levels, entries } = await resolveStack(await projectRef(dir));
    expect(levels.map((l) => [l.kind, l.label, l.depth])).toEqual([
      ["user", "~/.claude", 0],
      ["folder", "~/Work", 0],
      ["project", "shop", 0],
      ["subfolder", "packages/api/", 1],
      ["subfolder", "db/", 2],
    ]);
    const level = (rel: string) => entries.find((e) => e.file.path === path.join(dir, rel))?.level;
    expect(entries.find((e) => e.file.path === path.join(HOME, "Work", "CLAUDE.md"))?.level).toBe(`dir:${path.join(HOME, "Work")}`);
    expect(level("CLAUDE.md")).toBe(`dir:${dir}`);
    expect(level("CLAUDE.local.md")).toBe(`dir:${dir}`);
    expect(level("packages/api/db/CLAUDE.md")).toBe(`dir:${path.join(dir, "packages/api/db")}`);
    expect(levels.find((l) => l.kind === "folder")?.covers).toBe("Every project under ~/Work");
  });

  it("joins the launch files in the order Claude reads them, without block comments", async () => {
    const dir = repo({ "CLAUDE.md": "# Top\n<!-- for humans only -->\nKeep it short.\n@notes.md\n", "notes.md": "Imported.\n", "sub/CLAUDE.md": "# later\n" });
    const { sections } = await combinedView(await projectRef(dir));
    const mine = sections.filter((s) => s.path.startsWith(dir));
    expect(mine.map((s) => path.relative(dir, s.path))).toEqual(["CLAUDE.md", "notes.md"]);
    expect(mine[0].text).not.toContain("for humans only");
    expect(mine[0].text).toContain("Keep it short.");
  });

  it("tells an untracked CLAUDE.local.md from a committed one", async () => {
    const loose = repo({ "CLAUDE.local.md": "# me\n" });
    let f = (await resolveStack(await projectRef(loose))).findings.get(path.join(loose, "CLAUDE.local.md"))!;
    expect(f.map((x) => x.id)).toContain("local:ignore");
    expect(f.find((x) => x.id === "local:ignore")?.fix?.kind).toBe("gitignore");
    const committed = repo({ "CLAUDE.local.md": "# me\n" }, { commit: true });
    f = (await resolveStack(await projectRef(committed))).findings.get(path.join(committed, "CLAUDE.local.md"))!;
    expect(f.map((x) => x.id)).toEqual(["local:tracked"]);
  });
});

describe("checks on one file", () => {
  const base = { bytes: 0, isSymlink: false, linkTarget: null, repoRoot: null, mode: "claude-md-or-agents-md" as const };

  it("flags a file over the 200-line target, not one at it", () => {
    const at = checkInstruction({ ...base, path: "/x/CLAUDE.md", kind: "claude-md", text: "# H\n" + "- a\n".repeat(199) });
    expect(at.find((f) => f.id === "size:lines")).toBeUndefined();
    const over = checkInstruction({ ...base, path: "/x/CLAUDE.md", kind: "claude-md", text: "# H\n" + "- a\n".repeat(200) });
    expect(over.find((f) => f.id === "size:lines")?.line).toBe(201);
  });

  it("checks backticked paths, but not owner/repo names, branches or scoped packages", () => {
    const dir = path.join(HOME, "Dev", "refs-check");
    write(path.join(dir, "src", "real.ts"), "export {};\n");
    const text = ["Repo: `acme/storefront`, branch `feature/cart`, package `@scope/pkg`.", "Code in `src/real.ts`, `src/gone.ts` and `src/lib`.", "Data in `Ledger/state.json`."].join("\n");
    const refs = checkInstruction({ ...base, path: path.join(dir, "CLAUDE.md"), kind: "claude-md", text, repoRoot: dir }).filter((f) => f.id.startsWith("ref:"));
    expect(refs.map((f) => f.subject)).toEqual(["src/gone.ts", "src/lib", "Ledger/state.json"]);
    expect(new Set(refs.map((f) => f.group))).toEqual(new Set(["paths don't exist"]));
  });

  it("suggests the field a typo meant", () => {
    const f = checkDefinition("agent", "---\nname: r\ndescription: d\nmodle: opus\n---\nBody\n", fieldsFor("agent"));
    expect(f.find((x) => x.id === "fm:unknown:modle")?.detail).toContain("model");
  });

  it("requires a subagent's name and description, and no colon in the name", () => {
    expect(checkDefinition("agent", "---\ndescription: d\n---\n", fieldsFor("agent")).map((f) => f.id)).toContain("fm:required:name");
    expect(checkDefinition("agent", "---\nname: a:b\ndescription: d\n---\n", fieldsFor("agent")).map((f) => f.id)).toContain("agent:colon");
  });

  it("names a description that needs quotes, and quoting it makes the frontmatter parse", () => {
    const text = '---\nname: build\ndescription: Software work only: repos, "builds" and deploys\n---\n# build\n';
    const f = checkDefinition("skill", text, fieldsFor("skill")).find((x) => x.id === "fm:yaml");
    expect(f?.title).toMatch(/description.*needs quotes/);
    expect(f?.line).toBe(3);
    const fix = f?.fix;
    if (fix?.kind !== "replace") throw new Error("no fix");
    const fixed = text.split("\n").map((l, i) => (i === fix.line - 1 ? l.replace(fix.from, fix.to) : l)).join("\n");
    expect(checkDefinition("skill", fixed, fieldsFor("skill")).map((x) => x.id)).not.toContain("fm:yaml");
  });

  it("warns when a skill's listing text passes 1,536 characters", () => {
    const long = "x".repeat(LIMITS.skillListing + 1);
    expect(checkDefinition("skill", `---\ndescription: ${long}\n---\n`, fieldsFor("skill")).map((f) => f.id)).toContain("skill:long");
  });
});

describe("memory", () => {
  it("cuts the index at 200 lines or 25 KB, whichever comes first", () => {
    expect(cutLine("a\n".repeat(150))).toBeNull();
    expect(cutLine("a\n".repeat(250))).toBe(200);
    expect(cutLine(("x".repeat(999) + "\n").repeat(40))).toBe(25);
  });

  it("finds index links, broken links and memories missing from the index", async () => {
    const dir = repo({ "CLAUDE.md": "# C\n" });
    const mem = path.join(CLAUDE_DIR, "projects", encodeProjectDir(fs.realpathSync(dir)), "memory");
    write(path.join(mem, "MEMORY.md"), "- [Role](user_role.md) — what I do\n- [Gone](gone.md) — deleted\n");
    write(path.join(mem, "user_role.md"), "---\nname: role\ntype: user\n---\nEngineer.\n");
    write(path.join(mem, "stray.md"), "---\ntype: project\n---\nNot indexed.\n");
    expect(parseIndex(fs.readFileSync(path.join(mem, "MEMORY.md"), "utf8")).map((l) => l.target)).toEqual(["user_role.md", "gone.md"]);
    const v = await memoryView((await projectRef(fs.realpathSync(dir)))!);
    expect(v.items.map((i) => [i.file.name, i.indexed])).toEqual([["stray.md", false], ["user_role.md", true]]);
    expect(v.broken.map((b) => b.target)).toEqual(["gone.md"]);
    expect(v.findings.map((f) => f.id)).toEqual(expect.arrayContaining(["mem:broken:2", "mem:unindexed"]));
  });
});

describe("the write path", () => {
  it("writes the user CLAUDE.md, and never anything outside home or credentials", () => {
    expect(refusalFor(path.join(CLAUDE_DIR, "CLAUDE.md"))).toBeNull();
    expect(refusalFor("/etc/hosts")).toBeTruthy();
    expect(refusalFor(path.join(HOME, ".claude.json"))).toMatch(/credentials/);
    expect(refusalFor(path.join(HOME, "Dev", "x", "src", "index.ts"))).toMatch(/instruction and configuration/);
    expect(refusalFor(path.join(HOME, "Dev", "x", "CLAUDE.md"))).toBeNull();
  });

  it("refuses while editing is off, and when the disk moved", async () => {
    const dir = repo({ "CLAUDE.md": "one\n" });
    const file = path.join(dir, "CLAUDE.md");
    const plan = await planWrite({ path: file, content: "two\n", baseHash: null });
    await setPrefs({ allowEdits: false });
    await expect(applyWrite({ path: file, content: "two\n", baseHash: plan.diskHash })).rejects.toMatchObject({ code: "disabled" });
    await setPrefs({ allowEdits: true });
    fs.writeFileSync(file, "changed elsewhere\n");
    await expect(applyWrite({ path: file, content: "two\n", baseHash: plan.diskHash })).rejects.toBeInstanceOf(WriteError);
    expect(fs.readFileSync(file, "utf8")).toBe("changed elsewhere\n");
  });

  it("snapshots before writing and keeps the old version restorable", async () => {
    await setPrefs({ allowEdits: true });
    const dir = repo({ "CLAUDE.md": "before\n" });
    const file = path.join(dir, "CLAUDE.md");
    const { diskHash } = await planWrite({ path: file, content: "after\n", baseHash: null });
    const r = await applyWrite({ path: file, content: "after\n", baseHash: diskHash });
    expect(fs.readFileSync(file, "utf8")).toBe("after\n");
    const entry = (await listHistory()).find((e) => e.id === r.historyId)!;
    expect(entry.action).toBe("save");
    expect(fs.readFileSync(entry.snapshot!, "utf8")).toBe("before\n");
    expect(fs.readdirSync(dir).filter((n) => n.includes(".acp-"))).toEqual([]);
  });

  it("saves your own ~/.claude/CLAUDE.md like any other, with a snapshot", async () => {
    await setPrefs({ allowEdits: true });
    const file = path.join(CLAUDE_DIR, "CLAUDE.md");
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    fs.writeFileSync(file, "# Mine\n");
    const plan = await planWrite({ path: file, content: "# Mine\n\nUse pnpm.\n", baseHash: null });
    expect(plan.refusal).toBeNull();
    const r = await applyWrite({ path: file, content: "# Mine\n\nUse pnpm.\n", baseHash: plan.diskHash });
    expect(fs.readFileSync(file, "utf8")).toBe("# Mine\n\nUse pnpm.\n");
    expect(fs.readFileSync((await listHistory()).find((e) => e.id === r.historyId)!.snapshot!, "utf8")).toBe("# Mine\n");
  });

  it("opens instruction files and skills as text until Formatted is chosen", async () => {
    expect((await getPrefs()).formatted).toBe(false);
    expect((await setPrefs({ formatted: true })).formatted).toBe(true);
    await setPrefs({ formatted: false });
  });

  it("renames a file in its folder, keeps its ending, and moves its memory index line", async () => {
    await setPrefs({ allowEdits: true });
    const dir = path.join(CLAUDE_DIR, "projects", "-rename-test", "memory");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "MEMORY.md"), "- [Old](old-note.md) — a note\n");
    fs.writeFileSync(path.join(dir, "old-note.md"), "body\n");
    fs.writeFileSync(path.join(dir, "taken.md"), "x\n");
    const from = path.join(dir, "old-note.md");
    expect((await planRename({ from, name: "taken" })).refusal).toMatch(/already/);
    expect((await planRename({ from, name: "a/b" })).refusal).toMatch(/can't contain/);
    expect((await planRename({ from: path.join(dir, "MEMORY.md"), name: "INDEX" })).refusal).toMatch(/read by that name/);
    const plan = await planRename({ from, name: "new-note" });
    expect(plan).toMatchObject({ refusal: null, to: path.join(dir, "new-note.md") });
    expect(plan.alsoUpdates).toHaveLength(1);
    await expect(applyRename({ from, name: "new-note", baseHash: "stale" })).rejects.toMatchObject({ code: "conflict" });
    await applyRename({ from, name: "new-note", baseHash: hashText("body\n") });
    expect(fs.existsSync(from)).toBe(false);
    expect(fs.readFileSync(path.join(dir, "new-note.md"), "utf8")).toBe("body\n");
    expect(fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8")).toBe("- [Old](new-note.md) — a note\n");
    // History can undo it: the old name was snapshotted as a delete.
    const del = (await listHistory()).find((e) => e.path === from && e.action === "delete")!;
    expect(fs.readFileSync(del.snapshot!, "utf8")).toBe("body\n");
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it("writes through a link to its target and keeps the link", async () => {
    await setPrefs({ allowEdits: true });
    const dir = repo({ "AGENTS.md": "shared\n" });
    fs.symlinkSync("AGENTS.md", path.join(dir, "CLAUDE.md"));
    const link = path.join(dir, "CLAUDE.md");
    const { diskHash, writesTo } = await planWrite({ path: link, content: "edited\n", baseHash: null });
    expect(writesTo).toMatch(/AGENTS\.md$/);
    await applyWrite({ path: link, content: "edited\n", baseHash: diskHash });
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe("edited\n");
  });

  it("refuses a key in a file Claude Code ignores it in", async () => {
    const dir = repo({});
    const { plan } = await planSetting(dir, "project", ["askUserQuestionTimeout"], 30, null);
    expect(plan.refusal).toMatch(/ignores it/);
    const ok = await planSetting(dir, "local", ["effortLevel"], "high", null);
    expect(ok.plan.refusal).toBeNull();
    expect(JSON.parse(ok.content)).toEqual({ effortLevel: "high" });
  });
});

describe("test isolation", () => {
  it("runs in a temporary home", () => {
    expect(HOME.startsWith(os.tmpdir())).toBe(true);
  });
});
