import fs from "node:fs";
import path from "node:path";

import type { DocPage, DocRef, DocSearchHit, DocsInfo } from "../../shared/types.ts";
import { offeredAgents } from "./agents.ts";
import { OPENCODE_DOCS_SOURCE, captureCodexDocs, captureDocs, captureOpencodeDocs, type CapturedPage, type DocsManifest } from "./docs-fetch.ts";
import { APP_DIR, REPO_ROOT } from "./paths.ts";

/**
 * The Claude Code documentation, as captured by docs-fetch.ts. Every check the
 * app runs cites a section here, and every explanation the app shows is quoted
 * from here, so the corpus is read at runtime rather than copied into code.
 *
 * Two copies can exist: the one shipped with the app (or, in development, the
 * repo's gitignored vendor/docs), and one downloaded into ~/.agentcp
 * by setup or "Update now". The newer capture wins.
 */

type Heading = { level: number; text: string; anchor: string; line: number };
type Indexed = { page: CapturedPage; text: string; headings: Heading[] };

const EMPTY: DocsManifest = { fetchedAt: "", source: "", count: 0, pages: [] };

/**
 * Three corpora share a folder: Claude Code's pages under claude-code/ with
 * manifest.json, Codex's under codex/ with codex-manifest.json, OpenCode's
 * under opencode/ with opencode-manifest.json. A Codex slug starts with
 * `codex/` and an OpenCode one with `opencode/`, which is how every lookup
 * tells them apart.
 */
type Corpus = "claude" | "codex" | "opencode";
const CORPORA: Record<Corpus, { folder: string; manifest: string }> = {
  claude: { folder: "claude-code", manifest: "manifest.json" },
  codex: { folder: "codex", manifest: "codex-manifest.json" },
  opencode: { folder: "opencode", manifest: "opencode-manifest.json" },
};
const corpusOf = (slug: string): Corpus => (slug.startsWith("codex/") ? "codex" : slug.startsWith("opencode/") ? "opencode" : "claude");
/** A page's file under its corpus folder. */
const fileOf = (slug: string): string => slug.replace(/^(codex|opencode)\//, "");

/** Where downloads go. */
export const OWN_DOCS = path.join(APP_DIR, "docs");

function candidates(): string[] {
  if (process.env.ACP_DOCS) return [path.resolve(process.env.ACP_DOCS)];
  const shipped = process.env.ACP_BUNDLED_DOCS ? path.resolve(process.env.ACP_BUNDLED_DOCS) : path.join(REPO_ROOT, "vendor", "docs");
  return [OWN_DOCS, shipped];
}

const current: Partial<Record<Corpus, { dir: string; manifest: DocsManifest; mtime: number }>> = {};
const pages = new Map<string, Indexed>();

function readManifest(dir: string, c: Corpus): { manifest: DocsManifest; mtime: number } | null {
  try {
    const file = path.join(dir, CORPORA[c].manifest);
    const st = fs.statSync(file);
    const m = JSON.parse(fs.readFileSync(file, "utf8")) as DocsManifest;
    return Array.isArray(m.pages) ? { manifest: m, mtime: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** The newer capture of one corpus. */
function load(c: Corpus = "claude"): { dir: string; manifest: DocsManifest } {
  let best: { dir: string; manifest: DocsManifest; mtime: number } | null = null;
  for (const dir of candidates()) {
    const r = readManifest(dir, c);
    // A capture of OpenCode 1's docs (opencode.ai/docs, before 2026-10-05) isn't the one these rules quote.
    if (r && c === "opencode" && r.manifest.source !== OPENCODE_DOCS_SOURCE) continue;
    if (r && (!best || r.manifest.fetchedAt > best.manifest.fetchedAt)) best = { dir, ...r };
  }
  if (!best) return { dir: "", manifest: EMPTY };
  const cur = current[c];
  if (!cur || cur.dir !== best.dir || cur.mtime !== best.mtime) {
    current[c] = best;
    for (const k of [...pages.keys()]) if (corpusOf(k) === c) pages.delete(k);
  }
  return current[c]!;
}

export function reloadDocs(): void {
  delete current.claude;
  delete current.codex;
  delete current.opencode;
  pages.clear();
}

function info(c: Corpus): { capturedAt: string | null; pages: number; ageDays: number | null; where: DocsInfo["where"] } {
  const { dir, manifest: m } = load(c);
  if (!m.count) return { capturedAt: null, pages: 0, ageDays: null, where: "none" };
  const age = Math.floor((Date.now() - new Date(m.fetchedAt + "T00:00:00").getTime()) / 86_400_000);
  return { capturedAt: m.fetchedAt, pages: m.count, ageDays: Math.max(0, age), where: dir === OWN_DOCS ? "downloaded" : "shipped" };
}

export function docsInfo(): DocsInfo {
  const cx = info("codex");
  const oc = info("opencode");
  return { ...info("claude"), codex: { capturedAt: cx.capturedAt, pages: cx.pages, ageDays: cx.ageDays }, opencode: { capturedAt: oc.capturedAt, pages: oc.pages, ageDays: oc.ageDays } };
}

/** cli.json's schema (opencode.ai/v2/cli.json), captured beside OpenCode's pages. */
export function opencodeCliSchema(): unknown {
  const { dir } = load("opencode");
  if (!dir) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, CORPORA.opencode.folder, "cli.schema.json"), "utf8"));
  } catch {
    return null;
  }
}

