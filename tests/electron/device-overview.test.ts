import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { getDeviceOverview } from "../../electron/device-overview";

const exec = promisify(execFile);

it("reports missing memory without claiming synchronization", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "omo-device-"));
  expect(await getDeviceOverview(home, "0.1.3", "5.1.19")).toMatchObject({ appVersion: "0.1.3", omoVersion: "5.1.19", memory: { state: "unavailable", remoteConfigured: false } });
});

it("reads real memory Git state without changing it", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "omo-memory-"));
  const repo = path.join(home, ".omo", "memory", "agents", "test", "repo");
  await mkdir(repo, { recursive: true });
  await exec("git", ["init", repo]);
  await writeFile(path.join(repo, "note.md"), "memory\n");
  await exec("git", ["-C", repo, "add", "note.md"]);
  await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"]);
  await writeFile(path.join(repo, "note.md"), "changed\n");
  const result = await getDeviceOverview(home, "0.1.3", "5.1.19");
  expect(result.memory).toMatchObject({ path: repo, state: "available", changedFiles: 1, remoteConfigured: false });
  expect(result.memory.lastCommitAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect((await exec("git", ["-C", repo, "status", "--porcelain"])).stdout).toContain(" M note.md");
});
