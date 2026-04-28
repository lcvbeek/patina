import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import type { PatinaConfig } from "./storage.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitSyncResult {
  success: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(args: string[], cwd: string): { status: number | null; stderr: string } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    status: result.status,
    stderr: (result.stderr ?? "").trim(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true if `dir` is inside a git working tree.
 */
export function isGitRepo(dir: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: dir,
    encoding: "utf8",
  });
  return result.status === 0;
}

/**
 * Pull latest from origin.
 * Uses hard-reset to avoid merge conflicts: fetch then reset --hard origin/main.
 * Warns on failure, never throws.
 */
export function gitPull(dir: string): GitSyncResult {
  const fetch = run(["fetch", "origin", "main"], dir);
  if (fetch.status !== 0) {
    const msg = `patina: git fetch failed in ${dir}: ${fetch.stderr}`;
    console.warn(msg);
    return { success: false, message: msg };
  }

  const reset = run(["reset", "--hard", "origin/main"], dir);
  if (reset.status !== 0) {
    const msg = `patina: git reset failed in ${dir}: ${reset.stderr}`;
    console.warn(msg);
    return { success: false, message: msg };
  }

  return { success: true, message: "pulled latest from origin/main" };
}

/**
 * Stage all files, commit, and push to origin/main.
 * An empty commit (nothing staged) is silently tolerated.
 * Warns on push failure, never throws.
 */
export function gitPush(dir: string, message: string): GitSyncResult {
  run(["add", "."], dir);

  // exit 1 = "nothing to commit" — tolerated, don't warn
  run(["commit", "-m", message], dir);

  const push = run(["push", "origin", "main"], dir);
  if (push.status !== 0) {
    const msg = `patina: git push failed in ${dir}: ${push.stderr}`;
    console.warn(msg);
    return { success: false, message: msg };
  }

  return { success: true, message: `pushed: ${message}` };
}

/**
 * Determine whether git sync should run for the given config and dataDir.
 *
 * - "git"      → always sync
 * - false      → never sync
 * - undefined  → auto-detect: sync if dataDir is a git repo
 */
export function shouldSync(config: PatinaConfig, dataDir: string): boolean {
  if (config.dataDirSync === "git") return true;
  if (config.dataDirSync === false) return false;
  return isGitRepo(dataDir);
}

/**
 * Ensure a .gitignore exists in `dir` that excludes machine-local files.
 * Idempotent — only writes if the file does not exist.
 */
export function ensureDataDirGitignore(dir: string): void {
  const gitignorePath = path.join(dir, ".gitignore");
  if (fs.existsSync(gitignorePath)) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    gitignorePath,
    [
      "# Machine-local patina files — do not share",
      "pending-diff.json",
      "metrics.json",
      "config.json",
      "",
    ].join("\n"),
    "utf-8",
  );
}
