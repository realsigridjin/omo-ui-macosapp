import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ENV } from "../../shared/ipc";
import type { OmoBinary, OmoSource } from "../../shared/ipc";

export interface LocateOptions {
  env: Record<string, string | undefined>;
  homeDir: string;
  /** PATH value of the login shell; each entry is searched for an `omo` executable. */
  loginPath: string | null;
  versionTimeoutMs?: number;
}

export interface LocateProblem {
  source: OmoSource;
  path: string;
  problem: string;
}

export type LocateResult = { ok: true; binary: OmoBinary } | { ok: false; tried: LocateProblem[] };

interface Candidate {
  source: OmoSource;
  path: string;
}

const VERSION_PATTERN = /^omo\s+(\S+)/;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function installJsonCandidate(homeDir: string, tried: LocateProblem[]): Promise<Candidate | null> {
  const file = path.join(homeDir, ".omo", "install.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    tried.push({ source: "install.json", path: file, problem: `cannot read install.json: ${errorText(error)}` });
    return null;
  }
  const binPath = typeof parsed === "object" && parsed !== null && "binPath" in parsed ? parsed.binPath : undefined;
  if (typeof binPath !== "string" || binPath === "") {
    tried.push({ source: "install.json", path: file, problem: "install.json has no binPath string" });
    return null;
  }
  return { source: "install.json", path: binPath };
}

async function candidates(options: LocateOptions, tried: LocateProblem[]): Promise<Candidate[]> {
  const override = options.env[ENV.omoBin];
  if (override !== undefined && override !== "") return [{ source: "override", path: override }];
  const list: Candidate[] = [];
  const fromInstall = await installJsonCandidate(options.homeDir, tried);
  if (fromInstall) list.push(fromInstall);
  const windows = process.platform === "win32";
  const binaryName = windows ? "omo.exe" : "omo";
  const envPath = windows ? Object.entries(options.env).find(([key]) => key.toUpperCase() === "PATH")?.[1] : undefined;
  list.push({ source: "local-bin", path: path.join(options.homeDir, ".local", "bin", binaryName) });
  for (const dir of (options.loginPath ?? envPath ?? "").split(windows ? ";" : path.delimiter)) {
    if (path.isAbsolute(dir)) list.push({ source: "login-path", path: path.join(dir, binaryName) });
  }
  return list;
}

function readVersion(candidate: Candidate, options: LocateOptions): Promise<{ version: string } | { problem: string }> {
  const timeoutMs = options.versionTimeoutMs ?? 10_000;
  const nodeOverride = process.platform === "win32" && candidate.source === "override" && path.extname(candidate.path).toLowerCase() === ".mjs";
  return new Promise((resolve) => {
    execFile(
      nodeOverride ? process.execPath : candidate.path,
      nodeOverride ? [candidate.path, "--version"] : ["--version"],
      { env: nodeOverride ? { ...options.env, ELECTRON_RUN_AS_NODE: "1" } : options.env, timeout: timeoutMs, killSignal: "SIGKILL", encoding: "utf8" },
      (error, stdout) => {
        if (error) {
          const problem = error.killed
            ? `--version timed out after ${timeoutMs} ms`
            : `--version failed: ${error.message.split("\n")[0] ?? error.message}`;
          resolve({ problem });
          return;
        }
        const match = VERSION_PATTERN.exec(stdout.trim());
        resolve(match?.[1] ? { version: match[1] } : { problem: `unexpected --version output: ${stdout.trim().slice(0, 200)}` });
      },
    );
  });
}

async function check(candidate: Candidate, options: LocateOptions): Promise<OmoBinary | string> {
  try {
    if (!(await stat(candidate.path)).isFile()) return "not a regular file";
  } catch (error) {
    return `not found: ${errorText(error)}`;
  }
  try {
    await access(candidate.path, constants.X_OK);
  } catch (error) {
    return `not executable: ${errorText(error)}`;
  }
  const version = await readVersion(candidate, options);
  if ("problem" in version) return version.problem;
  return { path: candidate.path, version: version.version, source: candidate.source };
}

/** Finds the first usable omo binary: override only, else install.json, ~/.local/bin, then the login PATH. */
export async function locateOmo(options: LocateOptions): Promise<LocateResult> {
  const tried: LocateProblem[] = [];
  const seen = new Set<string>();
  for (const candidate of await candidates(options, tried)) {
    let real = candidate.path;
    try {
      real = await realpath(candidate.path);
    } catch (error) {
      tried.push({ ...candidate, problem: `not found: ${errorText(error)}` });
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const result = await check(candidate, options);
    if (typeof result !== "string") return { ok: true, binary: result };
    tried.push({ ...candidate, problem: result });
  }
  return { ok: false, tried };
}
