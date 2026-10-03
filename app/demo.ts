/**
 * The landing page's demo: the real UI, in a browser, answered from a saved
 * run of the engine against a made-up home folder (scripts/demo-home.mjs).
 * Built with VITE_ACP_DEMO=1. Nothing reads or
 * writes anyone's files: reads come from the recording, preferences live in
 * the page, and anything that would change a file says it's a demo.
 */

import { createTwoFilesPatch } from "diff";

import type { FileView, ScanState, WritePlan } from "../shared/types.ts";

export const DEMO = import.meta.env.VITE_ACP_DEMO === "1";

/**
 * How the landing page asks for one view of the demo, in the frame's query:
 *   look=contrast  the opposite of the visitor's light or dark, so the app stands out from the page
 *   pane           one screen, without the sidebar
 *   edits=off      editing starts off, as it does in a new install
 */
const ask = new URLSearchParams(DEMO ? location.search : "");
export const demoPane = DEMO && ask.has("pane");
/** In a frame on the landing page, moving around the app doesn't add to the page's Back history. */
export const demoEmbedded = DEMO && window.top !== window;
/** The look the app takes when Appearance follows the system. */
export function demoSystem(system: "light" | "dark"): "light" | "dark" {
  if (!DEMO || ask.get("look") !== "contrast") return system;
  return system === "dark" ? "light" : "dark";
}

type Recording = Record<string, unknown>;
let recording: Promise<Recording> | null = null;
const load = () => (recording ??= fetch("demo-data.json").then((r) => r.json() as Promise<Recording>));

/** The key a request is recorded under: method, path, and the query sorted with empty values dropped. */
export function demoKey(path: string): string {
  const [p, q = ""] = path.split("?");
  const params = [...new URLSearchParams(q).entries()].filter(([, v]) => v !== "").sort(([a], [b]) => a.localeCompare(b));
  return params.length ? `${p}?${new URLSearchParams(params).toString()}` : p;
}

export class DemoError extends Error {
  readonly status = 403;
}

const NO_WRITE = "This is a demo, so nothing is saved. Get AgentCP to change your own files.";
let prefs: Record<string, unknown> | null = null;
const startPrefs = (rec: Recording) => {
  const p = { ...(rec["/api/state"] as { prefs: Record<string, unknown> }).prefs };
  if (ask.get("edits") === "off") p.allowEdits = false;
  return p;
};

// Setup's search for projects, played back finished. The folders macOS asks
// about are searched when the visitor asks, as they would be on a Mac.
let scan: ScanState | null = null;
function scanFor(rec: Recording, folder: unknown): ScanState {
  const done = rec["GET /api/scan"] as ScanState | undefined;
  if (!done) throw new DemoError("That isn't part of the demo.");
  scan ??= { ...done, askFirst: done.askFirst.map((a) => ({ ...a, state: "not-asked" as const })) };
  if (typeof folder === "string") {
    const asked = done.askFirst.find((a) => a.name === folder);
    if (!asked) return { ...scan, error: "The demo can't look in your folders. Get AgentCP to find your own projects." };
    scan = { ...scan, error: null, askFirst: scan.askFirst.map((a) => (a.name === folder ? { ...a, state: asked.state } : a)) };
  }
  return scan;
}

/** What a save would change, worked out here, since there's no engine to ask. */
function planFor(rec: Recording, b: Record<string, unknown>): WritePlan {
  const view = Object.entries(rec).find(([k, v]) => k.startsWith("/api/file?") && (v as FileView | undefined)?.file?.path === b.path)?.[1] as FileView | undefined;
  const display = view?.file.display ?? String(b.path);
  const before = view?.text ?? "";
  const after = typeof b.content === "string" ? b.content : "";
  const patch = createTwoFilesPatch(view ? display : "/dev/null", b.content === null ? "/dev/null" : display, before, after, "", "", { context: 3 });
  const body = patch.split("\n").slice(4);
  return {
    path: String(b.path),
    display,
    exists: !!view,
    changed: before !== after || !view,
    patch,
    added: body.filter((l) => l.startsWith("+")).length,
    removed: body.filter((l) => l.startsWith("-")).length,
    conflict: false,
    diskHash: view?.file.hash ?? null,
    refusal: null,
    writesTo: display,
  };
}

export async function demoCall(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
  const rec = await load();
  const [p] = path.split("?");
  if (method === "GET") {
    const hit = rec[demoKey(path)];
    if (p === "/api/state" && hit) {
      prefs ??= startPrefs(rec);
      return { ...(hit as object), prefs };
    }
    if (p === "/api/prefs") return (prefs ??= startPrefs(rec));
    if (p === "/api/scan") return scanFor(rec, undefined);
    if (hit !== undefined) return hit;
    // Search isn't recorded: it finds nothing rather than failing.
    if (p === "/api/search" || p === "/api/docs/search") return [];
    throw new DemoError("That isn't part of the demo.");
  }
  const b = (body ?? {}) as Record<string, unknown>;
  if (p === "/api/prefs") {
    prefs = { ...(prefs ?? startPrefs(rec)), ...b };
    return prefs;
  }
  if (p === "/api/scan") return scanFor(rec, b.folder);
  if (p === "/api/plan") return planFor(rec, b);
  // The editor's live checks: the recorded findings for the file.
  if (p === "/api/check") {
    const view = rec[demoKey(`/api/file?path=${encodeURIComponent(String(b.path))}&project=${encodeURIComponent(String(b.project ?? ""))}&agent=${encodeURIComponent(String(b.agent ?? ""))}`)] as { findings?: unknown[] } | undefined;
    return view?.findings ?? [];
  }
  if (p === "/api/prompt") {
    const hit = rec[`POST /api/prompt ${JSON.stringify([b.path, b.project ?? null, b.agent ?? "claude"])}`];
    if (hit) return hit;
  }
  throw new DemoError(NO_WRITE);
}
