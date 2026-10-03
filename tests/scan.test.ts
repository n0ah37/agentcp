import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HOME } from "../engine/lib/paths.ts";
import { setPrefs } from "../engine/lib/prefs.ts";
import { forgetProjects, listProjects } from "../engine/lib/projects.ts";
import { forgetScan, scanAskFirst, scanFolder, scanHome, scanSettled } from "../engine/lib/scan.ts";

const at = (...p: string[]) => path.join(HOME, ...p);
const repo = (...p: string[]) => fs.mkdirSync(at(...p, ".git"), { recursive: true });
const file = (text: string, ...p: string[]) => {
  fs.mkdirSync(path.dirname(at(...p)), { recursive: true });
  fs.writeFileSync(at(...p), text);
};

beforeAll(async () => {
  repo("Work", "shop");
  repo("Work", "clients", "acme");
  file("# Notes", "Work", "clients", "acme", "CLAUDE.md");
  file("# Notes", "Work", "notes"); // a file, not a folder
  file("# Handbook", "Work", "handbook", "AGENTS.md"); // instructions without git
  repo("Work", "a", "b", "c"); // four levels down: found
  repo("Work", "a", "b", "c", "d"); // inside a repository: never looked at
  repo("Work", "x", "y", "z", "deeper"); // five levels down: too deep
  repo("Work", "node_modules", "pkg");
  repo("Work", "archive", "old");
  repo("solo");
  repo("Library", "Developer", "thing");
  repo(".config", "nvim");
  repo("Documents", "GitHub", "paper");
  fs.mkdirSync(at("Downloads"), { recursive: true });
  fs.chmodSync(at("Downloads"), 0o000);
  await setPrefs({ skipFolders: ["~/Work/archive"] });
  forgetScan();
});

afterAll(async () => {
  fs.chmodSync(at("Downloads"), 0o755);
  await setPrefs({ skipFolders: [], projectRoots: [] });
});

describe("the project search", () => {
  it("looks through the home folder, four levels down, and leaves out what it should", async () => {
    scanHome();
    const s = await scanSettled();
    expect(s.running).toBe(false);
    expect(s.error).toBeNull();
    const work = s.folders.find((f) => f.display === "~/Work")!;
    expect(work).toMatchObject({ projects: 4, withInstructions: 2 });
    expect(work.names).toEqual(["acme", "c", "handbook", "shop"]);
    // A repository in the home folder is offered as its own folder.
    expect(s.folders.find((f) => f.display === "~/solo")).toMatchObject({ projects: 1 });
    const shown = s.folders.map((f) => f.display);
    for (const never of ["~/Library", "~/.config", "~/Documents", "~/Documents/GitHub"]) expect(shown).not.toContain(never);
    expect(s.askFirst.map((a) => a.state)).toEqual(["not-asked", "not-asked", "not-asked"]);
  });

  it("searches Documents only when asked, and reports a refusal as a refusal", async () => {
    scanAskFirst("Documents");
    scanAskFirst("Desktop");
    scanAskFirst("Downloads");
    const s = await scanSettled();
    expect(s.folders.find((f) => f.display === "~/Documents/GitHub")).toMatchObject({ projects: 1, names: ["paper"] });
    expect(Object.fromEntries(s.askFirst.map((a) => [a.name, a.state]))).toEqual({ Documents: "searched", Desktop: "missing", Downloads: "refused" });
    // Earlier finds stay.
    expect(s.folders.find((f) => f.display === "~/Work")?.projects).toBe(4);
  });

  it("offers everything in a folder the person picked under that folder", async () => {
    scanFolder(at("Work", "clients"));
    const s = await scanSettled();
    expect(s.folders.find((f) => f.display === "~/Work/clients")).toMatchObject({ projects: 1, names: ["acme"] });
  });

  it("lists the same projects the search found, once the folders are chosen", async () => {
    await setPrefs({ projectRoots: ["~/Work", "~/solo", "~/Documents/GitHub"] });
    forgetProjects();
    const names = (await listProjects()).map((p) => p.display);
    for (const p of ["~/Work/shop", "~/Work/clients/acme", "~/Work/handbook", "~/Work/a/b/c", "~/solo", "~/Documents/GitHub/paper"]) expect(names).toContain(p);
    for (const p of ["~/Work/archive/old", "~/Work/x/y/z/deeper", "~/Work/a/b/c/d"]) expect(names).not.toContain(p);
  });
});
