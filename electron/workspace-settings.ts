import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PERMISSION_PRESETS } from "../shared/ipc";
import type { PermissionPreset } from "../shared/ipc";

export interface WorkspaceSettingsDeps {
  readFile?: (file: string, encoding: "utf8") => Promise<string>;
  writeFile?: (file: string, text: string) => Promise<void>;
  mkdir?: (dir: string, options: { recursive: true }) => Promise<unknown>;
  statPath?: (target: string) => Promise<{ isDirectory(): boolean }>;
}

const isPreset = (value: unknown): value is PermissionPreset =>
  typeof value === "string" && (PERMISSION_PRESETS as readonly string[]).includes(value);

async function requireDirectory(cwd: string, statPath: (target: string) => Promise<{ isDirectory(): boolean }>): Promise<string> {
  if (typeof cwd !== "string" || cwd === "") throw new TypeError("cwd must be a non-empty string");
  if (!path.isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
  try {
    const info = await statPath(cwd);
    if (!info.isDirectory()) throw new Error("cwd is not a directory");
  } catch (error) {
    throw new Error(`cwd does not exist or is not a directory: ${error instanceof Error ? error.message : String(error)}`);
  }
  return cwd;
}

async function readObject(file: string, read: (file: string, encoding: "utf8") => Promise<string>): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await read(file, "utf8");
  } catch (error) {
    if (error instanceof Error && (error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not a JSON object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Reads and writes the omo permission preset of one workspace. The preset is the `permissionPreset`
 * key of the project settings file `<cwd>/.omo/settings.json` (omo's project-scoped remap of the
 * `.senpi/settings.json` documented in its settings guide); the app-server applies it to every
 * turn of that workspace with no extra trust decision.
 */
export function createWorkspaceSettings(deps: WorkspaceSettingsDeps = {}) {
  const read = deps.readFile ?? readFile;
  const write = deps.writeFile ?? writeFile;
  const mkdirFn = deps.mkdir ?? mkdir;
  const statPath = deps.statPath ?? stat;
  const settingsFile = (cwd: string): string => path.join(cwd, ".omo", "settings.json");

  /** The workspace's `permissionPreset`; "full-access" when unset or the file is absent. */
  const getPermissionPreset = async (cwd: string): Promise<PermissionPreset> => {
    const dir = await requireDirectory(cwd, statPath);
    const settings = await readObject(settingsFile(dir), read);
    return settings !== null && isPreset(settings["permissionPreset"]) ? settings["permissionPreset"] : "full-access";
  };

  /**
   * Merges `preset` into `<cwd>/.omo/settings.json`, creating the file when absent and keeping
   * every other key; omo reads the file before the next turn starts.
   */
  const setPermissionPreset = async (cwd: string, preset: PermissionPreset): Promise<void> => {
    const dir = await requireDirectory(cwd, statPath);
    const settings = (await readObject(settingsFile(dir), read)) ?? {};
    settings["permissionPreset"] = preset;
    await mkdirFn(path.dirname(settingsFile(dir)), { recursive: true });
    await write(settingsFile(dir), `${JSON.stringify(settings, null, 2)}\n`);
  };

  return { getPermissionPreset, setPermissionPreset };
}

export type WorkspaceSettings = ReturnType<typeof createWorkspaceSettings>;