let downloading: Promise<DocsInfo> | null = null;

/**
 * Downloads fresh captures of every agent's docs into ~/.agentcp/docs. One
 * download at a time. Codex or OpenCode failing keeps its previous copy and
 * doesn't hold back Claude Code's.
 */
export function updateDocs(): Promise<DocsInfo> {
  downloading ??= Promise.all([captureDocs(OWN_DOCS), captureCodexDocs(OWN_DOCS).catch(() => null), offeredAgents().includes("opencode") ? captureOpencodeDocs(OWN_DOCS).catch(() => null) : null])
    .then(() => {
      reloadDocs();
      return docsInfo();
    })
    .finally(() => {
      downloading = null;
    });
  return downloading;
}

/**
 * Mintlify's heading ids, as read off the live site on 2026-09-30: lowercase,
 * a dot becomes a dash (CLAUDE.md → claude-md), other punctuation is dropped,
 * spaces become dashes, runs of dashes collapse, slashes stay.
 */
export function anchorFor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*~]/g, "")
    .replace(/\./g, "-")
    .replace(/[^\p{L}\p{N}\s\-/_]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Codex's site (learn.chatgpt.com) ids headings the GitHub way, read off the
 * live hooks page on 2026-10-01: lowercase, punctuation dropped (a dot too, so
 * requirements.toml → requirementstoml), each space a dash, dashes kept as
 * they are.
 */
export function codexAnchorFor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[^\p{L}\p{N}\s\-_]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

function indexPage(dir: string, page: CapturedPage): Indexed | null {
  const hit = pages.get(page.slug);
  if (hit) return hit;
  const c = corpusOf(page.slug);
  const file = path.join(dir, CORPORA[c].folder, `${fileOf(page.slug)}.md`);
  // OpenCode's site ids headings as GitHub does, numbering a repeat: options, options-1.
  const used = new Map<string, number>();
  const anchor =
    c === "claude"
      ? anchorFor
      : c === "codex"
        ? codexAnchorFor
        : (h: string) => {
            const a = codexAnchorFor(h);
            const n = used.get(a) ?? 0;
            used.set(a, n + 1);
            return n ? `${a}-${n}` : a;
          };
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const headings: Heading[] = [];
  let fence = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) return;
    const m = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
    if (m) headings.push({ level: m[1].length, text: m[2], anchor: anchor(m[2]), line: i });
  });
  const entry = { page, text, headings };
  pages.set(page.slug, entry);
  return entry;
}

function find(slug: string): Indexed | null {
  const { dir, manifest } = load(corpusOf(slug));
  const page = manifest.pages.find((p) => p.slug === slug);
  return page ? indexPage(dir, page) : null;
}

