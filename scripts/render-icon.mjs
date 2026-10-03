// Renders build/icon.svg to a transparent 1024 px PNG with Electron, then builds
// build/icon.icns with iconutil. Run with: electron scripts/render-icon.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { BrowserWindow, app } from "electron";

const root = path.resolve(import.meta.dirname, "..");
app.dock?.hide();
// Top-level await would hold back Electron's ready event in an ESM entry, so the work runs after it.
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const svg = fs.readFileSync(path.join(root, "build/icon.svg"), "utf8");
  await win.loadURL(`data:text/html,<body style="margin:0;background:transparent">${encodeURIComponent(svg)}</body>`);
  await new Promise((r) => setTimeout(r, 600));
  const png = (await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })).resize({ width: 1024, height: 1024 }).toPNG();
  const set = path.join(root, "build/icon.iconset");
  fs.rmSync(set, { recursive: true, force: true });
  fs.mkdirSync(set);
  const master = path.join(root, "build/icon.png");
  fs.writeFileSync(master, png);
  for (const s of [16, 32, 128, 256, 512]) {
    execFileSync("sips", ["-z", String(s), String(s), master, "--out", path.join(set, `icon_${s}x${s}.png`)], { stdio: "ignore" });
    execFileSync("sips", ["-z", String(s * 2), String(s * 2), master, "--out", path.join(set, `icon_${s}x${s}@2x.png`)], { stdio: "ignore" });
  }
  execFileSync("iconutil", ["-c", "icns", set, "-o", path.join(root, "build/icon.icns")]);
  fs.rmSync(set, { recursive: true, force: true });
  console.log("build/icon.png, build/icon.icns");
  app.exit(0);
});
