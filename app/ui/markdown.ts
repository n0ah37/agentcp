import { Marked } from "marked";

/**
 * Markdown for documentation and memory previews. Raw HTML in the source is
 * shown as text, never rendered: an instruction file from a cloned repository
 * is somebody else's content. Mintlify's callouts (<Note>, <Tip>, <Warning>)
 * become quotes, and its layout components are dropped.
 */

const SAFE_URL = /^(https?:|mailto:|#|\.{0,2}\/)/i;

const md = new Marked({
  gfm: true,
  renderer: {
    html(token) {
      return escape(token.text);
    },
    link(token) {
      const text = this.parser.parseInline(token.tokens);
      if (!SAFE_URL.test(token.href)) return text;
      const title = token.title ? ` title="${escape(token.title)}"` : "";
      return `<a href="${escape(token.href)}"${title} target="_blank" rel="noreferrer">${text}</a>`;
    },
    image(token) {
      return escape(token.text || "");
    },
  },
});

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function renderDocs(source: string): string {
  const cleaned = source
    .replace(/^Source: .*$/m, "")
    .replace(/<(Note|Tip|Info|Warning|Check)>\s*/g, "\n> ")
    .replace(/\s*<\/(Note|Tip|Info|Warning|Check)>/g, "\n")
    .replace(/<\/?(Steps|Step|Tabs|Tab|CardGroup|Card|Frame|AccordionGroup|Accordion|CodeGroup|BackToIndex|ReferenceFilter|span)[^>]*>/g, "")
    .replace(/ theme=\{null\}/g, "")
    .replace(/\]\(\/docs\/en\//g, "](https://code.claude.com/docs/en/");
  return md.parse(cleaned, { async: false }) as string;
}

/** An agent's reply: plain markdown, with raw HTML shown as text like everywhere else. */
export function renderMarkdown(source: string): string {
  return md.parse(source, { async: false }) as string;
}
