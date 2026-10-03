import { useSyncExternalStore } from "react";

/**
 * The top bar's middle section, above the editor. A screen with a file open
 * gives it this element; the file's name and its Save button render there, so
 * the window has one bar across the top instead of two stacked ones.
 */
let slot: HTMLElement | null = null;
const subs = new Set<() => void>();

export function setHeadSlot(el: HTMLElement | null): void {
  if (el === slot) return;
  slot = el;
  for (const s of subs) s();
}

export function useHeadSlot(): HTMLElement | null {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => slot,
  );
}
