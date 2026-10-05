import { useCallback, useSyncExternalStore } from "react";

import { demoEmbedded } from "./demo.ts";

// Hash routes, so the same build works from a local server and inside a
// desktop shell: #/instructions?project=/path&file=/path

export type Screen = "instructions" | "memory" | "sessions" | "usage" | "hooks" | "agents" | "commands" | "styles" | "skills" | "plugins" | "mcp" | "rules" | "settings" | "history";

export type Route = { screen: Screen; params: URLSearchParams };

const SCREENS: Screen[] = ["instructions", "memory", "sessions", "usage", "hooks", "agents", "commands", "styles", "skills", "plugins", "mcp", "rules", "settings", "history"];

function parse(): Route {
  const raw = location.hash.replace(/^#\/?/, "");
  const [name, query = ""] = raw.split("?");
  const screen = (SCREENS.includes(name as Screen) ? name : "instructions") as Screen;
  return { screen, params: new URLSearchParams(query) };
}

let current = parse();
const subs = new Set<() => void>();
window.addEventListener("hashchange", () => {
  current = parse();
  for (const s of subs) s();
});

export function useRoute(): Route {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => current,
  );
}

export function href(screen: Screen, params: Record<string, string | null | undefined> = {}): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) u.set(k, v);
  const s = u.toString();
  return `#/${screen}${s ? `?${s}` : ""}`;
}

export function go(screen: Screen, params: Record<string, string | null | undefined> = {}, replace = false): void {
  const next = href(screen, params);
  if (replace || demoEmbedded) history.replaceState(null, "", next);
  else history.pushState(null, "", next);
  current = parse();
  for (const s of subs) s();
}

/** Change some parameters of the current route. */
export function useParams(): [URLSearchParams, (patch: Record<string, string | null>, replace?: boolean) => void] {
  const route = useRoute();
  const set = useCallback(
    (patch: Record<string, string | null>, replace = false) => {
      const next: Record<string, string | null> = Object.fromEntries(route.params.entries());
      Object.assign(next, patch);
      go(route.screen, next, replace);
    },
    [route],
  );
  return [route.params, set];
}
