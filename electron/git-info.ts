import { stat } from "node:fs/promises";
import path from "node:path";
import type { GitCommitResult, GitInfo } from "../shared/ipc";

/** Runs a program with arguments and resolves its stdout; rejects when the process fails. */
export type GitExecFn = (file: string, args: readonly string[]) => Promise<string>;

export interface GitDeps {
  exec: GitExecFn;
  /** `fs.stat`, injectable for tests. */
  statPath?: (target: string) => Promise<{ isDirectory(): boolean }>;
}

const NO_UPSTREAM_PATTERN = /no upstream|no configured push destination|has no upstream branch/i;

async function requireDirectory(cwd: unknown, statPath: (target: string) => Promise<{ isDirectory(): boolean }>): Promise<string> {
  if (typeof cwd !== "string" || cwd === "") throw new TypeError("cwd must be a non-empty string");
  if (!path.isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
  let info: { isDirectory(): boolean };
  try {
    info = await statPath(cwd);
  } catch (error) {
    throw new Error(`cwd does not exist: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!info.isDirectory()) throw new Error("cwd is not a directory");
  return cwd;
}

/** Git facts and git operations for composer surfaces; every command runs through `exec` with no shell. */
export function createGit(deps: GitDeps) {
  const statPath = deps.statPath ?? stat;
  const run = (args: readonly string[]): Promise<string> => deps.exec("git", args);

  /**
   * Reads the branch, work-tree root, and ahead/behind counts versus the upstream of `cwd`;
   * resolves null when `cwd` is not inside a git work tree. A detached HEAD reports the short sha
   * as the branch; ahead/behind are null when the branch has no upstream.
   */
  const info = async (cwd: string): Promise<GitInfo | null> => {
    const dir = await requireDirectory(cwd, statPath);
    let root: string;
    try {
      root = (await run(["-C", dir, "rev-parse", "--show-toplevel"])).trim();
    } catch {
      return null;
    }
    let branch = (await run(["-C", dir, "branch", "--show-current"])).trim();
    if (branch === "") branch = (await run(["-C", dir, "rev-parse", "--short", "HEAD"])).trim();
    let ahead: number | null = null;
    let behind: number | null = null;
    try {
      const counts = (await run(["-C", dir, "rev-list", "--left-right", "--count", "@{upstream}...HEAD"])).trim().split(/\s+/);
      if (/^\d+$/.test(counts[0] ?? "") && /^\d+$/.test(counts[1] ?? "")) {
        behind = Number(counts[0]);
        ahead = Number(counts[1]);
      }
    } catch {
      // No upstream configured for this branch; the counts stay null.
    }
    return { branch, root, ahead, behind };
  };

  /** Verbatim `git status --porcelain` lines of `cwd`; empty when the work tree is clean. */
  const status = async (cwd: string): Promise<string[]> => {
    const dir = await requireDirectory(cwd, statPath);
    return (await run(["-C", dir, "status", "--porcelain"])).split("\n").map((line) => line.trimEnd()).filter((line) => line !== "");
  };

  /**
   * Stages every change (`git add -A`), commits with `message`, and pushes when `push` is true.
   * A push with no configured upstream is skipped and reported as `pushSkipped: "no-upstream"`;
   * every other git failure rejects with git's stderr so the dialog can show it verbatim.
   */
  const commitAndPush = async (cwd: string, message: string, push: boolean): Promise<GitCommitResult> => {
    if (typeof message !== "string" || message.trim() === "") throw new TypeError("message must be a non-empty string");
    const dir = await requireDirectory(cwd, statPath);
    await run(["-C", dir, "add", "-A"]);
    let committed = false;
    try {
      const out = await run(["-C", dir, "commit", "-m", message]);
      committed = !/nothing to commit/.test(out);
    } catch (error) {
      if (/nothing to commit/.test(String(error))) committed = false;
      else throw error;
    }
    let commitHash: string | null = null;
    if (committed) commitHash = (await run(["-C", dir, "rev-parse", "--short", "HEAD"])).trim();
    let pushed = false;
    let pushSkipped: "no-upstream" | null = null;
    if (push) {
      try {
        await run(["-C", dir, "push"]);
        pushed = true;
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (NO_UPSTREAM_PATTERN.test(text)) pushSkipped = "no-upstream";
        else throw error;
      }
    }
    return { committed, pushed, pushSkipped, commitHash };
  };

  return { info, status, commitAndPush };
}

export type Git = ReturnType<typeof createGit>;
