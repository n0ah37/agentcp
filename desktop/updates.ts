import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { BrowserWindow, app } from "electron";
import updater from "electron-updater";

import type { UpdateState } from "../shared/types.ts";

/**
 * New versions come from the public repo's GitHub Releases (`publish` in
 * package.json): the updater reads latest-mac.yml there, downloads the zip in
 * the background, and installs it when the app quits. It needs a build signed
 * with the Developer ID, so a development or ad hoc build says so instead.
 */

const { autoUpdater } = updater;
const DAY = 24 * 60 * 60 * 1000;
let state: UpdateState = { status: "idle" };
let timer: NodeJS.Timeout | null = null;

function set(next: UpdateState): void {
  state = next;
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send("acp:update", state);
}

let signed: boolean | null = null;

/** A packaged build with its update feed (app-update.yml) and a Developer ID signature, which macOS's installer checks. */
function signedForRelease(): boolean {
  if (signed !== null) return signed;
  signed = false;
  if (!app.isPackaged || !fs.existsSync(path.join(process.resourcesPath, "app-update.yml"))) return signed;
  // codesign prints its report on stderr.
  const bundle = path.resolve(process.execPath, "..", "..", "..");
  signed = /Authority=Developer ID Application/.test(spawnSync("codesign", ["-dv", "--verbose=2", bundle], { encoding: "utf8" }).stderr ?? "");
  return signed;
}

export function updateState(): UpdateState {
  return state;
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (!signedForRelease()) {
    set({ status: "unavailable", message: "This copy of AgentCP was built on this Mac, so it doesn't update itself." });
    return state;
  }
  if (state.status === "checking" || state.status === "downloading" || state.status === "ready") return state;
  set({ status: "checking" });
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    set({ status: "error", message: e instanceof Error ? e.message.split("\n")[0] : String(e), checkedAt: new Date().toISOString() });
  }
  return state;
}

export function installUpdate(): void {
  if (state.status === "ready") autoUpdater.quitAndInstall();
}

/** Start the daily check, or stop it when the preference is off. */
export function scheduleUpdates(on: boolean): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (!on || !signedForRelease()) return;
  setTimeout(() => void checkForUpdates(), 15_000);
  timer = setInterval(() => void checkForUpdates(), DAY);
}

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.logger = null;
autoUpdater.on("update-not-available", () => set({ status: "current", checkedAt: new Date().toISOString() }));
autoUpdater.on("update-available", (i) => set({ status: "downloading", version: i.version, checkedAt: new Date().toISOString() }));
autoUpdater.on("update-downloaded", (i) => set({ status: "ready", version: i.version, checkedAt: new Date().toISOString() }));
autoUpdater.on("error", (e) => set({ status: "error", message: e.message.split("\n")[0], checkedAt: new Date().toISOString() }));
