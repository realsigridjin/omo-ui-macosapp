import { stat } from "node:fs/promises";
import path from "node:path";
import type { OpenTarget, OpenTargetId } from "../shared/ipc";
import { OPEN_TARGET_IDS } from "../shared/ipc";

/** Runs a program with arguments and resolves its stdout; rejects when the process fails. */
export type ExecFn = (file: string, args: readonly string[]) => Promise<string>;

export interface OpenWorkspaceDeps {
  exec: ExecFn;
  /** `shell.openPath` for the Finder/Explorer target. */
  openPath: (target: string) => Promise<string>;
  /** `fs.stat`, injectable for tests. */
  statPath?: (target: string) => Promise<{ isDirectory(): boolean }>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

interface EditorSpec {
  id: Exclude<OpenTargetId, "finder" | "terminal">;
  bundleId: string;
  windowsDirectory: string;
  windowsExecutable: string;
}

const EDITORS: readonly EditorSpec[] = [
  { id: "vscode", bundleId: "com.microsoft.VSCode", windowsDirectory: "Microsoft VS Code", windowsExecutable: "Code.exe" },
  { id: "cursor", bundleId: "com.todesktop.230313mzl4w4u92", windowsDirectory: "Cursor", windowsExecutable: "Cursor.exe" },
];

const MDFIND = "/usr/bin/mdfind";
const OPEN = "/usr/bin/open";
const TERMINAL_APP = "Terminal";

export function isOpenTargetId(value: unknown): value is OpenTargetId {
  return OPEN_TARGET_IDS.some((id) => id === value);
}

async function requireDirectory(cwd: unknown, statPath: NonNullable<OpenWorkspaceDeps["statPath"]>, platform: NodeJS.Platform): Promise<string> {
  if (typeof cwd !== "string" || cwd === "") throw new TypeError("cwd must be a non-empty string");
  const absolute = platform === "win32" ? path.win32.isAbsolute(cwd) && /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(cwd) : path.posix.isAbsolute(cwd);
  if (!absolute) throw new Error("cwd must be an absolute path");
  let info: { isDirectory(): boolean };
  try {
    info = await statPath(cwd);
  } catch (error) {
    throw new Error(`cwd does not exist: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!info.isDirectory()) throw new Error("cwd is not a directory");
  return cwd;
}

/** Spotlight lookup by bundle id; an app is installed when mdfind prints at least one path. */
async function isInstalled(exec: ExecFn, bundleId: string): Promise<boolean> {
  try {
    const out = await exec(MDFIND, [`kMDItemCFBundleIdentifier == '${bundleId}'`]);
    return out.trim() !== "";
  } catch (error) {
    console.warn(`mdfind could not look up ${bundleId}; treating it as not installed`, error);
    return false;
  }
}

/** Opening targets for the header's Open menu: every installed editor, Terminal when present, and Finder always. */
export function createOpenWorkspace(deps: OpenWorkspaceDeps) {
  const statPath = deps.statPath ?? stat;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const powershell = path.win32.join(env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

  const findWindowsEditor = async (editor: EditorSpec): Promise<string | null> => {
    const roots = [
      env["LOCALAPPDATA"] && path.win32.join(env["LOCALAPPDATA"], "Programs"),
      env["ProgramFiles"],
      env["ProgramFiles(x86)"],
    ];
    const candidates = roots.filter((root): root is string => Boolean(root)).map((root) => path.win32.join(root, editor.windowsDirectory, editor.windowsExecutable));
    for (const candidate of candidates) {
      try {
        if (!(await statPath(candidate)).isDirectory()) return candidate;
      } catch {
        // Try the next standard installation location.
      }
    }
    return null;
  };

  const listTargets = async (): Promise<OpenTarget[]> => {
    if (platform === "win32") {
      const editors = await Promise.all(EDITORS.map(async (editor) => ({ editor, executable: await findWindowsEditor(editor) })));
      return [...editors.filter((entry) => entry.executable !== null).map((entry) => ({ id: entry.editor.id })), { id: "terminal" }, { id: "finder" }];
    }
    const editors = await Promise.all(EDITORS.map(async (editor) => ({ editor, installed: await isInstalled(deps.exec, editor.bundleId) })));
    const targets: OpenTarget[] = editors.filter((entry) => entry.installed).map((entry) => ({ id: entry.editor.id }));
    if (await isInstalled(deps.exec, "com.apple.Terminal")) targets.push({ id: "terminal" });
    targets.push({ id: "finder" });
    return targets;
  };

  const open = async (cwd: unknown, target: unknown): Promise<void> => {
    if (!isOpenTargetId(target)) throw new TypeError(`unknown open target: ${String(target)}`);
    const dir = await requireDirectory(cwd, statPath, platform);
    if (target === "finder") {
      const problem = await deps.openPath(dir);
      if (problem !== "") throw new Error(problem);
      return;
    }
    if (target === "terminal") {
      if (platform === "win32") {
        const command = `Start-Process -FilePath '${powershell.replaceAll("'", "''")}' -WorkingDirectory '${dir.replaceAll("'", "''")}' -ArgumentList '-NoExit', '-NoProfile' -ErrorAction Stop`;
        await deps.exec(powershell, ["-NoProfile", "-NonInteractive", "-Command", command]);
        return;
      }
      await deps.exec(OPEN, ["-a", TERMINAL_APP, dir]);
      return;
    }
    const editor = EDITORS.find((entry) => entry.id === target);
    if (editor === undefined) throw new TypeError(`unknown open target: ${target}`);
    if (platform === "win32") {
      const executable = await findWindowsEditor(editor);
      if (executable === null) throw new Error(`${target} is not installed`);
      await deps.exec(executable, [dir]);
      return;
    }
    if (!(await isInstalled(deps.exec, editor.bundleId))) throw new Error(`${target} is not installed`);
    await deps.exec(OPEN, ["-b", editor.bundleId, dir]);
  };

  /** The primary action: the first installed editor in preference order, else Finder. */
  const openDefault = async (cwd: unknown): Promise<OpenTargetId> => {
    const targets = await listTargets();
    const chosen = targets.find((entry) => entry.id !== "terminal")?.id ?? "finder";
    await open(cwd, chosen);
    return chosen;
  };

  return { listTargets, open, openDefault };
}

export type OpenWorkspace = ReturnType<typeof createOpenWorkspace>;
