import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Downloads the Claude Code and Codex documentation and writes one file per
 * page. Both are the app's source for what each agent reads and what each
 * setting does; nothing about either agent is learned from this Mac.
 *
 * code.claude.com publishes every page concatenated in one llms-full.txt,
 * each page opening with "# <title>" and "Source: <url>". A page is written at
 * the path its URL has under /docs/en/, so .../en/agent-sdk/skills becomes
 * claude-code/agent-sdk/skills.md and cannot overwrite .../en/skills (keying
 * pages by their last URL segment did exactly that until 2026-09-30).
 *
 * The capture is not kept in git: the app downloads it during setup and on
 * "Update now", and a build bundles the copy it was built with.
 */

export const DOCS_SOURCE = "https://code.claude.com/docs/llms-full.txt";

export type CapturedPage = { slug: string; title: string; url: string; bytes: number; sha256: string; fetchedAt: string };
export type DocsManifest = { fetchedAt: string; source: string; count: number; pages: CapturedPage[] };

/** The page's path under /docs/en/, without an extension. */
export function slugFor(url: string): string {
  let p = url.replace(/^https?:\/\/[^/]+/, "").split("#")[0].split("?")[0];
  p = p.replace(/^\/docs\/(en\/)?/, "").replace(/^\/+|\/+$/g, "").replace(/\.md$/, "");
  return p || "index";
}

