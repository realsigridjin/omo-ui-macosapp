import { execFile } from "node:child_process";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkspaceDocument, WorkspaceFile } from "../shared/workspace";

const exec = promisify(execFile);
const MAX_FILES = 2_000;
const MAX_BYTES = 1024 * 1024;

async function workspaceRoot(cwd: string): Promise<string> {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) throw new Error("Workspace must be an absolute directory");
  const root = await realpath(cwd);
  if (!(await stat(root)).isDirectory()) throw new Error("Workspace is not a directory");
  return root;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Check both lexical and canonical boundaries, including ancestors of deleted files. */
async function workspacePath(cwd: string, relativePath: string, allowMissing = false) {
  const root = await workspaceRoot(cwd);
  if (typeof relativePath !== "string" || relativePath === "" || relativePath.includes("\0")
    || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)
    || /^[a-z]:/i.test(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw new Error("File path must stay inside the workspace");
  }
  const normalized = relativePath.replaceAll("\\", "/");
  const target = path.resolve(root, normalized);
  if (!inside(root, target) || target === root) throw new Error("File path must stay inside the workspace");
  let candidate = target;
  for (;;) {
    try {
      const canonical = await realpath(candidate);
      if (!inside(root, canonical)) throw new Error("File symlink points outside the workspace");
      break;
    } catch (error) {
      if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      candidate = path.dirname(candidate);
    }
  }
  return { root, target, relativePath: path.relative(root, target).split(path.sep).join("/") };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["--literal-pathspecs", "-C", cwd, ...args], {
    encoding: "utf8", windowsHide: true, maxBuffer: 16 * MAX_BYTES,
  });
  return stdout;
}

function visible(file: string): boolean {
  return file !== "" && !file.split("/").some((part) => part === "node_modules" || part === ".git" || part === "..");
}

export async function listWorkspaceFiles(cwd: string): Promise<WorkspaceFile[]> {
  const root = await workspaceRoot(cwd);
  const [prefix, porcelain, files] = await Promise.all([
    git(root, ["rev-parse", "--show-prefix"]),
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]),
    git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."]),
  ]);
  const statuses = new Map<string, string>();
  const entries = porcelain.split("\0");
  const workspacePrefix = prefix.trimEnd();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const repositoryPath = entry.slice(3);
    if (status.includes("R") || status.includes("C")) index++;
    if (!repositoryPath.startsWith(workspacePrefix)) continue;
    const file = repositoryPath.slice(workspacePrefix.length);
    if (visible(file)) statuses.set(file, status.trim());
  }
  const paths = new Set([...statuses.keys(), ...files.split("\0").filter(visible)]);
  return [...paths].map((file) => ({ path: file, status: statuses.get(file) ?? "" }))
    .sort((a, b) => Number(b.status !== "") - Number(a.status !== "") || a.path.localeCompare(b.path))
    .slice(0, MAX_FILES);
}

const LANGUAGES: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  json: "json", css: "css", scss: "scss", html: "html", md: "markdown", py: "python", rs: "rust",
  go: "go", java: "java", c: "c", h: "c", cpp: "cpp", cs: "csharp", sh: "shell", ps1: "powershell",
  yml: "yaml", yaml: "yaml", toml: "toml", sql: "sql", xml: "xml", swift: "swift", kt: "kotlin",
};

export async function readWorkspaceFile(cwd: string, relativePath: string): Promise<WorkspaceDocument> {
  const resolved = await workspacePath(cwd, relativePath);
  const file = await open(resolved.target, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Path is not a regular file");
    if (info.size > MAX_BYTES) throw new Error("File exceeds the 1 MB preview limit");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > MAX_BYTES) throw new Error("File exceeds the 1 MB preview limit");
    const content = bytes.subarray(0, length);
    if (content.includes(0)) throw new Error("Binary files cannot be previewed");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw new Error("Binary or non-UTF-8 files cannot be previewed");
    }
    return { path: resolved.relativePath, text, language: LANGUAGES[path.extname(resolved.target).slice(1).toLowerCase()] ?? "text" };
  } finally {
    await file.close();
  }
}

export async function getWorkspaceDiff(cwd: string, relativePath: string): Promise<string> {
  const resolved = await workspacePath(cwd, relativePath, true);
  const args = ["--no-ext-diff", "--no-textconv", "--no-color"];
  const [working, staged, status] = await Promise.all([
    git(resolved.root, ["diff", ...args, "--", resolved.relativePath]),
    git(resolved.root, ["diff", "--cached", ...args, "--", resolved.relativePath]),
    git(resolved.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", resolved.relativePath]),
  ]);
  if (status.startsWith("?? ")) {
    const document = await readWorkspaceFile(resolved.root, resolved.relativePath);
    const lines = document.text.split("\n");
    const newline = document.text.endsWith("\n");
    if (newline || document.text === "") lines.pop();
    const header = `diff --git a/${document.path} b/${document.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${document.path}\n`;
    if (lines.length === 0) return header;
    return `${header}@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n${newline ? "" : "\\ No newline at end of file\n"}`;
  }
  return [staged && `# Staged changes\n${staged}`, working && `# Working tree changes\n${working}`].filter(Boolean).join("\n");
}
