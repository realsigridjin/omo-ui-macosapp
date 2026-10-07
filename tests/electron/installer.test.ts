import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallLogLine, InstallResult } from "../../shared/ipc";
import { runInstaller, windowsInstallerArgs } from "../../electron/omo/installer";
import type { SpawnImpl } from "../../electron/omo/app-server-client";

const baseEnv = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));

function scripted(script: string): { spawnImpl: SpawnImpl; calls: Array<readonly string[]> } {
  const calls: Array<readonly string[]> = [];
  const spawnImpl: SpawnImpl = (command, args, options) => {
    calls.push([command, ...args]);
    return spawn(process.execPath, ["-e", script], { ...options, env: { ...process.env, ...options.env } });
  };
  return { spawnImpl, calls };
}

describe("runInstaller", () => {
  it("streams stdout and stderr lines and reports success", async () => {
    const { spawnImpl, calls } = scripted("console.log('one'); console.error('two'); process.stdout.write('partial')");
    const lines: InstallLogLine[] = [];
    const result = await runInstaller({ env: { PATH: "/usr/bin:/bin" }, onLine: (line) => lines.push(line), spawnImpl });
    expect(result).toEqual({ ok: true, exitCode: 0 });
    expect(calls[0]?.slice(0, 2)).toEqual(process.platform === "win32" ? ["powershell.exe", "-NoLogo"] : ["/bin/bash", "-lc"]);
    expect(lines).toContainEqual({ stream: "stdout", text: "one" });
    expect(lines).toContainEqual({ stream: "stdout", text: "partial" });
    expect(lines).toContainEqual({ stream: "stderr", text: "two" });
  });

  it("reports failure with the exit code", async () => {
    const { spawnImpl } = scripted("process.exit(4)");
    await expect(runInstaller({ env: {}, onLine: () => undefined, spawnImpl })).resolves.toEqual({ ok: false, exitCode: 4 });
  });

  it("kills the installer on timeout", async () => {
    let readyResolve: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
    let closed: Promise<unknown> | undefined;
    const spawnImpl: SpawnImpl = (_command, _args, options) => {
      const child = spawn(process.execPath, ["-e", "require('node:net').createServer().listen(0, '127.0.0.1', () => console.log('READY'))"], options);
      closed = once(child, "close");
      return child;
    };
    vi.useFakeTimers();
    const result = runInstaller({ env: baseEnv, onLine: (line) => {
      if (line.text === "READY") readyResolve();
    }, spawnImpl, timeoutMs: 50 });
    try {
      await ready;
      await vi.advanceTimersByTimeAsync(50);
      await expect(result).resolves.toEqual({ ok: false, exitCode: null });
      await closed;
    } finally { vi.useRealTimers(); }
  });

  it("encodes Windows installer URLs as literal PowerShell data", () => {
    const args = windowsInstallerArgs("https://example.com/it's/$script.ps1", "5.1.5");
    expect(args.slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    const program = Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");
    expect(program).toContain("-Uri 'https://example.com/it''s/$script.ps1'");
    expect(program).toContain("'5.1.5'; exit 0");
  });
});

describe("runInstaller with the native shell and downloader", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "omo-ui-installer-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function install(script: string | null): Promise<{ result: InstallResult; lines: InstallLogLine[] }> {
    if (process.platform === "win32") {
      const server = createServer((_request, response) => {
        response.writeHead(script === null ? 404 : 200, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(script ?? "missing");
      });
      const listening = once(server, "listening");
      server.listen(0, "127.0.0.1");
      await listening;
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing server address");
      const lines: InstallLogLine[] = [];
      try {
        const result = await runInstaller({
          env: { ...baseEnv, TEMP: dir, TMP: dir },
          onLine: (line) => lines.push(line),
          scriptUrl: `http://127.0.0.1:${address.port}/install.ps1`,
        });
        return { result, lines };
      } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
    }
    const file = path.join(dir, "install.sh");
    if (script !== null) writeFileSync(file, script);
    const lines: InstallLogLine[] = [];
    const result = await runInstaller({
      env: { PATH: "/usr/bin:/bin", HOME: dir, TMPDIR: dir },
      onLine: (line) => lines.push(line),
      scriptUrl: pathToFileURL(file).href,
    });
    return { result, lines };
  }

  it("runs the downloaded script through its native main guard and leaves no temporary script", async () => {
    if (process.platform === "win32") {
      const { result, lines } = await install("param([string]$Target); Set-StrictMode -Version Latest; function Install-Omo { Write-Output \"ran $Target\" }; Install-Omo");
      expect(result).toEqual({ ok: true, exitCode: 0 });
      expect(lines).toContainEqual({ stream: "stdout", text: "ran latest" });
      expect(existsSync(path.join(dir, "install.ps1"))).toBe(false);
      return;
    }
    const { result, lines } = await install(
      ["set -euo pipefail", 'main() { echo "ran $0"; }', 'if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi', ""].join("\n"),
    );
    expect(result).toEqual({ ok: true, exitCode: 0 });
    const scriptPath = lines.find((line) => line.stream === "stdout" && line.text.startsWith("ran "))?.text.slice("ran ".length) ?? "";
    expect(path.basename(scriptPath)).toMatch(/^omo-install-sh\./);
    expect(existsSync(scriptPath)).toBe(false);
  });

  it("reports the script's exit code", async () => {
    const { result } = await install("exit 3\n");
    expect(result).toEqual({ ok: false, exitCode: 3 });
  });

  it("fails without running a script when the download fails", async () => {
    const { result, lines } = await install(null);
    expect(result.ok).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(lines.filter((line) => line.stream === "stdout")).toEqual([]);
  });
});
