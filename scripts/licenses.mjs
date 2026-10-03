#!/usr/bin/env node
// Lists the open-source packages built into AgentCP, with their licenses, for
// the About page: every node_modules package the bundles' source maps name
// (the UI, the engine and the desktop shell), plus Electron itself.
//
//   node scripts/licenses.mjs      (run by pnpm build, after the bundles)
//
// Writes dist/licenses.json. The maps themselves aren't packaged.
import fs from "node:fs";
import path from "node:path";

const maps = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".map")) maps.push(p);
  }
};
walk("dist");

// A package's folder is the path up to the last node_modules/<name> or node_modules/@scope/<name>.
const dirs = new Set();
for (const m of maps) {
  const { sources = [] } = JSON.parse(fs.readFileSync(m, "utf8"));
  for (const s of sources) {
    const abs = path.resolve(path.dirname(m), s);
    const i = abs.lastIndexOf(`${path.sep}node_modules${path.sep}`);
    if (i === -1) continue;
    const rest = abs.slice(i + 14).split(path.sep);
    dirs.add(abs.slice(0, i + 14) + (rest[0].startsWith("@") ? `${rest[0]}${path.sep}${rest[1]}` : rest[0]));
  }
}
dirs.add(path.dirname(fs.realpathSync(path.join("node_modules", "electron", "package.json"))));

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i;
const out = new Map();
for (const dir of dirs) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    continue;
  }
  const file = fs.readdirSync(dir).find((f) => LICENSE_FILE.test(f));
  const license = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "See its license file");
  out.set(`${pkg.name}@${pkg.version}`, {
    name: pkg.name,
    version: pkg.version,
    license,
    url: typeof pkg.homepage === "string" ? pkg.homepage : null,
    text: file ? fs.readFileSync(path.join(dir, file), "utf8").trim() : null,
  });
}
const list = [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync("dist/licenses.json", JSON.stringify(list));
console.log(`licenses → dist/licenses.json (${list.length} packages, ${list.filter((p) => !p.text).length} without a license file)`);
