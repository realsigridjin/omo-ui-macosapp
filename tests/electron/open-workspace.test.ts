import { describe, expect, it } from "vitest";
import { createOpenWorkspace, isOpenTargetId } from "../../electron/open-workspace";

interface Call {
  file: string;
  args: readonly string[];
}

function harness(installed: readonly string[], options: { directories?: readonly string[]; openPathProblem?: string } = {}) {
  const calls: Call[] = [];
  const opened: string[] = [];
  const directories = options.directories ?? ["/repo/server"];
  const service = createOpenWorkspace({
    platform: "darwin",
    exec: async (file, args) => {
      calls.push({ file, args });
      if (file === "/usr/bin/mdfind") {
        const bundle = /'([^']+)'/.exec(args[0] ?? "")?.[1] ?? "";
        return installed.includes(bundle) ? `/Applications/${bundle}.app\n` : "";
      }
      return "";
    },
    openPath: async (target) => {
      opened.push(target);
      return options.openPathProblem ?? "";
    },
    statPath: async (target) => {
      if (!directories.includes(target)) throw new Error(`ENOENT: ${target}`);
      return { isDirectory: () => true };
    },
  });
  return { service, calls, opened };
}

const VSCODE = "com.microsoft.VSCode";
const TERMINAL = "com.apple.Terminal";

