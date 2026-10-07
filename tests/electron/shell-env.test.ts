import * as childProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseEnvBlock, resolveLoginShellEnv, scrubChildEnv } from "../../electron/omo/shell-env";

vi.mock("node:child_process", { spy: true });
const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");

describe("parseEnvBlock", () => {
  it("reads NUL-separated pairs between the markers and ignores surrounding noise", () => {
    const text = "motd noise\n__OMO_UI_ENV_START__PATH=/a:/b\0EQ=x=y\0MULTI=one\ntwo\0\0__OMO_UI_ENV_END__trailing";
    expect(parseEnvBlock(text)).toEqual({ PATH: "/a:/b", EQ: "x=y", MULTI: "one\ntwo" });
  });

  it("returns null when a marker is missing", () => {
    expect(parseEnvBlock("PATH=/a\0")).toBeNull();
    expect(parseEnvBlock("__OMO_UI_ENV_START__PATH=/a\0")).toBeNull();
  });
});

describe("scrubChildEnv", () => {
  it("drops agent session bindings and Electron launch flags but keeps PATH and HOME", () => {
    const scrubbed = scrubChildEnv({
      PATH: "/bin",
      HOME: "/h",
      PI_SESSION: "1",
      OMO_UI_OMO_BIN: "/x",
      SENPI_TOKEN: "t",
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_NO_ATTACH_CONSOLE: "1",
    });
    expect(scrubbed).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});

describe("resolveLoginShellEnv", () => {
  beforeEach(() => {
    vi.mocked(childProcess.spawn).mockImplementation(spawn);
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("captures the environment printed by the login shell command", async () => {
    const shell = "/fake-shell";
    const launch = vi.mocked(childProcess.spawn).mockImplementation((_shell, _args, options) => spawn(process.execPath, ["-e",
      'process.stdout.write("rc noise\\n__OMO_UI_ENV_START__" + Object.entries(process.env).map(([key, value]) => `${key}=${value}\\0`).join("") + "__OMO_UI_ENV_END__")',
    ], options));
    const result = await resolveLoginShellEnv({ baseEnv: { PATH: "/usr/bin:/bin", MARKER: "kept" }, homeDir: "/h", shell });
    expect(result.fromLoginShell).toBe(true);
    expect(result.env["MARKER"]).toBe("kept");
    expect(result.env["PATH"]).toBe("/usr/bin:/bin");
    expect(launch).toHaveBeenCalledWith(shell, ["-ilc", expect.stringContaining("/usr/bin/env -0")], expect.objectContaining({ env: { PATH: "/usr/bin:/bin", MARKER: "kept" } }));
  });

  it("falls back to baseEnv with common bin directories on PATH when the shell fails", async () => {
    const result = await resolveLoginShellEnv({
      baseEnv: { PATH: "/usr/bin", EMPTY: undefined },
      homeDir: "/h",
      shell: "/missing-shell",
    });
    expect(result).toEqual({
      env: { PATH: "/opt/homebrew/bin:/usr/local/bin:/h/.local/bin:/usr/bin" },
      fromLoginShell: false,
    });
  });

  it.each(["PATH", "Path", "pAtH"])("uses Windows %s with a semicolon and never starts a login shell", async (key) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const launch = vi.mocked(childProcess.spawn);
    const baseEnv = { [key]: "C:\\Windows;C:\\Tools", KEEP: "value", EMPTY: undefined, SHELL: "/bin/zsh" };
    const result = await resolveLoginShellEnv({ baseEnv, homeDir: "C:\\Users\\test", shell: "/bin/zsh" });
    expect(result).toEqual({
      env: { PATH: "C:\\Users\\test\\.local\\bin;C:\\Windows;C:\\Tools", KEEP: "value", SHELL: "/bin/zsh" },
      fromLoginShell: false,
    });
    expect(baseEnv[key]).toBe("C:\\Windows;C:\\Tools");
    expect(launch).not.toHaveBeenCalled();
  });

  it("uses only the local bin directory when Windows has no PATH", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(await resolveLoginShellEnv({ baseEnv: {}, homeDir: "C:\\Users\\test" })).toEqual({
      env: { PATH: "C:\\Users\\test\\.local\\bin" }, fromLoginShell: false,
    });
  });
});
