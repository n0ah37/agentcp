import { parse as parseToml } from "smol-toml";

/**
 * Sets or removes keys in the text of a TOML file and keeps everything else,
 * comments, order and spacing included, as it was. It handles the shapes a
 * config.toml uses for plain settings: `key = value` at the top, a dotted
 * `table.key = value` at the top, and `key = value` inside its `[table]`.
 * Anything else (a value spread over several lines, an inline table, an
 * array of tables) is refused, so the person edits the file itself. The
 * result is parsed again and must hold exactly the values asked for.
 */

export type TomlSet = { key: string; value: unknown };

export function tomlValue(v: unknown): string {
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
  if (v && typeof v === "object") return `{ ${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${bare(k)} = ${tomlValue(x)}`).join(", ")} }`;
  throw new Error("That value can't be written to TOML.");
}

const bare = (k: string) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));

type Header = { line: number; path: string; array: boolean };

function headers(lines: string[]): Header[] {
  const out: Header[] = [];
  let multi: string | null = null;
  lines.forEach((l, i) => {
    if (multi) {
      if (l.includes(multi)) multi = null;
      return;
    }
    const opener = /=\s*("""|''')/.exec(l);
    if (opener && l.split(opener[1]).length === 2) multi = opener[1];
    const m = /^\s*(\[\[?)\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(l);
    if (m) out.push({ line: i, path: m[2].replace(/\s*\.\s*/g, "."), array: m[1] === "[[" });
  });
  return out;
}

/** Where a value written on one line ends, so a trailing comment can be kept. */
function valueEnd(s: string): number | null {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      if (s.startsWith(c.repeat(3), i)) return null;
      const close = c === '"' ? /(?<!\\)"/g : /'/g;
      close.lastIndex = i + 1;
      const m = close.exec(s);
      if (!m) return null;
      i = m.index;
    } else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === "#" && depth === 0) return i;
  }
  return depth === 0 ? s.length : null;
}

function get(obj: unknown, segs: string[]): unknown {
  let cur = obj;
  for (const k of segs) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function setOne(text: string, key: string, value: unknown): string {
  const segs = key.split(".");
  const lines = text.split("\n");
  const hs = headers(lines);
  const regionEnd = (start: number) => hs.find((h) => h.line > start)?.line ?? lines.length;
  const firstHeader = hs[0]?.line ?? lines.length;

  // Every way the key can already be written: [a.b] c = …, [a] b.c = …, or a.b.c = … at the top.
  const spots: { from: number; to: number; rest: string }[] = [{ from: 0, to: firstHeader, rest: key }];
  for (let i = 1; i < segs.length; i++) {
    const table = segs.slice(0, i).join(".");
    const h = hs.find((x) => x.path === table && !x.array);
    if (h) spots.push({ from: h.line + 1, to: regionEnd(h.line), rest: segs.slice(i).join(".") });
  }
  for (const spot of spots) {
    const re = new RegExp(`^(\\s*)${spot.rest.split(".").map((s) => s.replace(/[-]/g, "\\-")).join("\\s*\\.\\s*")}\\s*=\\s*(.*)$`);
    for (let i = spot.from; i < spot.to; i++) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      const end = valueEnd(m[2]);
      if (end === null) throw new Error(`${key} is written over several lines in this file. Change it in the file itself.`);
      if (value === null) {
        lines.splice(i, 1);
      } else {
        const comment = m[2].slice(end).trimEnd();
        lines[i] = `${m[1]}${spot.rest} = ${tomlValue(value)}${comment ? ` ${comment}` : ""}`;
      }
      return lines.join("\n");
    }
  }
  // An inline table or array of tables holding it can't be edited line by line.
  for (let i = 1; i < segs.length; i++) {
    const table = segs.slice(0, i).join(".");
    if (hs.some((h) => h.path === table && h.array)) throw new Error(`${table} is a list of tables in this file. Change ${key} in the file itself.`);
    const top = new RegExp(`^\\s*${table.split(".").join("\\s*\\.\\s*")}\\s*=\\s*\\{`);
    if (lines.slice(0, firstHeader).some((l) => top.test(l))) throw new Error(`${table} is written as an inline table. Change ${key} in the file itself.`);
  }
  if (value === null) return text;

  // Not there yet: add it to the closest table that exists, or start one.
  const line = (rest: string) => `${rest} = ${tomlValue(value)}`;
  for (let i = segs.length - 1; i >= 1; i--) {
    const table = segs.slice(0, i).join(".");
    const h = hs.find((x) => x.path === table && !x.array);
    if (!h) continue;
    let at = regionEnd(h.line);
    while (at > h.line + 1 && !lines[at - 1].trim()) at--;
    lines.splice(at, 0, line(segs.slice(i).join(".")));
    return lines.join("\n");
  }
  if (segs.length === 1) {
    let at = firstHeader;
    while (at > 0 && !lines[at - 1].trim()) at--;
    // Keep a blank line between the top-level keys and the first table.
    lines.splice(at, 0, ...(at === 0 && firstHeader < lines.length ? [line(key), ""] : [line(key)]));
    return lines.join("\n");
  }
  const table = segs.slice(0, -1).join(".");
  const tail = text.length && !text.endsWith("\n") ? "\n" : "";
  return `${text}${tail}${text.trim() ? "\n" : ""}[${table}]\n${line(segs[segs.length - 1])}\n`;
}

export function setTomlKeys(text: string, sets: TomlSet[]): string {
  let out = text;
  for (const s of sets) out = setOne(out, s.key, s.value);
  let parsed: unknown;
  try {
    parsed = parseToml(out);
  } catch (e) {
    throw new Error(`The change would leave the file unreadable (${(e as Error).message.split("\n")[0]}), so it wasn't made.`, { cause: e });
  }
  for (const s of sets) {
    const got = get(parsed, s.key.split("."));
    if (s.value === null ? got !== undefined : !same(got, s.value)) throw new Error(`${s.key} couldn't be changed line by line in this file. Change it in the file itself.`);
  }
  return out;
}

/**
 * Removes a table and the tables under it ([mcp_servers.docs] and
 * [mcp_servers.docs.tools.search]), with their keys, keeping everything else
 * as written. Refuses when the table is written some other way, such as inline.
 */
export function removeTomlTable(text: string, table: string): string {
  const lines = text.split("\n");
  const hs = headers(lines);
  const mine = hs.filter((h) => !h.array && (h.path === table || h.path.startsWith(table + ".")));
  for (const h of [...mine].reverse()) {
    const end = hs.find((x) => x.line > h.line)?.line ?? lines.length;
    let from = h.line;
    // Take the blank lines before it too, so no gap is left behind.
    while (from > 0 && !lines[from - 1].trim()) from--;
    lines.splice(from, end - from, ...(from > 0 && end < lines.length ? [""] : []));
  }
  const out = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  if (get(parseToml(out), table.split(".")) !== undefined) throw new Error(`${table} is written in a way AgentCP can't remove line by line. Remove it in the file itself.`);
  return out.trim() ? out.replace(/\n*$/, "\n") : "";
}
