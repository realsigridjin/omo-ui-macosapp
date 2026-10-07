import { once } from "node:events";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyProxySettings, getProxySettings } from "../../electron/omo/proxy";

let server: Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (!server) return;
  const closed = once(server, "close");
  server.closeAllConnections();
  server.close();
  await closed;
  server = undefined;
});

async function fixture(body: unknown = { data: [{ id: "example" }] }, status = 200) {
  const dir = await mkdtemp(path.join(tmpdir(), "omo-ui-proxy-"));
  const requests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
  server = createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address");
  return { dir, file: path.join(dir, "models.json"), baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

async function readModels(file: string) {
  return JSON.parse(await readFile(file, "utf8")) as {
    providers: Record<string, { apiKey?: string; models: Array<Record<string, unknown>>; [key: string]: unknown }>;
    [key: string]: unknown;
  };
}

describe("opencodex proxy settings", () => {
  it("reads a missing configuration without making a request", async () => {
    const f = await fixture();
    await expect(getProxySettings(f.dir)).resolves.toEqual({ baseUrl: "", apiKeyConfigured: false, modelCount: 0 });
    expect(f.requests).toEqual([]);
  });

  it("normalizes the URL, creates missing directories, and does not send the loopback placeholder", async () => {
    const f = await fixture();
    const dir = path.join(f.dir, "new-agent");
    const expected = { baseUrl: f.baseUrl, apiKeyConfigured: false, modelCount: 1 };
    await expect(applyProxySettings(dir, { baseUrl: `  ${f.baseUrl}///  ` })).resolves.toEqual(expected);
    const stored = await readModels(path.join(dir, "models.json"));
    expect(stored.providers["opencodex"]).toMatchObject({ apiKey: "opencodex-loopback", api: "openai-completions" });
    await expect(getProxySettings(dir)).resolves.toEqual(expected);
    await applyProxySettings(dir, { baseUrl: f.baseUrl, apiKey: "  " });
    expect(f.requests).toEqual([
      { url: "/v1/models", authorization: undefined },
      { url: "/v1/models", authorization: undefined },
    ]);
  });

  it("uses a supplied key and returns no secret", async () => {
    const f = await fixture();
    const result = await applyProxySettings(f.dir, { baseUrl: f.baseUrl, apiKey: "  private-token  " });
    expect(result).toEqual({ baseUrl: f.baseUrl, apiKeyConfigured: true, modelCount: 1 });
    expect(f.requests[0]?.authorization).toBe("Bearer private-token");
    expect((await readModels(f.file)).providers["opencodex"]?.apiKey).toBe("private-token");
  });

  it.each([undefined, "", "  "])("preserves the existing key for input %j, providers, model overrides, aliases, and root fields", async (apiKey) => {
    const f = await fixture({ data: [
      { id: "kept", supports_reasoning_effort: true, reasoning_efforts: [{ value: "high" }], capabilities: { context_length: 200000 } },
      { id: "gpt-6.1-sol", supports_reasoning_effort: true, reasoning_efforts: [{ value: "high" }] },
    ] });
    const custom = { id: "kept", name: "My name", contextWindow: 500000, reasoning: false, thinkingLevelMap: { high: null }, compat: { supportsStore: false } };
    const original = `${JSON.stringify({ version: 7, extra: { keep: true }, providers: {
      other: { baseUrl: "https://other.example/v1", apiKey: "other-secret", models: [{ id: "other" }] },
      opencodex: { baseUrl: "http://localhost:9999/v1", apiKey: "existing-secret", custom: 9, compat: { supportsDeveloperRole: true }, modelOverrides: { kept: { maxTokens: 42 } }, models: [custom, { id: "user-model" }, { id: "openai/gpt-6.1-sol", contextWindow: 500000 }] },
    } }, null, 4)}\n`;
    await writeFile(f.file, original);
    await expect(applyProxySettings(f.dir, { baseUrl: f.baseUrl, apiKey })).resolves.toEqual({ baseUrl: f.baseUrl, apiKeyConfigured: true, modelCount: 4 });
    const stored = await readModels(f.file);
    expect(stored["version"]).toBe(7);
    expect(stored["extra"]).toEqual({ keep: true });
    expect(stored.providers["other"]).toEqual(JSON.parse(original).providers.other);
    expect(stored.providers["opencodex"]).toMatchObject({ apiKey: "existing-secret", custom: 9, compat: { supportsDeveloperRole: true }, modelOverrides: { kept: { maxTokens: 42 } } });
    expect(stored.providers["opencodex"]?.models.find((model) => model["id"] === "kept")).toMatchObject({ ...custom, reasoning: true, thinkingLevelMap: { high: "high" } });
    expect(stored.providers["opencodex"]?.models.find((model) => model["id"] === "user-model")).toEqual({ id: "user-model" });
    expect(stored.providers["opencodex"]?.models.find((model) => model["id"] === "openai/gpt-6.1-sol")).toMatchObject({ contextWindow: 500000 });
    expect(f.requests[0]?.authorization).toBe("Bearer existing-secret");
    expect(await readFile(`${f.file}.backup`, "utf8")).toBe(original);
    const firstSave = await readFile(f.file, "utf8");
    await applyProxySettings(f.dir, { baseUrl: f.baseUrl });
    expect(await readFile(`${f.file}.backup`, "utf8")).toBe(firstSave);
    expect((await readdir(f.dir)).sort()).toEqual(["models.json", "models.json.backup"]);
  });

  it("converts advertised reasoning efforts and capabilities without inventing unsupported levels", async () => {
    const f = await fixture({ data: [
      { id: "sparse", supports_reasoning_effort: true, reasoning_efforts: [{ value: "HIGH", default: true }, { value: "max" }, { value: "ultra" }], capabilities: { input_modalities: ["text", "image", "audio"], context_length: 272000, max_output_tokens: 32000 } },
      { id: "off", reasoning_efforts: ["none", "low"], reasoning_effort: "low", context_window: 64000, max_output_tokens: 8192 },
      { id: "disabled", supports_reasoning_effort: false, reasoning_efforts: ["high"] },
      { id: "unknown", supports_reasoning_effort: true, reasoning_efforts: ["ultra"] },
      { id: "no-levels", supports_reasoning_effort: true },
      { id: "capability", capabilities: { reasoning_effort: ["high"], input_modalities: ["text"], max_tokens: 2048 } },
      { id: "gpt-6.1-sol", reasoning_efforts: ["high"] },
    ] });
    const result = await applyProxySettings(f.dir, { baseUrl: f.baseUrl });
    expect(result.modelCount).toBe(8);
    const models = (await readModels(f.file)).providers["opencodex"]!.models;
    expect(models[0]).toMatchObject({ id: "sparse", input: ["text", "image"], reasoning: true, defaultThinkingLevel: "high", contextWindow: 272000, maxTokens: 32000,
      thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "HIGH", xhigh: null, max: "max" } });
    expect(models[1]).toMatchObject({ reasoning: true, defaultThinkingLevel: "low", contextWindow: 64000, maxTokens: 8192, thinkingLevelMap: { off: "none", low: "low", high: null } });
    for (const model of models.slice(2, 5)) expect(model).toMatchObject({ reasoning: false, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null } });
    expect(models[2]?.["compat"]).toEqual({ supportsReasoningEffort: false });
    expect(models[5]).toMatchObject({ reasoning: true, maxTokens: 2048, thinkingLevelMap: { high: "high", low: null } });
    expect(models[7]).toMatchObject({ id: "openai/gpt-6.1-sol", thinkingLevelMap: { high: "high" } });
  });

  it.each(["ftp://example.com/v1", "https://user:secret@example.com/v1", "https://example.com/v1?key=secret", "https://example.com/v1#secret", "https://example.com/v1?", "not a url"])("rejects unsafe URL %s before networking", async (baseUrl) => {
    const f = await fixture();
    await expect(applyProxySettings(f.dir, { baseUrl })).rejects.toThrow();
    expect(f.requests).toEqual([]);
    expect(await readdir(f.dir)).toEqual([]);
  });

  it.each([{}, { data: [] }, { data: [null] }, { data: [{ id: "" }] }, { data: [{ id: " spaces " }] }, { data: [{ id: "duplicate" }, { id: "duplicate" }] }, { data: [{ id: "bad", reasoning_efforts: [{}] }] }, "invalid-json"])("leaves files untouched on malformed /models response %j", async (body) => {
    const f = await fixture(body);
    const original = '{"providers":{"opencodex":{"models":[{"id":"saved"}]}}}';
    await writeFile(f.file, original);
    await expect(applyProxySettings(f.dir, { baseUrl: f.baseUrl })).rejects.toThrow();
    expect(await readFile(f.file, "utf8")).toBe(original);
    expect(await readdir(f.dir)).toEqual(["models.json"]);
  });

  it.each(["broken", "[]", '{"providers":[]}', '{"providers":{"opencodex":null}}', '{"providers":{"opencodex":{"models":[{}]}}}', '{"providers":{"opencodex":{"apiKey":7}}}'])("rejects malformed existing file %s without overwriting it", async (original) => {
    const f = await fixture();
    await writeFile(f.file, original);
    await expect(getProxySettings(f.dir)).rejects.toThrow();
    await expect(applyProxySettings(f.dir, { baseUrl: f.baseUrl })).rejects.toThrow();
    expect(await readFile(f.file, "utf8")).toBe(original);
    expect(f.requests).toEqual([]);
  });

  it("does not persist an HTTP failure or leak its body", async () => {
    const f = await fixture({ error: "private-secret" }, 401);
    await expect(applyProxySettings(f.dir, { baseUrl: f.baseUrl, apiKey: "private-secret" })).rejects.toThrow("HTTP 401");
    expect(await readdir(f.dir)).toEqual([]);
  });

  it("bounds fetch with an abort signal and preserves files when the request aborts", async () => {
    const f = await fixture();
    server!.removeAllListeners("request");
    const requestArrived = once(server!, "request", { signal: AbortSignal.timeout(2000) });
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const applying = applyProxySettings(f.dir, { baseUrl: f.baseUrl });
    const rejected = expect(applying).rejects.toThrow("Proxy /models request failed or timed out");
    const [request] = await requestArrived as [IncomingMessage];
    expect(request.url).toBe("/v1/models");
    controller.abort();
    await rejected;
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(await readdir(f.dir)).toEqual([]);
  });
});
