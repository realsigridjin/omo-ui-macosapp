import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { OpencodexAccount, OpencodexAccounts } from "../../shared/opencodex";

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function isLoopback(host: string): boolean {
  return /^127\.\d+\.\d+\.\d+$/.test(host) || host === "::1" || host === "[::1]";
}

function project(rows: unknown, provider: string, activeId: unknown, keys = false): OpencodexAccount[] {
  if (!Array.isArray(rows)) throw new Error("Opencodex returned an invalid account list");
  return rows.map((row: unknown, index) => {
    if (!isRecord(row) || !text(row["id"])) throw new Error("Opencodex returned an invalid account list");
    const email = keys ? null : text(row["email"]);
    return {
      id: row["id"] as string,
      provider,
      name: text(row[keys ? "label" : "alias"]) ?? email ?? `${keys ? "API key" : "Account"} ${index + 1}`,
      email,
      active: typeof row["active"] === "boolean" ? row["active"] : row["id"] === activeId,
      paused: row["paused"] === true,
      needsReauth: row["needsReauth"] === true,
    };
  });
}

/** Management credentials stay inside this reader and are never inferred from the model API key. */
export async function readOpencodexAccounts(agentDir: string, homeDir: string): Promise<OpencodexAccounts> {
  let baseUrl = "";
  let error = "Unable to read opencodex registration";
  try {
    let config: unknown;
    try {
      config = JSON.parse(await readFile(path.join(agentDir, "models.json"), "utf8"));
    } catch (cause) {
      if (isRecord(cause) && cause["code"] === "ENOENT") return { baseUrl, accounts: [], error: null };
      throw cause;
    }
    if (!isRecord(config) || !isRecord(config["providers"])) throw new Error(error);
    const registration = config["providers"]["opencodex"];
    if (registration === undefined) return { baseUrl, accounts: [], error: null };
    error = "Invalid opencodex base URL";
    if (!isRecord(registration) || typeof registration["baseUrl"] !== "string") throw new Error(error);
    const input = registration["baseUrl"].trim();
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || /[?#]/.test(input)) {
      throw new Error(error);
    }
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
    baseUrl = url.href.replace(/\/+$/, "");
    const target = new URL(baseUrl);
    let local = isLoopback(target.hostname);
    if (target.hostname === "localhost") {
      error = "Unable to verify opencodex loopback address";
      const addresses = await lookup("localhost", { all: true });
      local = addresses.length > 0 && addresses.every(address => isLoopback(address.address));
      // Pin the verified address so a second DNS resolution cannot expose the admin token.
      const address = addresses.find(address => address.family === 4) ?? addresses[0];
      if (local && address) target.hostname = address.family === 6 ? `[${address.address}]` : address.address;
    }
    let token = "";
    if (local) {
      error = "Unable to read local opencodex management token";
      try {
        token = (await readFile(path.join(homeDir, ".opencodex", "admin-api-token"), "utf8")).trim();
      } catch (cause) {
        if (!isRecord(cause) || cause["code"] !== "ENOENT") throw cause;
      }
    }
    const signal = AbortSignal.timeout(5000);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const get = async (route: string): Promise<unknown> => {
      error = "Unable to reach opencodex management API (timeout, redirect, or connection failure)";
      const response = await fetch(`${target.href.replace(/\/+$/, "")}${route}`, { headers, signal, redirect: "error" });
      if (!response.ok) {
        error = response.status === 401 || response.status === 403
          ? local ? "Opencodex management authorization failed; verify the local admin token"
            : "Remote opencodex management authorization is required; local admin tokens are never sent remotely"
          : `Opencodex management API returned HTTP ${response.status}`;
        throw new Error(error);
      }
      error = "Opencodex management API returned invalid JSON";
      return response.json();
    };
    const oauth = await get("/api/oauth/providers");
    error = "Opencodex returned an invalid OAuth provider list";
    if (!isRecord(oauth) || !Array.isArray(oauth["providers"]) || !oauth["providers"].every(p => text(p))) throw new Error(error);
    const accounts: OpencodexAccount[] = [];
    for (const provider of new Set(oauth["providers"] as string[])) {
      const list = await get(`/api/oauth/accounts?provider=${encodeURIComponent(provider)}`);
      error = "Opencodex returned an invalid account list";
      if (!isRecord(list)) throw new Error(error);
      accounts.push(...project(list["accounts"], provider, list["activeAccountId"]));
    }
    const codex = await get("/api/codex-auth/accounts");
    const active = await get("/api/codex-auth/active");
    error = "Opencodex returned an invalid Codex account list";
    if (!isRecord(codex) || !isRecord(active)) throw new Error(error);
    accounts.push(...project(codex["accounts"], "openai", active["activeCodexAccountId"]));
    const providers = await get("/api/providers");
    error = "Opencodex returned an invalid provider list";
    if (!Array.isArray(providers) || !providers.every(p => isRecord(p) && text(p["name"]))) throw new Error(error);
    for (const provider of providers as Fields[]) {
      if (provider["authMode"] === "oauth" || provider["authMode"] === "forward") continue;
      const name = provider["name"] as string;
      const list = await get(`/api/providers/keys?name=${encodeURIComponent(name)}`);
      error = "Opencodex returned an invalid API key account list";
      if (!isRecord(list)) throw new Error(error);
      accounts.push(...project(list["keys"], name, list["activeId"], true));
    }
    return { baseUrl, accounts, error: null };
  } catch {
    return { baseUrl, accounts: [], error };
  }
}
