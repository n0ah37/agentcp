#!/usr/bin/env node
// Signs the packaged app ad hoc, so it runs on this Mac. A build without a
// Developer ID leaves Electron's own linker signature, which no longer matches
// the bundle once the app's files are added, and macOS refuses to launch it.
// Distribution to other Macs needs a Developer ID and notarization instead.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const app = path.resolve("release", `mac-${process.arch}`, "AgentCP.app");
if (!fs.existsSync(app)) throw new Error(`No app at ${app}`);
execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
console.log(`signed ad hoc → ${path.relative(process.cwd(), app)}`);
