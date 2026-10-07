import { spawn } from "node:child_process";
import path from "node:path";

const START = "__OMO_UI_ENV_START__";
const END = "__OMO_UI_ENV_END__";
const ENV_COMMAND = `printf "%s" ${START}; /usr/bin/env -0; printf "%s" ${END}`;

/** Parses NUL-separated KEY=VALUE pairs between the env markers; null when either marker is missing. */
export function parseEnvBlock(text: string): Record<string, string> | null {
  const start = text.indexOf(START);
  if (start === -1) return null;
  const bodyStart = start + START.length;
  const end = text.indexOf(END, bodyStart);
  if (end === -1) return null;
  const env: Record<string, string> = {};
  for (const entry of text.slice(bodyStart, end).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

export interface ResolveLoginShellEnvOptions {
  baseEnv: Record<string, string | undefined>;
  homeDir: string;
  shell?: string;
  timeoutMs?: number;
}

export interface LoginShellEnv {
  env: Record<string, string>;
  fromLoginShell: boolean;
}

function stringEnv(env: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function fallbackEnv(options: ResolveLoginShellEnvOptions): LoginShellEnv {
  const env = stringEnv(options.baseEnv);
  if (process.platform === "win32") {
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
    const basePath = pathKey === undefined ? undefined : env[pathKey];
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === "PATH") delete env[key];
    }
    const prefix = path.win32.join(options.homeDir, ".local", "bin");
    env["PATH"] = basePath ? `${prefix};${basePath}` : prefix;
    return { env, fromLoginShell: false };
  }
  const prefix = ["/opt/homebrew/bin", "/usr/local/bin", path.posix.join(options.homeDir, ".local", "bin")].join(":");
  env["PATH"] = env["PATH"] ? `${prefix}:${env["PATH"]}` : prefix;
  return { env, fromLoginShell: false };
}

function runLoginShell(shell: string, options: ResolveLoginShellEnvOptions): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (text: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(text);
    };
    const child = spawn(shell, ["-ilc", ENV_COMMAND], {
      env: options.baseEnv,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => finish(null));
    child.on("close", () => finish(Buffer.concat(chunks).toString("utf8")));
  });
}

/** Captures the user's login-shell environment; falls back to baseEnv with common bin dirs prepended to PATH. */
export async function resolveLoginShellEnv(options: ResolveLoginShellEnvOptions): Promise<LoginShellEnv> {
  if (process.platform === "win32") return fallbackEnv(options);
  const shell = options.shell ?? options.baseEnv["SHELL"] ?? "/bin/zsh";
  const output = await runLoginShell(shell, options);
  const env = output === null ? null : parseEnvBlock(output);
  if (env === null || !env["PATH"]) return fallbackEnv(options);
  return { env, fromLoginShell: true };
}

const SCRUBBED_PREFIXES = ["PI_", "OMO_", "SENPI_"];
const SCRUBBED_KEYS = new Set(["ELECTRON_RUN_AS_NODE", "ELECTRON_NO_ATTACH_CONSOLE"]);

/** Copies env without agent session bindings (PI_*, OMO_*, SENPI_*) and Electron launch flags. */
export function scrubChildEnv(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (SCRUBBED_KEYS.has(key) || SCRUBBED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    result[key] = value;
  }
  return result;
}
