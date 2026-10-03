import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { api, events } from "./api.ts";

/**
 * A small cache of engine reads. Each resource is keyed by its URL; when the
 * engine reports a file change, every cached resource is refetched in the
 * background, so what is on screen follows the disk without a reload.
 */

type Entry = { data: unknown; error: Error | null; loading: boolean; at: number; subs: Set<() => void>; inflight: Promise<void> | null };

const cache = new Map<string, Entry>();
const changeSubs = new Set<(paths: string[]) => void>();

function entry(key: string): Entry {
  let e = cache.get(key);
  if (!e) {
    e = { data: undefined, error: null, loading: false, at: 0, subs: new Set(), inflight: null };
    cache.set(key, e);
  }
  return e;
}

function notify(e: Entry) {
  for (const s of e.subs) s();
}

export function load(key: string): Promise<void> {
  const e = entry(key);
  if (e.inflight) return e.inflight;
  e.loading = true;
  notify(e);
  e.inflight = api
    .get(key)
    .then((data) => {
      e.data = data;
      e.error = null;
    })
    .catch((err: Error) => {
      e.error = err;
    })
    .finally(() => {
      e.loading = false;
      e.at = Date.now();
      e.inflight = null;
      notify(e);
    });
  return e.inflight;
}

/** Refetch every resource that has subscribers; forget the rest. */
export function refreshAll(): void {
  for (const [key, e] of cache) {
    if (e.subs.size) void load(key);
    else cache.delete(key);
  }
}

/** Opens the change stream; the returned function closes it (StrictMode opens, closes and reopens). */
export function startSync(): () => void {
  return events((paths) => {
    for (const s of changeSubs) s(paths);
    refreshAll();
  });
}

export function onDiskChange(fn: (paths: string[]) => void): () => void {
  changeSubs.add(fn);
  return () => changeSubs.delete(fn);
}

export function useResource<T>(key: string | null): { data: T | undefined; error: Error | null; loading: boolean; reload: () => Promise<void> } {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!key) return () => {};
      const e = entry(key);
      e.subs.add(cb);
      return () => e.subs.delete(cb);
    },
    [key],
  );
  const snap = useSyncExternalStore(subscribe, () => (key ? entry(key) : null));
  const version = useSyncExternalStore(subscribe, () => (key ? `${entry(key).at}:${entry(key).loading}` : ""));
  useEffect(() => {
    if (key && !entry(key).at && !entry(key).inflight) void load(key);
  }, [key]);
  void version;
  return {
    data: snap?.data as T | undefined,
    error: snap?.error ?? null,
    loading: !!snap?.loading && !snap?.at,
    reload: useCallback(() => (key ? load(key) : Promise.resolve()), [key]),
  };
}

/** Debounced value, for live checks while typing. */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  const t = useRef<number | null>(null);
  useEffect(() => {
    if (t.current) clearTimeout(t.current);
    t.current = window.setTimeout(() => setV(value), ms);
    return () => {
      if (t.current) clearTimeout(t.current);
    };
  }, [value, ms]);
  return v;
}
