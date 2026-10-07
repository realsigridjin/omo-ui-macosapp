import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ProxySettings {
  baseUrl: string;
  apiKeyConfigured: boolean;
  modelCount: number;
}

const LOOPBACK_KEY = "opencodex-loopback";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const LEGACY_ALIASES: Record<string, string> = {
  "openai/gpt-6.1-sol": "gpt-6.1-sol",
  "openai/gpt-6.1-sol--fast": "gpt-6.1-sol--fast",
};
type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !/\s|[\u0000-\u001f\u007f]/.test(value);
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Proxy base URL must be an HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username !== "" || url.password !== "" || /[?#]/.test(value)) {
    throw new Error("Proxy base URL must be HTTP(S) without credentials, query, or fragment");
  }
  return url.href.replace(/\/+$/, "");
}

async function load(agentDir: string): Promise<{ root: RecordValue; provider: RecordValue; text: string | null }> {
  let text: string;
  try {
    text = await readFile(path.join(agentDir, "models.json"), "utf8");
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") return { root: {}, provider: {}, text: null };
    throw error;
  }
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new Error("Existing models.json is not valid JSON");
  }
  if (!isRecord(root) || (root["providers"] !== undefined && !isRecord(root["providers"]))) {
    throw new Error("Existing models.json has invalid providers");
  }
  const providers = root["providers"] as RecordValue | undefined;
  const provider = providers?.["opencodex"] === undefined ? {} : providers["opencodex"];
  if (!isRecord(provider) || (provider["baseUrl"] !== undefined && typeof provider["baseUrl"] !== "string") ||
    (provider["apiKey"] !== undefined && typeof provider["apiKey"] !== "string") ||
    (provider["compat"] !== undefined && !isRecord(provider["compat"])) ||
    (provider["models"] !== undefined && (!Array.isArray(provider["models"]) ||
      !provider["models"].every((model: unknown) => isRecord(model) && validId(model["id"]))))) {
    throw new Error("Existing models.json has invalid opencodex settings");
  }
  if (typeof provider["baseUrl"] === "string") normalizeBaseUrl(provider["baseUrl"]);
  return { root, provider, text };
}

function settings(provider: RecordValue): ProxySettings {
  const key = provider["apiKey"];
  return {
    baseUrl: typeof provider["baseUrl"] === "string" ? normalizeBaseUrl(provider["baseUrl"]) : "",
    apiKeyConfigured: typeof key === "string" && key.trim() !== "" && key !== LOOPBACK_KEY,
    modelCount: Array.isArray(provider["models"]) ? provider["models"].length : 0,
  };
}

function positiveNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function convertModels(value: unknown): RecordValue[] {
  if (!isRecord(value) || !Array.isArray(value["data"]) || value["data"].length === 0) {
    throw new Error("Proxy /models response must contain a non-empty data array");
  }
  const ids = new Set<string>();
  return value["data"].map((entry: unknown) => {
    if (!isRecord(entry) || !validId(entry["id"]) || ids.has(entry["id"])) {
      throw new Error("Proxy /models response contains an invalid or duplicate model ID");
    }
    const id = entry["id"];
    ids.add(id);
    const capabilities = isRecord(entry["capabilities"]) ? entry["capabilities"] : {};
    const advertised = entry["reasoning_efforts"] ?? capabilities["reasoning_effort"] ?? [];
    if (!Array.isArray(advertised) || !advertised.every((effort: unknown) =>
      typeof effort === "string" || (isRecord(effort) && typeof effort["value"] === "string"))) {
      throw new Error("Proxy /models response contains invalid reasoning efforts");
    }
    const thinkingLevelMap: Record<string, string | null> = Object.fromEntries(THINKING_LEVELS.map((level) => [level, null]));
    let defaultThinkingLevel: string | undefined;
    if (entry["supports_reasoning_effort"] !== false) {
      for (const effort of advertised) {
        const wireValue = typeof effort === "string" ? effort : String(effort["value"]);
        const level = wireValue.toLowerCase() === "none" ? "off" : wireValue.toLowerCase();
        if (!THINKING_LEVELS.some((candidate) => candidate === level)) continue;
        thinkingLevelMap[level] = wireValue;
        if ((isRecord(effort) && effort["default"] === true) || entry["reasoning_effort"] === wireValue) defaultThinkingLevel = level;
      }
    }
    const reasoning = Object.entries(thinkingLevelMap).some(([level, effort]) => level !== "off" && effort !== null);
    const input = Array.isArray(capabilities["input_modalities"])
      ? capabilities["input_modalities"].filter((modality: unknown) => modality === "text" || modality === "image")
      : ["text"];
    const contextWindow = positiveNumber(capabilities["context_length"], capabilities["context_window"], entry["context_window"], entry["context_length"]);
    const maxTokens = positiveNumber(capabilities["max_output_tokens"], capabilities["max_tokens"], entry["max_output_tokens"], entry["max_tokens"]);
    return {
      id,
      ...(typeof entry["name"] === "string" && entry["name"] !== "" ? { name: entry["name"] } : {}),
      input: input.length > 0 ? [...new Set(input)] : ["text"],
      reasoning,
      thinkingLevelMap,
      ...(defaultThinkingLevel !== undefined ? { defaultThinkingLevel } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(entry["supports_reasoning_effort"] === false ? { compat: { supportsReasoningEffort: false } } : {}),
    };
  });
}

/** Reads only redacted registration state; a missing models.json is an unconfigured proxy. */
export async function getProxySettings(agentDir: string): Promise<ProxySettings> {
  return settings((await load(agentDir)).provider);
}

/** Discovers models before changing models.json and keeps one exact-content models.json.backup. */
export async function applyProxySettings(agentDir: string, input: { baseUrl: string; apiKey?: string }): Promise<ProxySettings> {
  if (!isRecord(input) || typeof input["baseUrl"] !== "string" ||
    (input["apiKey"] !== undefined && typeof input["apiKey"] !== "string")) {
    throw new Error("Invalid proxy settings");
  }
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const existing = await load(agentDir);
  const previousKey = typeof existing.provider["apiKey"] === "string" ? existing.provider["apiKey"] : "";
  const apiKey = input.apiKey?.trim() || (previousKey.trim() !== "" ? previousKey : "");
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(10_000),
      headers: apiKey !== "" && apiKey !== LOOPBACK_KEY ? { Authorization: `Bearer ${apiKey}` } : {},
      redirect: "error",
    });
  } catch {
    throw new Error("Proxy /models request failed or timed out");
  }
  if (!response.ok) throw new Error(`Proxy /models returned HTTP ${response.status}`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Proxy /models response is not valid JSON");
  }
  const discovered = convertModels(payload);
  for (const [alias, canonical] of Object.entries(LEGACY_ALIASES)) {
    const model = discovered.find((entry) => entry["id"] === canonical);
    if (model && !discovered.some((entry) => entry["id"] === alias)) discovered.push({ ...model, id: alias });
  }
  const models = new Map<string, RecordValue>();
  for (const model of (existing.provider["models"] ?? []) as RecordValue[]) models.set(String(model["id"]), model);
  for (const model of discovered) {
    const id = String(model["id"]);
    const previous = models.get(id);
    models.set(id, { ...model, ...previous, reasoning: model["reasoning"], thinkingLevelMap: model["thinkingLevelMap"],
      ...(model["defaultThinkingLevel"] !== undefined ? { defaultThinkingLevel: model["defaultThinkingLevel"] } : {}) });
  }
  const hostname = new URL(baseUrl).hostname;
  const local = hostname === "localhost" || hostname === "[::1]" || /^127\./.test(hostname);
  const storedKey = apiKey || (local ? LOOPBACK_KEY : "");
  const provider: RecordValue = {
    ...existing.provider,
    baseUrl,
    api: existing.provider["api"] ?? "openai-completions",
    ...(storedKey !== "" ? { apiKey: storedKey } : {}),
    compat: { supportsDeveloperRole: false, sendSessionAffinityHeaders: true, ...existing.provider["compat"] as RecordValue },
    models: [...models.values()],
  };
  const next = { ...existing.root, providers: { ...existing.root["providers"] as RecordValue, opencodex: provider } };
  await mkdir(agentDir, { recursive: true });
  const file = path.join(agentDir, "models.json");
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (existing.text !== null) {
    const backupTemp = `${file}.backup.${randomUUID()}.tmp`;
    await writeFile(backupTemp, existing.text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(backupTemp, `${file}.backup`);
  }
  await rename(temp, file);
  return settings(provider);
}
