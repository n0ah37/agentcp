import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import type { DocRef, Finding, Severity } from "../../shared/types.ts";
import { Icon } from "./icons.tsx";

export function Button(props: {
  children: ReactNode;
  onClick?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  kind?: "primary" | "quiet" | "danger" | "danger-primary" | "block" | "block-primary" | "icon";
  small?: boolean;
  disabled?: boolean;
  title?: string;
  type?: "button" | "submit";
}) {
  const kind = props.kind === "danger-primary" ? "danger primary" : props.kind === "block-primary" ? "block primary" : props.kind;
  const cls = ["btn", kind, props.small && "small"].filter(Boolean).join(" ");
  return (
    <button type={props.type ?? "button"} className={cls} onClick={props.onClick} disabled={props.disabled} title={props.title} aria-label={props.kind === "icon" ? props.title : undefined}>
      {props.children}
    </button>
  );
}

/**
 * The window's close, minimise and zoom buttons, drawn where macOS draws them,
 * for the pages that have no real window around them: the landing page's demo
 * and the screenshots. The desktop app hides these and shows its own.
 */
export function WindowButtons({ zoom = true }: { zoom?: boolean }) {
  return (
    <span className="lights" aria-hidden="true">
      <i />
      <i />
      <i className={zoom ? "" : "off"} />
    </span>
  );
}

export function Switch(props: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <span className="switch">
      <input type="checkbox" role="switch" aria-label={props.label} checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      <span />
    </span>
  );
}

/**
 * Opened from a link (a plugin's skill or server, say): bring the list's selected row into view,
 * unless it's already showing. Runs when the asked-for item or the first load changes, so a
 * refresh from disk doesn't move the list.
 */
export function useRevealSelected(asked: string | null, ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const id = setTimeout(() => {
      const row = document.querySelector('.pane.list [aria-selected="true"]');
      const list = row?.closest(".pane.list");
      if (!row || !list) return;
      const r = row.getBoundingClientRect();
      const box = list.getBoundingClientRect();
      if (r.top < box.top || r.bottom > box.bottom) row.scrollIntoView({ block: "center" });
    }, 60);
    return () => clearTimeout(id);
  }, [asked, ready]);
}

export function Tally({ counts }: { counts: Record<Severity, number> }) {
  if (!counts.problem && !counts.warning && !counts.note) return null;
  return (
    <span className="tally" title={`${counts.problem} problems, ${counts.warning} warnings, ${counts.note} notes`}>
      {counts.problem > 0 && <span className="p">{counts.problem}</span>}
      {counts.warning > 0 && <span className="w">{counts.warning}</span>}
      {!counts.problem && !counts.warning && counts.note > 0 && <span className="n">{counts.note}</span>}
    </span>
  );
}

/** A modal sheet. Escape and a click outside close it. */
export function Sheet(props: { title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; onClose: () => void; width?: "narrow" | "wide" | "side" }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(props.onClose);
  useEffect(() => {
    close.current = props.onClose;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    window.addEventListener("keydown", onKey);
    const prev = document.activeElement as HTMLElement | null;
    // In order of preference, not document order: a marked field, then the primary action.
    for (const sel of ["[data-autofocus]", "button.primary:not(:disabled)", "button"]) {
      const el = ref.current?.querySelector<HTMLElement>(sel);
      if (el) {
        el.focus();
        break;
      }
    }
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, []);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div ref={ref} className={`sheet ${props.width === "narrow" ? "narrow" : props.width === "side" ? "side-sheet" : ""}`} role="dialog" aria-modal="true">
        <div className="sheet-h">
          <h2>{props.title}</h2>
          {props.subtitle && <p>{props.subtitle}</p>}
        </div>
        <div className="sheet-b">{props.children}</div>
        {props.footer && <div className="sheet-f">{props.footer}</div>}
      </div>
    </div>
  );
}

/** A unified diff, as the engine renders it, laid out with line numbers. */
export function Diff({ patch }: { patch: string }) {
  const rows: ReactNode[] = [];
  let a = 0;
  let b = 0;
  const lines = patch.split("\n");
  lines.forEach((l, i) => {
    if (l.startsWith("===") || l.startsWith("---") || l.startsWith("+++") || l.startsWith("Index:") || l.startsWith("\\")) return;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      a = Number(h[1]);
      b = Number(h[2]);
      rows.push(<div key={i} className="hunk">{l.replace(/^@@.*@@/, (m) => m.replace(/@@/g, "").trim())}</div>);
      return;
    }
    if (i === lines.length - 1 && l === "") return;
    const sign = l[0];
    const text = l.slice(1);
    if (sign === "+") rows.push(<div key={i} className="ln add"><span className="no" /><span className="no">{b++}</span><span className="sg">+</span><span>{text}</span></div>);
    else if (sign === "-") rows.push(<div key={i} className="ln del"><span className="no">{a++}</span><span className="no" /><span className="sg">−</span><span>{text}</span></div>);
    else rows.push(<div key={i} className="ln"><span className="no">{a++}</span><span className="no">{b++}</span><span className="sg" /><span>{text}</span></div>);
  });
  if (!rows.length) return <p className="muted">No changes.</p>;
  return <div className="diff">{rows}</div>;
}

