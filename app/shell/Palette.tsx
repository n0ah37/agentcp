import { useEffect, useState } from "react";

import type { SearchHit } from "../../shared/types.ts";
import { api, qs } from "../api.ts";
import { go } from "../router.ts";
import { useDebounced } from "../store.ts";
import { Icon } from "../ui/icons.tsx";
import { useApp } from "./app-context.ts";

const KIND: Record<SearchHit["kind"], string> = { file: "File", setting: "Setting", doc: "Docs", project: "Project", session: "Session" };

/** ⌘K: files in the current project, projects, sessions, settings keys, and the documentation. */
export function Palette({ onClose }: { onClose: () => void }) {
  const { project, setProject, openDoc } = useApp();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const dq = useDebounced(q, 120);

  useEffect(() => {
    if (dq.trim().length < 2) {
      setHits([]);
      return;
    }
    let live = true;
    setSearching(true);
    api
      .get<SearchHit[]>(`/api/search${qs({ q: dq, project })}`)
      .then((h) => live && (setHits(h), setActive(0)))
      .finally(() => live && setSearching(false));
    return () => {
      live = false;
    };
  }, [dq, project]);

  const open = (h: SearchHit) => {
    onClose();
    if (h.kind === "project") setProject(h.path);
    else if (h.kind === "file") go("instructions", { project, file: h.path, agent: h.agent && h.agent !== "claude" ? h.agent : null });
    else if (h.kind === "setting") go("settings", { project, key: h.key });
    else if (h.kind === "session") go("sessions", { project, scope: "all", id: h.id });
    else openDoc({ slug: h.slug, anchor: h.anchor ?? undefined, url: `https://code.claude.com/docs/en/${h.slug}${h.anchor ? `#${h.anchor}` : ""}` });
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet palette" role="dialog" aria-label="Search">
        <label className="search">
          <Icon.search />
          <input
            autoFocus
            placeholder="Search files, projects, sessions, settings and the docs"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, hits.length - 1));
              else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
              else if (e.key === "Enter" && hits[active]) open(hits[active]);
              else if (e.key === "Escape") onClose();
              else return;
              e.preventDefault();
            }}
          />
        </label>
        <div className="pop-list" style={{ paddingBottom: 10 }}>
          {q.trim().length < 2 ? (
            <p className="pop-h">Type at least two letters.</p>
          ) : !hits.length && (searching || dq !== q) ? (
            <p className="pop-h">Searching…</p>
          ) : !hits.length ? (
            <p className="pop-h">Nothing matches “{q}”.</p>
          ) : (
            hits.map((h, i) => (
              <button key={`${h.kind}:${i}`} type="button" className="pop-item" data-active={active === i} onMouseEnter={() => setActive(i)} onClick={() => open(h)}>
                <b>{h.label}</b>
                <i>{KIND[h.kind]}</i>
                <span>{h.detail}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
