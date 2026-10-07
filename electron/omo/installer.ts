import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { OMO_INSTALL_SCRIPT_URL, OMO_WINDOWS_INSTALL_SCRIPT_URL } from "../../shared/ipc";
import type { InstallLogLine, InstallResult } from "../../shared/ipc";
import type { SpawnImpl } from "./app-server-client";

export interface RunInstallerOptions {
  env: Record<string, string>;
  onLine: (line: InstallLogLine) => void;
  timeoutMs?: number;
  spawnImpl?: SpawnImpl;
  readonly platform?: NodeJS.Platform;
  /** URL of the installer script; defaults to the official script for the current platform. */
  scriptUrl?: string;
}

/**
 * Bash program that downloads the script at `$1` to a temp file and runs it with bash. Piping the official script
 * into bash, as OMO_INSTALL_COMMAND does, leaves BASH_SOURCE unset, so its `set -u` main guard exits 1 before
 * installing anything (bash 3.2 and 5.2).
 */
const INSTALL_PROGRAM = [
  'script="$(mktemp "${TMPDIR:-/tmp}/omo-install-sh.XXXXXX")" || exit 1',
  "trap 'rm -f \"$script\"' EXIT",
  'curl -fsSL "$1" -o "$script" && bash "$script"',
].join("\n");

/** PowerShell's encoded command is UTF-16LE; literal strings never interpolate script URLs or versions. */
export function windowsInstallerArgs(scriptUrl: string, target = "latest"): string[] {
  const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  const program = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
    "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12",
    `try { & ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing -Uri ${quote(scriptUrl)}).Content)) ${quote(target)}; exit 0 } catch { [Console]::Error.WriteLine($_); exit 1 }`,
  ].join("\n");
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(program, "utf16le").toString("base64")];
}

/** Windows has no process groups: taskkill owns the child tree, never a negative PID. */
export function killInstallerProcess(child: ChildProcess, platform: NodeJS.Platform): Promise<void> {
  if (child.pid === undefined) return Promise.resolve();
  if (platform === "win32") {
    return new Promise((resolve) => {
      execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, (error) => {
        if (error && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve();
      });
    });
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) return Promise.reject(error);
  }
  return Promise.resolve();
}

function streamLines(stream: Readable, name: InstallLogLine["stream"], onLine: (line: InstallLogLine) => void): () => void {
  const utf8 = new StringDecoder("utf8");
  let buffer = "";
  const emit = (raw: string): void => {
    onLine({ stream: name, text: raw.endsWith("\r") ? raw.slice(0, -1) : raw });
  };
  stream.on("data", (chunk: Buffer) => {
    buffer += utf8.write(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) emit(line);
  });
  return () => {
    const rest = buffer + utf8.end();
    buffer = "";
    if (rest !== "") emit(rest);
  };
}

/** Runs the official installer in the native shell, streams output, and kills the owned child tree on timeout. */
export function runInstaller(options: RunInstallerOptions): Promise<InstallResult> {
  const timeoutMs = options.timeoutMs ?? 600_000;
  const spawnImpl = options.spawnImpl ?? spawn;
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const scriptUrl = options.scriptUrl ?? (windows ? OMO_WINDOWS_INSTALL_SCRIPT_URL : OMO_INSTALL_SCRIPT_URL);
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const child = spawnImpl(windows ? "powershell.exe" : "/bin/bash", windows ? windowsInstallerArgs(scriptUrl) : ["-lc", INSTALL_PROGRAM, "omo-install", scriptUrl], {
      env: options.env,
      stdio: "pipe",
      detached: !windows,
      windowsHide: true,
    });
    const settle = (result: InstallResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      options.onLine({ stream: "stderr", text: `installer timed out after ${timeoutMs} ms` });
      void killInstallerProcess(child, platform).catch((error: unknown) => {
        options.onLine({ stream: "stderr", text: `installer cleanup failed: ${String(error)}` });
      }).finally(() => settle({ ok: false, exitCode: null }));
    }, timeoutMs);
    child.stdin.on("error", () => undefined);
    child.stdin.end();
    const flushStdout = streamLines(child.stdout, "stdout", options.onLine);
    const flushStderr = streamLines(child.stderr, "stderr", options.onLine);
    child.on("error", (error) => {
      options.onLine({ stream: "stderr", text: `installer failed to start: ${error.message}` });
      settle({ ok: false, exitCode: null });
    });
    child.on("close", (code) => {
      if (settled || timedOut) return;
      flushStdout();
      flushStderr();
      settle({ ok: code === 0, exitCode: code });
    });
  });
}