const SITE = "https://code.claude.com/docs/en/";

/** A citation, with the heading resolved against the current capture. */
export function docRef(slug: string, anchor?: string): DocRef {
  const p = find(slug);
  const h = anchor ? p?.headings.find((x) => x.anchor === anchor) : undefined;
  const c = corpusOf(slug);
  const base = c === "codex" ? (p?.page.url ?? "https://learn.chatgpt.com/docs/" + fileOf(slug)) : c === "opencode" ? (p?.page.url ?? `https://opencode.ai/v2/docs/${fileOf(slug)}/`) : SITE + slug;
  return {
    slug,
    anchor,
    heading: h ? plain(h.text) : anchor ? undefined : p ? plain(p.page.title) : undefined,
    url: base + (anchor ? `#${anchor}` : ""),
  };
}

/** Whether the page still says `phrase` (whitespace and case folded). */
export function docSays(slug: string, phrase: string): boolean {
  const p = find(slug);
  if (!p) return false;
  const norm = (s: string) => s.replace(/\s+/g, " ").toLowerCase();
  return norm(p.text).includes(norm(phrase));
}

/** The markdown under one heading, up to the next heading of the same or higher level. */
export function section(slug: string, anchor: string): string | null {
  const p = find(slug);
  if (!p) return null;
  const idx = p.headings.findIndex((h) => h.anchor === anchor);
  if (idx === -1) return null;
  const h = p.headings[idx];
  const next = p.headings.slice(idx + 1).find((x) => x.level <= h.level);
  const lines = p.text.split("\n");
  return lines.slice(h.line, next ? next.line : lines.length).join("\n");
}

/** The first paragraph under a heading, as plain text. */
export function lead(slug: string, anchor?: string): string {
  const body = anchor ? section(slug, anchor) : find(slug)?.text ?? null;
  if (!body) return "";
  const paras = body
    .split("\n")
    .slice(anchor ? 1 : 2)
    .join("\n")
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#") && !s.startsWith("<") && !s.startsWith("|") && !s.startsWith("```") && !s.startsWith("Source:"));
  return plain(paras[0] ?? "");
}

export function plain(md: string): string {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function page(slug: string): DocPage | null {
  const p = find(slug);
  if (!p) return null;
  return {
    slug,
    title: p.page.title,
    url: p.page.url,
    fetchedAt: p.page.fetchedAt,
    markdown: p.text,
  };
}

/** Raw page text, for parsers that read reference tables. */
export function pageText(slug: string): string | null {
  return find(slug)?.text ?? null;
}

export function searchDocs(q: string, limit = 20): DocSearchHit[] {
  const needle = q.trim().toLowerCase();
  if (needle.length < 2) return [];
  const hits: (DocSearchHit & { score: number })[] = [];
  for (const c of ["claude", "codex", "opencode"] as const) {
  const { dir, manifest } = load(c);
  for (const pg of manifest.pages) {
    const title = pg.title.toLowerCase();
    if (title.includes(needle)) {
      hits.push({ slug: pg.slug, title: pg.title, heading: null, anchor: null, snippet: pg.url, score: 10 + (title.startsWith(needle) ? 3 : 0) });
    }
    const ix = indexPage(dir, pg);
    if (!ix) continue;
    for (const h of ix.headings) {
      const t = plain(h.text);
      if (t.toLowerCase().includes(needle)) hits.push({ slug: pg.slug, title: pg.title, heading: t, anchor: h.anchor, snippet: "", score: 6 });
    }
  }
  }
  hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return hits.slice(0, limit).map((h) => ({ slug: h.slug, title: h.title, heading: h.heading, anchor: h.anchor, snippet: h.snippet }));
}

/** Build the search index ahead of the first query; it reads every page once. */
export function warmDocs(): void {
  setTimeout(() => {
    try {
      searchDocs("warm-up");
    } catch {
      /* no docs captured yet */
    }
  }, 50);
}
