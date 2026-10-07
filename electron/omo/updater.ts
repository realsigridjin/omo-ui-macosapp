import { spawn } from "node:child_process";
import path from "node:path";
import { OMO_INSTALL_SCRIPT_URL, OMO_WINDOWS_INSTALL_SCRIPT_URL } from "../../shared/ipc";
import type { OmoBinary, OmoUpdateStatus } from "../../shared/ipc";
import type { SpawnImpl } from "./app-server-client";
import { killInstallerProcess, windowsInstallerArgs } from "./installer";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const OUTPUT_LIMIT = 16_384;

/** Compares release SemVer values, ignoring build metadata. Invalid versions fail the update check. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): { core: bigint[]; pre: string[] } => {
    const match = VERSION.exec(value);
    if (!match) throw new Error(`Invalid omo version: ${value}`);
    const pre = match[4]?.split(".") ?? [];
    if (pre.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) {
      throw new Error(`Invalid omo version: ${value}`);
    }
    return { core: [BigInt(match[1] ?? ""), BigInt(match[2] ?? ""), BigInt(match[3] ?? "")], pre };
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return (a.core[i] ?? 0n) > (b.core[i] ?? 0n) ? 1 : -1;
  }
  if (a.pre.length === 0 || b.pre.length === 0) {
    return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export interface UpdateCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly platform?: NodeJS.Platform;
}

export type UpdateCommandRunner = (command: UpdateCommand) => Promise<string>;

/** Runs without a TTY or shell interpolation; timeout/cancellation kills the whole owned process tree. */
export function runUpdateCommand(options: UpdateCommand, spawnImpl: SpawnImpl = spawn): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) {
      reject(new Error("omo update cancelled"));
      return;
    }
    const platform = options.platform ?? process.platform;
    const nodeScript = platform === "win32" && /\.mjs$/i.test(options.command);
    const child = spawnImpl(nodeScript ? process.execPath : options.command,
      nodeScript ? [options.command, ...options.args] : [...options.args], {
        env: nodeScript ? { ...options.env, ELECTRON_RUN_AS_NODE: "1" } : options.env,
        stdio: "pipe", detached: platform !== "win32", windowsHide: true,
      });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminating = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal.removeEventListener("abort", abort);
      child.stdout.destroy();
      child.stderr.destroy();
      if (error) reject(error);
      else resolve(stdout.trim());
    };
    const kill = (message: string): void => {
      if (settled || terminating) return;
      terminating = true;
      void killInstallerProcess(child, platform).then(() => finish(new Error(message)),
        (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
    };
    const abort = (): void => kill("omo update cancelled");
    const timer = setTimeout(() => kill(`omo update timed out after ${options.timeoutMs} ms`), options.timeoutMs);
    options.signal.addEventListener("abort", abort, { once: true });
    child.stdin.on("error", () => undefined); // Exit reporting owns EPIPE after the command exits.
    child.stdin.end();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      stdout += text;
      if (stdout.length > OUTPUT_LIMIT) kill("omo update output exceeded its limit");
    });
    child.stderr.on("data", (text: string) => { stderr = (stderr + text).slice(-OUTPUT_LIMIT); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (!terminating) finish(code === 0 ? undefined : new Error(stderr.trim() || `omo update exited with code ${code}`));
    });
  });
}

export interface AutoUpdateOptions {
  readonly enabled: () => boolean;
  readonly run?: UpdateCommandRunner;
  readonly checkTimeoutMs?: number;
  readonly installTimeoutMs?: number;
  readonly platform?: NodeJS.Platform;
}

const INSTALL_PROGRAM = [
  'script="$(mktemp "${TMPDIR:-/tmp}/omo-update-sh.XXXXXX")" || exit 1',
  "trap 'rm -f \"$script\"' EXIT",
  'curl --proto "=https" --tlsv1.2 -fsSL --connect-timeout 10 --max-time 20 "$1" -o "$script" && bash "$script" "$2"',
].join("\n");

/**
 * Checks using omo's read-only updater. Compiled omo only prints instructions, so installation uses
 * the checksum-verifying official script, pinned to that release and the located launcher directory.
 * Never evaluates the shell command printed by omo. Failure preserves launch of the located binary.
 */
export async function autoUpdateOmo(
  binary: OmoBinary,
  env: Record<string, string>,
  options: AutoUpdateOptions,
  signal: AbortSignal,
  onStatus: (status: OmoUpdateStatus) => void,
): Promise<OmoBinary> {
  if (!options.enabled()) {
    onStatus({ state: "disabled" });
    return binary;
  }
  const run = options.run ?? runUpdateCommand;
  const platform = options.platform ?? process.platform;
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path.posix;
  const command = (args: readonly string[], timeoutMs: number): UpdateCommand =>
    ({ command: binary.path, args, env, timeoutMs, signal, platform });
  try {
    onStatus({ state: "checking" });
    const output = await run(command(["update", "--dry-run"], options.checkTimeoutMs ?? 20_000));
    const available = /^omo (\S+) is available \(running (\S+)\)\. Replace this binary with:/m.exec(output);
    if (!available) {
      if (!/^omo \S+ is the newest (stable|beta) release$/m.test(output)) {
        throw new Error("This omo installation does not support native update checks; use Update or reinstall omo.");
      }
      onStatus({ state: "current" });
      return binary;
    }
    const target = available[1] ?? "";
    if (compareVersions(target, binary.version) <= 0) {
      onStatus({ state: "current" });
      return binary;
    }
    if (signal.aborted) return binary;
    if (paths.basename(binary.path).toLowerCase() !== (windows ? "omo.exe" : "omo")) throw new Error(`Automatic installation requires a launcher named ${windows ? "omo.exe" : "omo"}.`);
    onStatus({ state: "installing" });
    await run({
      command: windows ? "powershell.exe" : "/bin/bash",
      args: windows ? windowsInstallerArgs(OMO_WINDOWS_INSTALL_SCRIPT_URL, target) : ["-c", INSTALL_PROGRAM, "omo-update", OMO_INSTALL_SCRIPT_URL, target],
      env: { ...env, OMO_INSTALL_DIR: paths.dirname(binary.path), OMO_NO_MODIFY_PATH: "1" },
      timeoutMs: options.installTimeoutMs ?? 120_000,
      signal,
      platform,
    });
    const versionOutput = await run(command(["--version"], options.checkTimeoutMs ?? 20_000));
    const version = /^omo\s+(\S+)/.exec(versionOutput)?.[1] ?? "";
    if (compareVersions(version, target) < 0) throw new Error(`Expected omo ${target}, found ${version}`);
    onStatus({ state: "updated", from: binary.version, to: version });
    return { ...binary, version };
  } catch (error) {
    if (!signal.aborted) onStatus({ state: "failed", message: error instanceof Error ? error.message : String(error) });
    return binary;
  }
}