export function DocLink({ doc, onOpen, label, icon }: { doc: DocRef; onOpen: (d: DocRef) => void; label?: string; icon?: boolean }) {
  const text = label ?? doc.heading ?? "Read the documentation";
  if (icon) {
    return (
      <button type="button" className="doclink icon" onClick={() => onOpen(doc)} aria-label={text} title={text}>
        <Icon.book />
      </button>
    );
  }
  return (
    <button type="button" className="doclink" onClick={() => onOpen(doc)}>
      <Icon.book />
      {label ?? doc.heading ?? "Read the documentation"}
    </button>
  );
}

export function FindingList(props: {
  findings: Finding[];
  onOpenDoc: (d: DocRef) => void;
  onJump?: (line: number) => void;
  onFix?: (f: Finding) => void;
  canFix?: boolean;
  empty?: string;
}) {
  if (!props.findings.length) return <p className="clear">{props.empty ?? "Nothing to change."}</p>;
  const order: Record<Severity, number> = { problem: 0, warning: 1, note: 2 };
  const sorted = [...props.findings].sort((a, b) => order[a.severity] - order[b.severity] || (a.line ?? 0) - (b.line ?? 0));
  // Findings that say the same thing about different lines read as one item with a list.
  const items: Finding[][] = [];
  const byKey = new Map<string, Finding[]>();
  for (const f of sorted) {
    const key = f.group ? `${f.severity}|${f.group}|${f.detail}` : f.id;
    const list = byKey.get(key);
    if (list) list.push(f);
    else {
      const fresh = [f];
      byKey.set(key, fresh);
      items.push(fresh);
    }
  }
  const jump = (f: Finding) => f.line && props.onJump?.(f.line);
  return (
    <div className="findings">
      {items.map((list) => {
        const f = list[0];
        const many = list.length > 1;
        return (
          <div key={f.id} className={`finding ${f.severity}`}>
            <button type="button" className="ft" onClick={() => !many && jump(f)} disabled={many || !f.line || !props.onJump}>
              <i aria-hidden="true" />
              <span>{many ? `${list.length} ${f.group}` : <Rich text={f.title} />}</span>
            </button>
            <p className="fd"><Rich text={f.detail} /></p>
            {many && (
              <ul className="fl">
                {list.map((x) => (
                  <li key={x.id}>
                    <button type="button" onClick={() => jump(x)} disabled={!x.line || !props.onJump}>
                      {x.line && <span className="ln">Line {x.line}</span>}
                      <code>{x.subject ?? x.title}</code>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="fa">
              {!many && f.fix && props.onFix && (
                <Button small onClick={() => props.onFix!(f)} disabled={!props.canFix}>
                  {f.fix.label}
                </Button>
              )}
              {!many && f.line && props.onJump && <button type="button" className="linkbtn quiet" onClick={() => jump(f)}>Line {f.line}</button>}
              <DocLink doc={f.doc} onOpen={props.onOpenDoc} />
              {!f.docCurrent && <span className="stale">The docs don't say this anymore. Check the page.</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Meter({ value, max, label, right, warnAt = 0.9 }: { value: number; max: number; label: ReactNode; right: ReactNode; warnAt?: number }) {
  const r = Math.min(1, value / max);
  const c = value > max ? "var(--pencil)" : r > warnAt ? "var(--amber)" : "var(--sage)";
  return (
    <div className="meter">
      <div className="ml"><span>{label}</span><span>{right}</span></div>
      <div className="track"><div className="fill" style={{ width: `${Math.max(2, r * 100)}%`, ["--c" as string]: c }} /></div>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} days ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export function bytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} KB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/** Text with `backticks` shown as code, the way the documentation writes it. */
export function Rich({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) => (p.startsWith("`") && p.endsWith("`") && p.length > 2 ? <code key={i}>{p.slice(1, -1)}</code> : <span key={i}>{p}</span>))}
    </>
  );
}

/** "creation-not-human-owned" reads as "Creation not human owned". */
export function humanize(name: string): string {
  if (/\s/.test(name) || !/[-_]/.test(name)) return name;
  const t = name.replace(/[-_]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
