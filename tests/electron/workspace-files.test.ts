import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rename, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { getWorkspaceDiff, listWorkspaceFiles, readWorkspaceFile } from "../../electron/workspace-files";

const exec = promisify(execFile);

async function repository() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "omo-workspace-files-"));
  const git = (...args: string[]) => exec("git", ["-C", cwd, ...args], { windowsHide: true });
  await git("init", "--quiet");
  await git("config", "core.autocrlf", "false");
  return { cwd, git };
}

describe("workspace files", () => {
  it("lists actual tracked and untracked files, status first, without ignored or dependency files", async () => {
    const { cwd, git } = await repository();
    await writeFile(path.join(cwd, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(cwd, "tracked.ts"), "export const value = 1;\n");
    await git("add", ".gitignore", "tracked.ts");
    await writeFile(path.join(cwd, "tracked.ts"), "export const value = 2;\n");
    await writeFile(path.join(cwd, "new file.ts"), "const fresh = true;\n");
    await writeFile(path.join(cwd, "ignored.txt"), "hidden\n");
    await mkdir(path.join(cwd, "node_modules"));
    await writeFile(path.join(cwd, "node_modules", "dependency.js"), "ignored dependency\n");
    const files = await listWorkspaceFiles(cwd);
    expect(files).toEqual(expect.arrayContaining([
      { path: "tracked.ts", status: "AM" },
      { path: "new file.ts", status: "??" },
    ]));
    expect(files.some((file) => /ignored|node_modules|\.git\//.test(file.path))).toBe(false);
    expect(files.every((file) => !path.isAbsolute(file.path))).toBe(true);
  });

  it("keeps paths relative to the selected workspace when it is a Git subdirectory", async () => {
    const { cwd, git } = await repository();
    const subdir = path.join(cwd, "nested");
    await mkdir(subdir);
    await writeFile(path.join(subdir, "one.ts"), "one\n");
    await writeFile(path.join(cwd, "outside.ts"), "outside\n");
    await git("add", ".");
    expect(await listWorkspaceFiles(subdir)).toEqual([{ path: "one.ts", status: "A" }]);
  });

  it("reads UTF-8 code as safe text and reports its language", async () => {
    const { cwd } = await repository();
    const text = "export const text = '<script>alert(1)</script>';\n";
    await writeFile(path.join(cwd, "example.ts"), text);
    expect(await readWorkspaceFile(cwd, "example.ts")).toEqual({ path: "example.ts", text, language: "typescript" });
  });

  it("rejects traversal, absolute paths and symlinks outside the canonical workspace", async () => {
    const { cwd } = await repository();
    const outside = await mkdtemp(path.join(os.tmpdir(), "omo-workspace-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "private\n");
    await symlink(outside, path.join(cwd, "external"), process.platform === "win32" ? "junction" : "dir");
    for (const candidate of ["../secret.txt", "..\\secret.txt", path.join(outside, "secret.txt"), "C:\\secret.txt", "C:secret.txt", "external/secret.txt"]) {
      await expect(readWorkspaceFile(cwd, candidate)).rejects.toThrow(/workspace/i);
      await expect(getWorkspaceDiff(cwd, candidate)).rejects.toThrow(/workspace/i);
    }
    await expect(getWorkspaceDiff(cwd, "external/missing.txt")).rejects.toThrow(/outside the workspace/);
  });

  it("permits a symlink that resolves inside the workspace", async () => {
    const { cwd } = await repository();
    const internal = path.join(cwd, "internal");
    await mkdir(internal);
    await writeFile(path.join(internal, "code.ts"), "const internal = true;\n");
    await symlink(internal, path.join(cwd, "alias"), process.platform === "win32" ? "junction" : "dir");
    expect((await readWorkspaceFile(cwd, "alias/code.ts")).text).toBe("const internal = true;\n");
  });

  it("rejects directories, oversized files and binary contents", async () => {
    const { cwd } = await repository();
    await writeFile(path.join(cwd, "large.txt"), Buffer.alloc(1024 * 1024 + 1, 97));
    await writeFile(path.join(cwd, "binary.bin"), Buffer.from([65, 0, 66]));
    await writeFile(path.join(cwd, "non-utf8.bin"), Buffer.from([0xff, 0xfe]));
    await mkdir(path.join(cwd, "directory"));
    await expect(readWorkspaceFile(cwd, "large.txt")).rejects.toThrow(/1 MB/);
    await expect(readWorkspaceFile(cwd, "binary.bin")).rejects.toThrow(/Binary/);
    await expect(readWorkspaceFile(cwd, "non-utf8.bin")).rejects.toThrow(/Binary/);
    await expect(readWorkspaceFile(cwd, "directory")).rejects.toThrow();
  });

  it("returns actual staged and working-tree changes using literal Git path arguments", async () => {
    const { cwd, git } = await repository();
    const file = "odd [name] & dollar$.ts";
    await writeFile(path.join(cwd, file), "const value = 1;\n");
    await git("add", "--", file);
    await writeFile(path.join(cwd, file), "const value = 2;\n");
    const diff = await getWorkspaceDiff(cwd, file);
    expect(diff).toContain("# Staged changes");
    expect(diff).toContain("+const value = 1;");
    expect(diff).toContain("# Working tree changes");
    expect(diff).toContain("-const value = 1;");
    expect(diff).toContain("+const value = 2;");
  });

  it("renders an untracked file as additions and keeps missing-final-newline information", async () => {
    const { cwd } = await repository();
    await writeFile(path.join(cwd, "new.ts"), "const first = 1;\nconst second = 2;");
    const diff = await getWorkspaceDiff(cwd, "new.ts");
    expect(diff).toContain("--- /dev/null\n+++ b/new.ts");
    expect(diff).toContain("@@ -0,0 +1,2 @@\n+const first = 1;\n+const second = 2;");
    expect(diff).toContain("\\ No newline at end of file");
  });

  it("shows a deletion diff even when the file no longer exists", async () => {
    const { cwd, git } = await repository();
    await writeFile(path.join(cwd, "removed.ts"), "const removed = true;\n");
    await git("add", "removed.ts");
    await rename(path.join(cwd, "removed.ts"), path.join(cwd, "moved.ts"));
    expect(await getWorkspaceDiff(cwd, "removed.ts")).toContain("-const removed = true;");
  });
});
