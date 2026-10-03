import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * The git to run, or null when there's none. On a Mac without Apple's command
 * line tools, /usr/bin/git is a stand-in that opens an "install the command line
 * developer tools" dialog whenever it runs, even for --version. So that one runs
 * only when `xcode-select -p` (a real program, no dialog) names a developer
 * folder that has git in it. Any other git on PATH (Homebrew's, say) just runs.
 * Without git, nothing is marked ignored or tracked; nothing else needs it.
 */
let found: { at: number; bin: string | null } | null = null;
const runnable = (p: string) => {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
export function gitBinary(): string | null {
  if (found && (found.bin || Date.now() - found.at < 60_000)) return found.bin;
  let bin = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, "git")).find(runnable) ?? null;
  if (bin === "/usr/bin/git" && process.platform === "darwin") {
    let dev = process.env.DEVELOPER_DIR ?? null;
    if (!dev) {
      try {
        dev = execFileSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      } catch {
        dev = null;
      }
    }
    if (!dev || !runnable(path.join(dev, "usr", "bin", "git"))) bin = null;
  }
  found = { at: Date.now(), bin };
  return bin;
}

function runGit(args: string[], opts: { timeout: number }) {
  const bin = gitBinary();
  if (!bin) return Promise.reject(Object.assign(new Error("git isn't installed"), { code: "ENOGIT" }));
  return exec(bin, args, opts);
}

const cache = new Map<string, { at: number; value: unknown }>();
const TTL = 30_000;

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await runGit(["-C", cwd, ...args], { timeout: 5000 });
    return { ok: true, out: stdout.trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

/** The working-tree root containing `dir`, or null outside a repository. */
export function gitRoot(dir: string): Promise<string | null> {
  return cached(`root:${dir}`, async () => {
    const r = await git(dir, ["rev-parse", "--show-toplevel"]);
    return r.ok && r.out ? r.out : null;
  });
}

/**
 * The main repository root, shared by every worktree. Claude Code keys auto
 * memory by this, so all worktrees of one repository share a memory folder.
 */
export function mainRepoRoot(dir: string): Promise<string | null> {
  return cached(`main:${dir}`, async () => {
    const r = await git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!r.ok || !r.out) return null;
    return path.basename(r.out) === ".git" ? path.dirname(r.out) : await gitRoot(dir);
  });
}

/** Whether git ignores `file` inside `repo`. Null when there is no repository. */
export async function isIgnored(repo: string, file: string): Promise<boolean | null> {
  const root = await gitRoot(repo);
  if (!root) return null;
  try {
    await runGit(["-C", root, "check-ignore", "-q", file], { timeout: 5000 });
    return true;
  } catch (e) {
    const code = (e as { code?: number }).code;
    return code === 1 ? false : null;
  }
}

/** Whether git tracks `file`. A tracked file is never ignored, whatever .gitignore says. */
export async function isTracked(repo: string, file: string): Promise<boolean> {
  const root = await gitRoot(repo);
  if (!root) return false;
  try {
    await runGit(["-C", root, "ls-files", "--error-unmatch", file], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function forget(): void {
  cache.clear();
  found = null;
}