describe("createOpenWorkspace", () => {
  it("lists installed editors, Terminal and always Finder", async () => {
    const { service } = harness([VSCODE, TERMINAL]);
    expect((await service.listTargets()).map((target) => target.id)).toEqual(["vscode", "terminal", "finder"]);
    expect((await harness([]).service.listTargets()).map((target) => target.id)).toEqual(["finder"]);
  });

  it("opens the default target in VS Code through /usr/bin/open -b when installed", async () => {
    const { service, calls, opened } = harness([VSCODE]);
    await expect(service.openDefault("/repo/server")).resolves.toBe("vscode");
    expect(calls.at(-1)).toEqual({ file: "/usr/bin/open", args: ["-b", VSCODE, "/repo/server"] });
    expect(opened).toEqual([]);
  });

  it("falls back to Finder through shell.openPath when no editor is installed", async () => {
    const { service, calls, opened } = harness([]);
    await expect(service.openDefault("/repo/server")).resolves.toBe("finder");
    expect(opened).toEqual(["/repo/server"]);
    expect(calls.filter((call) => call.file === "/usr/bin/open")).toEqual([]);
  });

  it("opens Terminal with open -a Terminal", async () => {
    const { service, calls } = harness([TERMINAL]);
    await service.open("/repo/server", "terminal");
    expect(calls.at(-1)).toEqual({ file: "/usr/bin/open", args: ["-a", "Terminal", "/repo/server"] });
  });

  it("rejects relative, missing and non-directory paths before spawning anything", async () => {
    const { service, calls, opened } = harness([VSCODE], { directories: ["/repo/server"] });
    await expect(service.open("repo/server", "vscode")).rejects.toThrow(/absolute/);
    await expect(service.open("/repo/missing", "vscode")).rejects.toThrow(/does not exist/);
    await expect(service.open("", "finder")).rejects.toThrow(/non-empty/);
    expect(calls.filter((call) => call.file === "/usr/bin/open")).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("rejects targets outside the allowlist and editors that are not installed", async () => {
    const { service, calls } = harness([]);
    await expect(service.open("/repo/server", "textedit")).rejects.toThrow(/unknown open target/);
    await expect(service.open("/repo/server", "vscode")).rejects.toThrow(/not installed/);
    expect(calls.filter((call) => call.file === "/usr/bin/open")).toEqual([]);
  });

  it("surfaces the problem string shell.openPath returns", async () => {
    const { service } = harness([], { openPathProblem: "Finder refused" });
    await expect(service.open("/repo/server", "finder")).rejects.toThrow("Finder refused");
  });

  it("narrows target ids", () => {
    expect(isOpenTargetId("finder")).toBe(true);
    expect(isOpenTargetId("rm -rf")).toBe(false);
  });
});

const WINDOWS_CWD = "C:\\repo\\server";
const WINDOWS_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const USER_PROGRAMS = "C:\\Users\\test\\AppData\\Local\\Programs";
const SYSTEM_PROGRAMS = "C:\\Program Files";

function windowsHarness(installed: readonly string[], options: { cwd?: string; openPathProblem?: string } = {}) {
  const calls: Call[] = [];
  const opened: string[] = [];
  const cwd = options.cwd ?? WINDOWS_CWD;
  const service = createOpenWorkspace({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local", ProgramFiles: SYSTEM_PROGRAMS, "ProgramFiles(x86)": "C:\\Program Files (x86)", SystemRoot: "C:\\Windows" },
    exec: async (file, args) => {
      calls.push({ file, args });
      return "";
    },
    openPath: async (target) => {
      opened.push(target);
      return options.openPathProblem ?? "";
    },
    statPath: async (target) => {
      if (target === cwd) return { isDirectory: () => true };
      if (installed.includes(target)) return { isDirectory: () => false };
      throw new Error(`ENOENT: ${target}`);
    },
  });
  return { service, calls, opened };
}

describe("createOpenWorkspace on Windows", () => {
  it("lists installed user and system editors followed by PowerShell and Explorer", async () => {
    const { service, calls } = windowsHarness([`${USER_PROGRAMS}\\Microsoft VS Code\\Code.exe`, `${SYSTEM_PROGRAMS}\\Cursor\\Cursor.exe`]);
    expect(await service.listTargets()).toEqual([{ id: "vscode" }, { id: "cursor" }, { id: "terminal" }, { id: "finder" }]);
    expect(calls).toEqual([]);
    expect(await windowsHarness([]).service.listTargets()).toEqual([{ id: "terminal" }, { id: "finder" }]);
  });

  it("passes the workspace as one argument directly to the installed editor executable", async () => {
    const executable = `${USER_PROGRAMS}\\Microsoft VS Code\\Code.exe`;
    const cwd = "C:\\repo\\O'Brien & $project; [draft]";
    const { service, calls, opened } = windowsHarness([executable], { cwd });
    await expect(service.openDefault(cwd)).resolves.toBe("vscode");
    expect(calls).toEqual([{ file: executable, args: [cwd] }]);
    expect(opened).toEqual([]);
  });

  it("opens Cursor from a system installation", async () => {
    const executable = `${SYSTEM_PROGRAMS}\\Cursor\\Cursor.exe`;
    const { service, calls } = windowsHarness([executable]);
    await expect(service.openDefault(WINDOWS_CWD)).resolves.toBe("cursor");
    expect(calls).toEqual([{ file: executable, args: [WINDOWS_CWD] }]);
  });

  it("falls back to Explorer through shell.openPath rather than opening a terminal", async () => {
    const { service, calls, opened } = windowsHarness([]);
    await expect(service.openDefault(WINDOWS_CWD)).resolves.toBe("finder");
    expect(opened).toEqual([WINDOWS_CWD]);
    expect(calls).toEqual([]);
    await expect(windowsHarness([], { openPathProblem: "Explorer refused" }).service.open(WINDOWS_CWD, "finder")).rejects.toThrow("Explorer refused");
  });

  it("launches a separate PowerShell window with a safely quoted working directory", async () => {
    const cwd = "C:\\repo\\O'Brien & $project; [draft]";
    const { service, calls } = windowsHarness([], { cwd });
    await service.open(cwd, "terminal");
    expect(calls).toEqual([{
      file: WINDOWS_POWERSHELL,
      args: ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath '${WINDOWS_POWERSHELL}' -WorkingDirectory 'C:\\repo\\O''Brien & $project; [draft]' -ArgumentList '-NoExit', '-NoProfile' -ErrorAction Stop`],
    }]);
  });

  it("rejects relative, root-relative, missing and non-directory paths before opening", async () => {
    const executable = `${USER_PROGRAMS}\\Microsoft VS Code\\Code.exe`;
    const { service, calls, opened } = windowsHarness([executable]);
    for (const cwd of ["repo\\server", "C:repo\\server", "\\repo\\server", "/repo/server"]) {
      await expect(service.open(cwd, "terminal")).rejects.toThrow(/absolute/);
    }
    await expect(service.open("C:\\missing", "finder")).rejects.toThrow(/does not exist/);
    await expect(service.open(executable, "finder")).rejects.toThrow(/not a directory/);
    await expect(service.open(WINDOWS_CWD, "textedit")).rejects.toThrow(/unknown open target/);
    await expect(service.open(WINDOWS_CWD, "cursor")).rejects.toThrow(/not installed/);
    expect(calls).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("accepts UNC workspaces without interpreting shell metacharacters", async () => {
    const cwd = "\\\\server\\share\\O'Brien & project";
    const { service, opened } = windowsHarness([], { cwd });
    await service.open(cwd, "finder");
    expect(opened).toEqual([cwd]);
  });
});
