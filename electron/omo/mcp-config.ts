import { constants } from "node:fs";
import { copyFile, mkdir, open, readFile, realpath, rename, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): never {
  // Do not include JSON parser errors, server values, or paths: they can contain credentials.
  throw new Error("Invalid MCP configuration.");
}

function parse(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return invalid();
  }
  if (!isRecord(value)) return invalid();
  return value;
}

function stringMap(value: unknown, headers = false): Record<string, string> {
  if (!isRecord(value)) return invalid();
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string" || key === "" || key.includes("\0") || entry.includes("\0")) return invalid();
    if (headers && (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\r\n]/.test(entry))) return invalid();
    if (!headers && key.includes("=")) return invalid();
  }
  return value as Record<string, string>;
}

function server(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return invalid();
  const type = value["type"] ?? (value["url"] !== undefined ? "http" : "stdio");
  const next: Record<string, unknown> = {};
  if (type === "stdio") {
    const command = value["command"];
    if (typeof command !== "string" || command.trim() === "" || command.includes("\0") || value["url"] !== undefined || value["headers"] !== undefined) return invalid();
    next["type"] = "stdio";
    next["command"] = command;
    if (value["args"] !== undefined) {
      const args = value["args"];
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) return invalid();
      next["args"] = args;
    }
    if (value["env"] !== undefined) next["env"] = stringMap(value["env"]);
    if (value["cwd"] !== undefined) {
      if (typeof value["cwd"] !== "string" || value["cwd"].trim() === "" || value["cwd"].includes("\0")) return invalid();
      next["cwd"] = value["cwd"];
    }
  } else if (type === "http" || type === "sse" || type === "streamable-http") {
    const url = value["url"];
    if (typeof url !== "string" || /[\s\0]/.test(url) || value["command"] !== undefined || value["args"] !== undefined || value["env"] !== undefined || value["cwd"] !== undefined) return invalid();
    let endpoint: URL;
    try {
      endpoint = new URL(url);
    } catch {
      return invalid();
    }
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.hostname === "" || endpoint.username !== "" || endpoint.password !== "") return invalid();
    next["type"] = "http";
    next["url"] = url;
    if (value["headers"] !== undefined) next["headers"] = stringMap(value["headers"], true);
  } else {
    return invalid();
  }
  if (value["enabled"] !== undefined) {
    if (typeof value["enabled"] !== "boolean") return invalid();
    next["enabled"] = value["enabled"];
  }
  if (value["disabled"] !== undefined) {
    if (typeof value["disabled"] !== "boolean") return invalid();
    if (value["enabled"] !== undefined && value["enabled"] === value["disabled"]) return invalid();
    next["enabled"] = !value["disabled"];
  }
  if (value["auth"] !== undefined) {
    if (value["auth"] !== false && value["auth"] !== "bearer" && value["auth"] !== "oauth") return invalid();
    next["auth"] = value["auth"];
  }
  if (value["bearerTokenEnv"] !== undefined) {
    if (typeof value["bearerTokenEnv"] !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value["bearerTokenEnv"])) return invalid();
    next["bearerTokenEnv"] = value["bearerTokenEnv"];
  }
  if (value["oauth"] !== undefined) {
    if (!isRecord(value["oauth"])) return invalid();
    next["oauth"] = value["oauth"];
  }
  if (value["lifecycle"] !== undefined) {
    if (value["lifecycle"] !== "lazy" && value["lifecycle"] !== "eager" && value["lifecycle"] !== "keep-alive") return invalid();
    next["lifecycle"] = value["lifecycle"];
  }
  for (const key of ["idleTimeoutMin", "requestTimeoutMs", "connectTimeoutMs", "startupTimeoutMs"]) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0) return invalid();
      next[key] = value[key];
    }
  }
  return next;
}

function sourceServers(source: Record<string, unknown>): Record<string, unknown> {
  const servers = source["mcpServers"] ?? source["servers"] ?? (isRecord(source["mcp"]) ? source["mcp"]["servers"] : undefined);
  if (!isRecord(servers)) return invalid();
  return servers;
}

