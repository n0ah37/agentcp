import fs from "node:fs";
import path from "node:path";

import { captureCodexDocs, captureDocs, captureOpencodeDocs } from "../engine/lib/docs-fetch.ts";
import { REPO_ROOT } from "../engine/lib/paths.ts";

/**
 * The checks cite the current Claude Code, Codex and OpenCode documentation, and the
 * tests verify every citation still resolves, so they need a capture. It is
 * not kept in git; download one the first time (the same thing `pnpm run docs`
 * does).
 */
export default async function setup() {
  const dir = path.join(REPO_ROOT, "vendor", "docs");
  if (!fs.existsSync(path.join(dir, "manifest.json"))) {
    console.log("Downloading the Claude Code documentation for the tests…");
    await captureDocs(dir);
  }
  if (!fs.existsSync(path.join(dir, "codex-manifest.json"))) {
    console.log("Downloading the Codex documentation for the tests…");
    await captureCodexDocs(dir);
  }
  if (!fs.existsSync(path.join(dir, "opencode-manifest.json"))) {
    console.log("Downloading the OpenCode documentation for the tests…");
    await captureOpencodeDocs(dir);
  }
}
