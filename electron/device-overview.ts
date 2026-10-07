import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";
import type { DeviceOverview } from "../shared/device-overview";

const exec = promisify(execFile);

export async function getDeviceOverview(home: string, appVersion: string, omoVersion: string | null): Promise<DeviceOverview> {
  const result: DeviceOverview = { hostname: os.hostname(), platform: process.platform, appVersion, omoVersion,
    memory: { path: null, branch: null, lastCommitAt: null, changedFiles: 0, remoteConfigured: false, state: "unavailable" } };
  const agents = path.join(home, ".omo", "memory", "agents");
  let entries;
  try { entries = await readdir(agents, { withFileTypes: true }); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return result; throw error; }
  const repositories = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(agents, entry.name, "repo"));
  for (const repo of repositories) {
    try {
      const git = (args: string[]) => exec("git", ["-C", repo, ...args], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
      const [branch, commit, status, remotes] = await Promise.all([git(["branch", "--show-current"]), git(["log", "-1", "--format=%cI"]), git(["status", "--porcelain"]), git(["remote"])]);
      return { ...result, memory: { path: repo, branch: branch.stdout.trim(), lastCommitAt: commit.stdout.trim(), changedFiles: status.stdout.split(/\r?\n/).filter(Boolean).length, remoteConfigured: remotes.stdout.trim() !== "", state: "available" } };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      // A profile directory is not necessarily a initialized Git memory repository.
    }
  }
  return result;
}
