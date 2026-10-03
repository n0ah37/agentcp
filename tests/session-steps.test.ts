import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { captureDocs, slugFor, splitBundle } from "../engine/lib/docs-fetch.ts";
import { HOME } from "../engine/lib/paths.ts";
import { classify, cleanPrompt } from "../engine/lib/session-steps.ts";

describe("reading what agents did", () => {
  it("keeps what you typed and drops what the host added", () => {
    expect(cleanPrompt("<system-reminder>x</system-reminder>\nHello")).toBe("Hello");
    expect(cleanPrompt("<command-name>/compact</command-name><command-message>compact</command-message>")).toBe("/compact");
    expect(cleanPrompt("<bash-input>pnpm dev</bash-input>")).toBe("! pnpm dev");
    expect(cleanPrompt("<local-command-caveat>Caveat</local-command-caveat>")).toBe("");
  });

  it("names each tool call by what it did", () => {
    expect(classify("Edit", '{"file_path": "/a/b.ts", "old_string": "x"}')).toMatchObject({ kind: "edit", target: "/a/b.ts" });
    expect(classify("Bash", '{"command": "git status"}')).toMatchObject({ kind: "run", target: "git status" });
    expect(classify("exec_command", '{"cmd": "ls -la"}')).toMatchObject({ kind: "run", target: "ls -la" });
    expect(classify("apply_patch", "*** Begin Patch\n*** Update File: src/x.py\n@@")).toMatchObject({ kind: "edit", target: "src/x.py" });
    expect(classify("Agent", '{"subagent_type": "Explore", "description": "Find the cart"}')).toMatchObject({ kind: "agent", tool: "Explore", target: "Find the cart" });
    expect(classify("mcp__00000000-0000-4000-8000-000000000000__notion-fetch", "{}")).toMatchObject({ kind: "other", tool: "notion fetch" });
    expect(classify("mcp__Claude_Browser__navigate", "{}").tool).toBe("Claude Browser · navigate");
    // An input cut short still names its file.
    expect(classify("Write", '{"file_path": "/a/long.md", "content": "…cut').target).toBe("/a/long.md");
  });
});

describe("downloading the documentation", () => {
  const bundle = [
    "# Memory",
    "Source: https://code.claude.com/docs/en/memory",
    "",
    "How Claude remembers.",
    "# Skills in the SDK",
    "Source: https://code.claude.com/docs/en/agent-sdk/skills",
    "",
    "SDK skills.",
    "# Skills",
    "Source: https://code.claude.com/docs/en/skills",
    "",
    "Core skills.",
  ].join("\n");

  it("keys each page by its path, so namesakes can't overwrite each other", () => {
    expect(slugFor("https://code.claude.com/docs/en/agent-sdk/skills")).toBe("agent-sdk/skills");
    expect(splitBundle(bundle).map((p) => p.slug)).toEqual(["memory", "agent-sdk/skills", "skills"]);
    expect(() => splitBundle(bundle + "\n# Again\nSource: https://code.claude.com/docs/en/skills\n")).toThrow(/Two pages map to skills/);
  });

  it("writes the pages and a manifest", async () => {
    const out = path.join(HOME, "docs-capture");
    const m = await captureDocs(out, { text: bundle, today: "2026-10-01" });
    expect(m).toMatchObject({ fetchedAt: "2026-10-01", count: 3 });
    expect(fs.readFileSync(path.join(out, "claude-code", "agent-sdk", "skills.md"), "utf8")).toContain("SDK skills.");
    expect(fs.readFileSync(path.join(out, "claude-code", "skills.md"), "utf8")).toContain("Core skills.");
    expect(JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8")).pages).toHaveLength(3);
  });
});