export function splitBundle(text: string): { slug: string; title: string; url: string; body: string }[] {
  const marks = [...text.matchAll(/^# (.+)\nSource: (https?:\/\/\S+)[ \t]*$/gm)];
  const seen = new Set<string>();
  return marks.map((m, i) => {
    const slug = slugFor(m[2]);
    if (seen.has(slug)) throw new Error(`Two pages map to ${slug}; refusing to overwrite one with the other.`);
    seen.add(slug);
    const end = i + 1 < marks.length ? marks[i + 1].index : text.length;
    return { slug, title: m[1].trim(), url: m[2], body: text.slice(m.index, end) };
  });
}

/**
 * Captures the docs into `outDir` (claude-code/ plus manifest.json). The pages
 * are written to a fresh folder and swapped in, so a page upstream removed does
 * not linger, and a failed download leaves the previous capture untouched.
 */
export async function captureDocs(outDir: string, opts: { text?: string; today?: string } = {}): Promise<DocsManifest> {
  let text = opts.text;
  if (text === undefined) {
    const res = await fetch(DOCS_SOURCE, { signal: AbortSignal.timeout(180_000) });
    if (!res.ok) throw new Error(`code.claude.com answered ${res.status}.`);
    text = await res.text();
  }
  const pages = splitBundle(text);
  if (pages.length < (opts.text === undefined ? 50 : 1)) throw new Error(`The download held ${pages.length} pages, which looks wrong; the previous copy was kept.`);

  const today = opts.today ?? new Date().toLocaleDateString("en-CA"); // the local date, as the person reading it expects
  const final = path.join(outDir, "claude-code");
  const fresh = `${final}.new`;
  await fs.rm(fresh, { recursive: true, force: true });
  const captured: CapturedPage[] = [];
  for (const p of pages) {
    const file = path.join(fresh, `${p.slug}.md`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, p.body);
    captured.push({
      slug: p.slug,
      title: p.title,
      url: p.url,
      bytes: Buffer.byteLength(p.body),
      sha256: createHash("sha256").update(p.body).digest("hex").slice(0, 16),
      fetchedAt: today,
    });
  }
  await fs.rm(final, { recursive: true, force: true });
  await fs.rename(fresh, final);
  const manifest: DocsManifest = { fetchedAt: today, source: DOCS_SOURCE, count: captured.length, pages: captured };
  await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

/**
 * Codex's documentation, the same way. OpenAI publishes an index of every
 * Codex page (llms.txt), and each page has a Markdown twin at its URL plus
 * `.md`. A page is written at its path under /docs/, prefixed `codex/` so a
 * Codex slug never collides with a Claude Code one: .../docs/hooks becomes
 * codex/hooks.md, with the slug `codex/hooks`.
 */
export const CODEX_DOCS_SOURCE = "https://developers.openai.com/codex/llms.txt";

/** The Markdown pages an llms.txt index links to, each once, in index order. */
export function codexPagesIn(index: string): string[] {
  const seen = new Set<string>();
  for (const m of index.matchAll(/\((https:\/\/learn\.chatgpt\.com\/docs\/[^)\s]+\.md)\)/g)) {
    if (!/\/docs\/llms(-full)?\.txt/.test(m[1])) seen.add(m[1]);
  }
  return [...seen];
}

export function codexSlugFor(url: string): string {
  return "codex/" + url.replace(/^https:\/\/learn\.chatgpt\.com\/docs\//, "").replace(/\.md$/, "");
}

/** The page's first top-level heading outside a code block. */
function titleOf(md: string): string | null {
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    else if (!fence && line.startsWith("# ")) return line.slice(2).trim();
  }
  return null;
}

/** Drops the note every page opens with about where the index is. */
function cleanCodexPage(md: string): string {
  return md.replace(/^> For the complete documentation index, see .*\n\n?/m, "");
}

export async function captureCodexDocs(outDir: string, opts: { pages?: { url: string; body: string }[]; today?: string } = {}): Promise<DocsManifest> {
  let pages = opts.pages;
  if (!pages) {
    const res = await fetch(CODEX_DOCS_SOURCE, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`developers.openai.com answered ${res.status}.`);
    const urls = codexPagesIn(await res.text());
    // A few at a time: the index lists around 180 pages.
    const queue = [...urls];
    const got: { url: string; body: string }[] = [];
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        for (let url = queue.shift(); url; url = queue.shift()) {
          const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
          if (r.ok) got.push({ url, body: await r.text() });
        }
      }),
    );
    if (got.length < 50 || got.length < urls.length * 0.9) throw new Error(`Only ${got.length} of ${urls.length} Codex pages downloaded; the previous copy was kept.`);
    pages = got.sort((a, b) => urls.indexOf(a.url) - urls.indexOf(b.url));
  }

  const today = opts.today ?? new Date().toLocaleDateString("en-CA");
  const final = path.join(outDir, "codex");
  const fresh = `${final}.new`;
  await fs.rm(fresh, { recursive: true, force: true });
  const captured: CapturedPage[] = [];
  for (const p of pages) {
    const slug = codexSlugFor(p.url);
    const body = cleanCodexPage(p.body);
    const file = path.join(fresh, `${slug.slice("codex/".length)}.md`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
    captured.push({
      slug,
      title: titleOf(body) ?? (slug.split("/").pop() ?? slug).replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()),
      url: p.url.replace(/\.md$/, ""),
      bytes: Buffer.byteLength(body),
      sha256: createHash("sha256").update(body).digest("hex").slice(0, 16),
      fetchedAt: today,
    });
  }
  await fs.rm(final, { recursive: true, force: true });
  await fs.rename(fresh, final);
  const manifest: DocsManifest = { fetchedAt: today, source: CODEX_DOCS_SOURCE, count: captured.length, pages: captured };
  await fs.writeFile(path.join(outDir, "codex-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

/**
 * OpenCode's documentation, the same way. OpenCode 2 (GA 2026-09-11) is
 * documented under opencode.ai/v2/docs; opencode.ai/docs still describes
 * OpenCode 1, whose config shape 2 reads but no longer writes. The v2 site
 * publishes no sitemap or llms.txt, so the capture starts at its home page and
 * follows the links between pages; each page answers in Markdown when asked
 * for it (Accept: text/markdown), its title on the first line. A page is
 * written as opencode/<path>.md with the slug `opencode/<path>`.
 */
export const OPENCODE_DOCS_SOURCE = "https://opencode.ai/v2/docs/";
const OPENCODE_DOCS_BASE = "https://opencode.ai/v2/docs/";
/** The schema cli.json names ("Add the published JSON Schema"): Settings lists the terminal client's settings from it. */
export const OPENCODE_CLI_SCHEMA_SOURCE = "https://opencode.ai/v2/cli.json";

/** The doc pages a page links to, as their paths under /v2/docs/ ("" for the home page), each once. */
export function opencodePagesIn(html: string): string[] {
  const seen = new Set<string>();
  for (const m of html.matchAll(/href="\/v2\/docs\/?([^"#?]*)"/g)) seen.add(m[1].replace(/^\/+|\/+$/g, ""));
  return [...seen];
}

export const opencodeSlugFor = (p: string) => "opencode/" + (p || "index");

/** Drops any MDX `import` and `export const` lines; the prose is untouched. */
function cleanOpencodePage(md: string): string {
  return md.replace(/^(import\s.+from\s.+|export const .+)\n/gm, "").replace(/^\n+/, "");
}

export async function captureOpencodeDocs(
  outDir: string,
  opts: { pages?: { path: string; title: string | null; body: string }[]; cliSchema?: string; today?: string } = {},
): Promise<DocsManifest> {
  let pages = opts.pages;
  let cliSchema = opts.cliSchema;
  const headers = { "accept-language": "en" };
  if (!pages) {
    const order: string[] = [];
    const seen = new Set<string>([""]);
    const queue = [""];
    const got: { path: string; title: string | null; body: string }[] = [];
    // Breadth first from the home page; six at a time, and never more than 120 pages.
    while (queue.length && order.length < 120) {
      const batch = queue.splice(0, 6);
      await Promise.all(
        batch.map(async (p) => {
          const url = OPENCODE_DOCS_BASE + (p ? p + "/" : "");
          const [md, html] = await Promise.all([
            fetch(url, { headers: { ...headers, accept: "text/markdown" }, signal: AbortSignal.timeout(60_000) }).then((r) => (r.ok && /markdown/.test(r.headers.get("content-type") ?? "") ? r.text() : ""), () => ""),
            fetch(url, { headers, signal: AbortSignal.timeout(60_000) }).then((r) => (r.ok ? r.text() : ""), () => ""),
          ]);
          order.push(p);
          for (const next of opencodePagesIn(html)) {
            if (seen.has(next)) continue;
            seen.add(next);
            queue.push(next);
          }
          if (md.trim()) got.push({ path: p, title: /^# (.+)$/m.exec(md)?.[1]?.trim() ?? null, body: md });
        }),
      );
    }
    if (got.length < 25) throw new Error(`Only ${got.length} OpenCode pages downloaded; the previous copy was kept.`);
    pages = got.sort((a, b) => a.path.localeCompare(b.path));
  }
  if (cliSchema === undefined) {
    const r = await fetch(OPENCODE_CLI_SCHEMA_SOURCE, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`opencode.ai/v2/cli.json answered ${r.status}.`);
    cliSchema = await r.text();
    JSON.parse(cliSchema);
  }

  const today = opts.today ?? new Date().toLocaleDateString("en-CA");
  const final = path.join(outDir, "opencode");
  const fresh = `${final}.new`;
  await fs.rm(fresh, { recursive: true, force: true });
  await fs.mkdir(fresh, { recursive: true });
  const captured: CapturedPage[] = [];
  for (const p of pages) {
    const slug = opencodeSlugFor(p.path);
    const body = cleanOpencodePage(p.body);
    const file = path.join(fresh, `${slug.slice("opencode/".length)}.md`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
    const name = (p.path.split("/").pop() || "Intro").replace(/-/g, " ");
    captured.push({
      slug,
      title: p.title ?? name.replace(/^./, (c) => c.toUpperCase()),
      url: OPENCODE_DOCS_BASE + (p.path ? p.path + "/" : ""),
      bytes: Buffer.byteLength(body),
      sha256: createHash("sha256").update(body).digest("hex").slice(0, 16),
      fetchedAt: today,
    });
  }
  await fs.writeFile(path.join(fresh, "cli.schema.json"), cliSchema);
  await fs.rm(final, { recursive: true, force: true });
  await fs.rename(fresh, final);
  const manifest: DocsManifest = { fetchedAt: today, source: OPENCODE_DOCS_SOURCE, count: captured.length, pages: captured };
  await fs.writeFile(path.join(outDir, "opencode-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
