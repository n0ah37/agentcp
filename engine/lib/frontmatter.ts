import { parse } from "yaml";

import type { FieldSpec } from "../../shared/types.ts";
import { plain, section } from "./docs.ts";

export type Parsed = {
  /** False when the file does not open with a `---` line. */
  present: boolean;
  data: Record<string, unknown>;
  error: string | null;
  /** 1-based line of the closing `---`, or 0. */
  endLine: number;
  /** Field name → 1-based line it is set on. */
  lines: Record<string, number>;
};

/** Claude Code reads frontmatter only when `---` is the file's first line. */
export function splitFrontmatter(text: string): Parsed {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { present: false, data: {}, error: null, endLine: 0, lines: {} };
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (close === -1) return { present: true, data: {}, error: "The frontmatter has no closing --- line.", endLine: 0, lines: {} };
  const raw = lines.slice(1, close).join("\n");
  const at: Record<string, number> = {};
  lines.slice(1, close).forEach((l, i) => {
    const m = /^([A-Za-z_][\w-]*)\s*:/.exec(l);
    if (m) at[m[1]] = i + 2;
  });
  try {
    const data = (parse(raw) ?? {}) as unknown;
    if (typeof data !== "object" || Array.isArray(data) || data === null) {
      return { present: true, data: {}, error: "The frontmatter is not a set of fields.", endLine: close + 1, lines: at };
    }
    return { present: true, data: data as Record<string, unknown>, error: null, endLine: close + 1, lines: at };
  } catch (e) {
    return { present: true, data: {}, error: (e as Error).message.split("\n")[0], endLine: close + 1, lines: at };
  }
}

/** The body after the frontmatter. */
export function body(text: string): string {
  const fm = splitFrontmatter(text);
  return fm.endLine ? text.split("\n").slice(fm.endLine).join("\n") : text;
}

/**
 * Read a documented field table (`| Field | Required | Description |`) from
 * the section under `anchor`, so the fields the app validates are the fields
 * the current documentation lists.
 */
export function fieldsFromDocs(slug: string, anchor: string): FieldSpec[] {
  const md = section(slug, anchor);
  if (!md) return [];
  const out: FieldSpec[] = [];
  for (const line of md.split("\n")) {
    const m = /^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (!m) continue;
    const req = m[2].toLowerCase();
    out.push({
      name: m[1],
      required: req.startsWith("yes") ? "yes" : req.startsWith("recommended") ? "recommended" : "no",
      description: plain(m[3]),
    });
  }
  return out;
}
