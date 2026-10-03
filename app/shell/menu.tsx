import { useEffect, useRef, useSyncExternalStore } from "react";

import { desktop, type MenuItem } from "../desktop.ts";

/**
 * A right-click or "…" menu. In the desktop app it's the native macOS menu;
 * in a browser, a small menu drawn at the pointer. Resolves with the chosen
 * item's id, or null when it's dismissed.
 */

type Open = { x: number; y: number; items: MenuItem[]; resolve: (id: string | null) => void };
let open: Open | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());

export function popMenu(items: MenuItem[], at: { x: number; y: number }): Promise<string | null> {
  if (desktop) return desktop.contextMenu(items);
  open?.resolve(null);
  return new Promise((resolve) => {
    open = { ...at, items, resolve };
    emit();
  });
}

function close(id: string | null) {
  const o = open;
  open = null;
  emit();
  o?.resolve(id);
}

export function MenuHost() {
  const o = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => open,
  );
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!o) return;
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && close(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close(null);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [o]);
  if (!o) return null;
  const left = Math.min(o.x, window.innerWidth - 230);
  const top = Math.min(o.y, window.innerHeight - 30 * o.items.length - 16);
  return (
    <div ref={box} className="ctxmenu" role="menu" style={{ left, top }}>
      {o.items.map((it, i) =>
        "separator" in it ? (
          <hr key={i} />
        ) : (
          <button key={it.id} type="button" role="menuitem" disabled={it.enabled === false} onClick={() => close(it.id)}>
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}
