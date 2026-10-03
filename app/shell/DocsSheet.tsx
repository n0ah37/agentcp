import { useEffect, useMemo, useRef } from "react";

import type { DocPage, DocRef } from "../../shared/types.ts";
import { useResource } from "../store.ts";
import { Icon } from "../ui/icons.tsx";
import { Sheet } from "../ui/kit.tsx";
import { renderDocs } from "../ui/markdown.ts";

/** Reads a page of the captured documentation beside the work, scrolled to the cited section. */
export function DocsSheet({ doc, onClose }: { doc: DocRef; onClose: () => void }) {
  const { data, error } = useResource<DocPage>(`/api/docs/page?slug=${encodeURIComponent(doc.slug)}`);
  const html = useMemo(() => (data ? renderDocs(data.markdown) : ""), [data]);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!data || !doc.anchor || !body.current) return;
    const want = doc.anchor;
    // Each site ids its headings its own way: Mintlify for Claude Code, GitHub's way for Codex.
    const slug = doc.slug.startsWith("codex/")
      ? (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s\-_]/gu, "").trim().replace(/\s/g, "-")
      : (s: string) => s.toLowerCase().replace(/[`*~]/g, "").replace(/\./g, "-").replace(/[^\p{L}\p{N}\s\-/_]/gu, "").trim().replace(/\s+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
    const h = [...body.current.querySelectorAll("h2, h3, h4, h5")].find((el) => slug(el.textContent ?? "") === want);
    if (h) {
      h.scrollIntoView({ block: "start" });
      (h as HTMLElement).style.scrollMarginTop = "12px";
    }
  }, [data, doc.anchor, doc.slug]);

  return (
    <Sheet
      width="side"
      title={data?.title ?? "Documentation"}
      subtitle={
        data ? (
          <span className="docmeta">
            Captured {new Date(data.fetchedAt + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })} ·{" "}
            <a href={doc.url} target="_blank" rel="noreferrer">
              Open on {doc.slug.startsWith("codex/") ? "learn.chatgpt.com" : "code.claude.com"} <Icon.external style={{ width: 11, height: 11, verticalAlign: -1 }} />
            </a>
          </span>
        ) : null
      }
      onClose={onClose}
    >
      {error ? <p className="muted">{error.message}</p> : !data ? <p className="muted">Opening…</p> : <div ref={body} className="docbody" dangerouslySetInnerHTML={{ __html: html }} />}
    </Sheet>
  );
}
