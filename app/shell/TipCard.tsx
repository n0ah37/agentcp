import { useEffect, useMemo, useState, type ReactNode } from "react";

import type { Tip } from "../../shared/types.ts";
import { useRoute } from "../router.ts";
import { useResource } from "../store.ts";
import { Icon } from "../ui/icons.tsx";
import { useApp } from "./app-context.ts";

/**
 * "Did you know?": one short fact at a time from Claude Code's docs, the ones
 * about this screen first. Close hides it until the app opens again; "Don't
 * show tips" turns it off (Preferences turns it back on).
 */
export function TipCard() {
  const { prefs, setPrefs, openDoc } = useApp();
  const route = useRoute();
  const { data: tips } = useResource<Tip[]>(prefs?.showTips ? "/api/tips" : null);
  const [closed, setClosed] = useState(false);
  const [n, setN] = useState(0);
  const [ready, setReady] = useState(false);

  // Wait a moment after launch, so the card isn't the first thing that moves.
  useEffect(() => {
    const id = setTimeout(() => setReady(true), 1500);
    return () => clearTimeout(id);
  }, []);
  useEffect(() => setN(0), [route.screen]);

  const order = useMemo(() => {
    const list = tips ?? [];
    return [...list.filter((t) => t.screens.includes(route.screen)), ...list.filter((t) => !t.screens.includes(route.screen))];
  }, [tips, route.screen]);

  if (!ready || !prefs?.showTips || closed || !order.length) return null;
  const t = order[n % order.length];
  return (
    <aside className="tip" aria-label="Did you know?" key={t.id}>
      <div className="tip-h">
        <Icon.bulb />
        <span>Did you know?</span>
        <button type="button" className="x" onClick={() => setClosed(true)} aria-label="Close tips">
          <Icon.close />
        </button>
      </div>
      <b>{t.title}</b>
      <p>{withCode(t.body)}</p>
      <div className="tip-f">
        <button type="button" className="linkbtn" onClick={() => openDoc(t.doc)}>Read more</button>
        <button type="button" className="linkbtn quiet" onClick={() => void setPrefs({ showTips: false })}>Don't show tips</button>
        <button type="button" className="btn small" onClick={() => setN((x) => x + 1)}>Next</button>
      </div>
    </aside>
  );
}

/** Commands, file names and settings keys in a tip read as code. */
function withCode(text: string): ReactNode[] {
  return text.split(/(\s+)/).map((w, i) => {
    const [, core, punct] = /^(.*?)([.,;]?)$/.exec(w)!;
    const code = /^\/[a-z][a-z-]*$/.test(core) || /^~?[\w./-]*\.(md|json)$/.test(core) || core === ".gitignore" || core === "paths:";
    return code ? (
      <span key={i}>
        <code>{core}</code>
        {punct}
      </span>
    ) : (
      w
    );
  });
}