/** Lists only source paths and names, never environment variables or credentials. */
export async function discoverMcpConfigs(homeDir: string, cwd?: string): Promise<Array<{ label: string; path: string; serverNames: string[] }>> {
  const candidates = [
    ["Claude", path.join(homeDir, ".claude", ".mcp.json")],
    ["Claude Code", path.join(homeDir, ".claude.json")],
    ["Cursor", path.join(homeDir, ".cursor", "mcp.json")],
    ["Claude Desktop", path.join(homeDir, "AppData", "Roaming", "Claude", "claude_desktop_config.json")],
    ["Claude Desktop", path.join(homeDir, ".config", "Claude", "claude_desktop_config.json")],
    ...(cwd ? [["Workspace", path.join(cwd, ".mcp.json")]] : []),
  ];
  const found: Array<{ label: string; path: string; serverNames: string[] }> = [];
  for (const [label, file] of candidates) {
    if (!label || !file) continue;
    let text: string;
    try { text = await readFile(file, "utf8"); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") continue; throw error; }
    const source = parse(text);
    if (source["mcpServers"] === undefined && source["servers"] === undefined && source["mcp"] === undefined) continue;
    const serverNames = Object.keys(sourceServers(source));
    if (serverNames.length > 0) found.push({ label, path: file, serverNames });
  }
  return found;
}

export async function readConfiguredMcpServers(agentDir: string): Promise<Array<{ name: string; enabled: boolean; type: string }>> {
  let text: string;
  try { text = await readFile(path.join(agentDir, "mcp.json"), "utf8"); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return []; throw error; }
  const config = parse(text);
  if (config["mcpServers"] === undefined) return [];
  return Object.entries(sourceServers(config)).map(([name, entry]) => {
    if (!isRecord(entry)) return invalid();
    return { name, enabled: entry["enabled"] !== false, type: entry["url"] === undefined ? "stdio" : "http" };
  });
}

/** Imports Claude/Cursor JSON into omo 5.1.19's <agentDir>/mcp.json, not settings.json. */
export async function importMcpConfig(agentDir: string, sourcePath: string): Promise<{ imported: string[] }> {
  try {
    const file = path.join(agentDir, "mcp.json");
    const source = parse(await readFile(sourcePath, "utf8"));
    const sourceEntries = sourceServers(source);

    let original: Buffer | undefined;
    let mode = 0o600;
    try {
      original = await readFile(file);
      if (await realpath(sourcePath) === await realpath(file)) return invalid();
      mode = (await stat(file)).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const config = original === undefined ? {} : parse(original.toString("utf8"));
    if (config["mcpServers"] !== undefined && !isRecord(config["mcpServers"])) return invalid();
    const servers = { ...(config["mcpServers"] as Record<string, unknown> | undefined) };
    const imported: string[] = [];
    for (const [name, value] of Object.entries(sourceEntries)) {
      if (Object.hasOwn(servers, name)) continue;
      if (name.trim() === "" || /[\r\n\0]/.test(name)) return invalid();
      Object.defineProperty(servers, name, { value: server(value), enumerable: true, configurable: true, writable: true });
      imported.push(name);
    }
    if (imported.length === 0) return { imported };

    await mkdir(agentDir, { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    const staged = await open(temp, "wx", mode);
    try {
      await staged.writeFile(`${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`, "utf8");
      await staged.sync();
    } finally {
      await staged.close();
    }
    if (original !== undefined) {
      try {
        // Never overwrite the first original backup, even on subsequent imports.
        await copyFile(file, `${file}.bak`, constants.COPYFILE_EXCL);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!(await stat(`${file}.bak`)).isFile()) throw error;
      }
    }
    await rename(temp, file);
    return { imported };
  } catch {
    throw new Error("Could not import MCP configuration. Check the selected JSON file and agent directory permissions.");
  }
}
