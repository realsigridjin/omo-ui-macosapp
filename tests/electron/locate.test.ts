import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { locateOmo } from "../../electron/omo/locate";

vi.mock("node:child_process", { spy: true });
vi.mock("node:fs/promises", { spy: true });

let home: string;
const binaryName = process.platform === "win32" ? "omo.exe" : "omo";
const { execFile } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const outputs = new Map<string, string>();

async function stub(file: string, output = "omo 9.9.9 (engine: test)", mode = 0o755): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  await copyFile(process.execPath, file);
  await chmod(file, mode);
  outputs.set(file, output);
  return file;
}

async function writeInstallJson(content: string): Promise<void> {
  await mkdir(path.join(home, ".omo"), { recursive: true });
  await writeFile(path.join(home, ".omo", "install.json"), content);
}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "omo-ui-locate-"));
  vi.mocked(childProcess.execFile).mockImplementation((...args: Parameters<typeof childProcess.execFile>) => {
    const [file, versionArgs, options, callback] = args;
    if (file === process.execPath) return execFile(file, versionArgs, options, callback);
    expect(versionArgs).toEqual(["--version"]);
    return execFile(file, ["-e", `console.log(${JSON.stringify(outputs.get(file))})`], options, callback);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  outputs.clear();
  await rm(home, { recursive: true, force: true });
});

describe("locateOmo", () => {
  it("prefers binPath from install.json over ~/.local/bin", async () => {
    const installed = await stub(path.join(home, "opt", binaryName));
    await stub(path.join(home, ".local", "bin", binaryName), "omo 1.0.0");
    await writeInstallJson(JSON.stringify({ method: "standalone", binPath: installed }));
    const result = await locateOmo({ env: {}, homeDir: home, loginPath: null });
    expect(result).toEqual({ ok: true, binary: { path: installed, version: "9.9.9", source: "install.json" } });
  });

  it("falls back to ~/.local/bin and then the login PATH", async () => {
    const pathDir = path.join(home, "path-bin");
    const onPath = await stub(path.join(pathDir, binaryName), "omo 2.0.0");
    const fromPath = await locateOmo({ env: {}, homeDir: home, loginPath: `${path.join(home, "nonexistent")}${path.delimiter}${pathDir}` });
    expect(fromPath).toEqual({ ok: true, binary: { path: onPath, version: "2.0.0", source: "login-path" } });

    const local = await stub(path.join(home, ".local", "bin", binaryName));
    const fromLocal = await locateOmo({ env: {}, homeDir: home, loginPath: pathDir });
    expect(fromLocal).toEqual({ ok: true, binary: { path: local, version: "9.9.9", source: "local-bin" } });
  });

  it("uses only the override when OMO_UI_OMO_BIN is set", async () => {
    await stub(path.join(home, ".local", "bin", binaryName));
    const missing = path.join(home, "missing", binaryName);
    const result = await locateOmo({ env: { OMO_UI_OMO_BIN: missing }, homeDir: home, loginPath: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.tried.map((entry) => [entry.source, entry.path])).toEqual([["override", missing]]);
  });

  it("skips a malformed install.json", async () => {
    await writeInstallJson("{not json");
    const local = await stub(path.join(home, ".local", "bin", binaryName));
    const result = await locateOmo({ env: {}, homeDir: home, loginPath: null });
    expect(result).toEqual({ ok: true, binary: { path: local, version: "9.9.9", source: "local-bin" } });
  });

  it("rejects a non-executable binary and checks each real path once", async () => {
    const local = await stub(path.join(home, ".local", "bin", binaryName), "omo 9.9.9", 0o644);
    if (process.platform === "win32") vi.mocked(fs.access).mockRejectedValueOnce(new Error("EACCES"));
    await writeInstallJson(JSON.stringify({ binPath: local }));
    const result = await locateOmo({ env: {}, homeDir: home, loginPath: path.dirname(local) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.tried.map((entry) => entry.source)).toEqual(["install.json"]);
  });

  it("rejects a binary whose --version output is not omo", async () => {
    await stub(path.join(home, ".local", "bin", binaryName), "something else");
    const result = await locateOmo({ env: {}, homeDir: home, loginPath: null });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.tried.map((entry) => entry.source)).toEqual(["install.json", "local-bin"]);
  });

  it.each(["PATH", "Path", "pAtH"])("uses the Windows %s environment when no login PATH is available", async (key) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const onPath = await stub(path.join(home, "path-bin", "omo.exe"));
    const result = await locateOmo({ env: { [key]: `${path.join(home, "missing")};${path.dirname(onPath)}` }, homeDir: home, loginPath: null });
    expect(result).toEqual({ ok: true, binary: { path: onPath, version: "9.9.9", source: "login-path" } });
  });

  it("runs an explicit Windows .mjs override with the Node runtime", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const script = path.join(home, "fake-omo.mjs");
    await writeFile(script, 'if (process.argv[2] === "--version" && process.env.ELECTRON_RUN_AS_NODE === "1") console.log("omo 8.0.0");');
    await chmod(script, 0o755);
    const env = { OMO_UI_OMO_BIN: script };
    expect(await locateOmo({ env, homeDir: home, loginPath: null })).toEqual({
      ok: true, binary: { path: script, version: "8.0.0", source: "override" },
    });
    expect(childProcess.execFile).toHaveBeenCalledWith(process.execPath, [script, "--version"],
      expect.objectContaining({ env: { ...env, ELECTRON_RUN_AS_NODE: "1" } }), expect.any(Function));
    expect(env).toEqual({ OMO_UI_OMO_BIN: script });
  });

  it("does not treat an install.json .mjs path as a Node override", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const installed = await stub(path.join(home, "installed.mjs"));
    await writeInstallJson(JSON.stringify({ binPath: installed }));
    expect(await locateOmo({ env: {}, homeDir: home, loginPath: null })).toEqual({
      ok: true, binary: { path: installed, version: "9.9.9", source: "install.json" },
    });
    expect(childProcess.execFile).toHaveBeenCalledWith(installed, ["--version"], expect.any(Object), expect.any(Function));
  });
});
