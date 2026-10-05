/** JSON with comments and trailing commas, which OpenCode accepts ("JSONC"), as plain JSON. */
export function parseJsonc(text: string): { data: Record<string, unknown> | null; error: string | null } {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) out += text[i++] === "\n" ? "\n" : "";
      i++;
    } else out += c;
  }
  out = out.replace(/,(\s*[}\]])/g, "$1");
  if (!out.trim()) return { data: {}, error: null };
  try {
    const data = JSON.parse(out) as unknown;
    return data && typeof data === "object" && !Array.isArray(data) ? { data: data as Record<string, unknown>, error: null } : { data: null, error: "isn't a JSON object" };
  } catch (e) {
    return { data: null, error: `isn't valid JSON: ${(e as Error).message.split("\n")[0]}` };
  }
}
