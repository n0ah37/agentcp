// Downloads the Claude Code, Codex and OpenCode documentation into vendor/docs
// (gitignored), the copy development, the tests and a build use. The app
// itself downloads into ~/.agentcp/docs during setup and on "Update now".
//
//   pnpm run docs
//
import path from "node:path";

import { captureCodexDocs, captureDocs, captureOpencodeDocs } from "../engine/lib/docs-fetch.ts";
import { REPO_ROOT } from "../engine/lib/paths.ts";

const out = process.argv[2] ? path.resolve(process.argv[2]) : path.join(REPO_ROOT, "vendor", "docs");
const m = await captureDocs(out);
console.log(`${m.count} Claude Code pages, captured ${m.fetchedAt} → ${path.relative(process.cwd(), out) || "."}`);
const c = await captureCodexDocs(out);
console.log(`${c.count} Codex pages, captured ${c.fetchedAt}`);
const o = await captureOpencodeDocs(out);
console.log(`${o.count} OpenCode pages and its config schema, captured ${o.fetchedAt}`);
