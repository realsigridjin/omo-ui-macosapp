import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readOpencodexAccounts } from "../../electron/accounts/opencodex";

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(async server => {
    const closed = once(server, "close");
    server.closeAllConnections();
    server.close();
    await closed;
  }));
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function registration(baseUrl: string) {
  const homeDir = await mkdtemp(path.join(tmpdir(), "omo-opencodex-"));
  const agentDir = path.join(homeDir, "agent");
  const secretDir = path.join(homeDir, ".opencodex");
  await mkdir(agentDir);
  await mkdir(secretDir);
  const file = path.join(agentDir, "models.json");
  const tokenFile = path.join(secretDir, "admin-api-token");
  await writeFile(file, JSON.stringify({ providers: { opencodex: { baseUrl, apiKey: "inference-secret" } } }));
  await writeFile(tokenFile, "management-secret\n");
  return { homeDir, agentDir, file, tokenFile };
}

function json(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

describe("read-only opencodex accounts", () => {
  it("authenticates local GETs, projects all account families, and leaves files unchanged", async () => {
    const requests: Array<{ method: string | undefined; url: string | undefined; authorization: string | undefined }> = [];
    const secretFields = { accessToken: "access-secret", refreshToken: "refresh-secret", key: "key-secret", masked: "key-****cret", quota: { secret: "quota-secret" } };
    const routes: Record<string, unknown> = {
      "/api/oauth/providers": { providers: ["anthropic", "kiro"] },
      "/api/oauth/accounts?provider=anthropic": { activeAccountId: "oauth-1", accounts: [{ id: "oauth-1", alias: "Work", email: "work@example.test", paused: true, needsReauth: true, ...secretFields }] },
      "/api/oauth/accounts?provider=kiro": { activeAccountId: null, accounts: [{ id: "oauth-2", active: false, ...secretFields }] },
      "/api/codex-auth/accounts": { accounts: [{ id: "codex-1", alias: "Codex", email: "codex@example.test", ...secretFields }] },
      "/api/codex-auth/active": { activeCodexAccountId: "codex-1" },
      "/api/providers": [{ name: "anthropic", authMode: "oauth" }, { name: "openai", authMode: "forward" }, { name: "custom key", authMode: "key", apiKey: "provider-secret" }],
      "/api/providers/keys?name=custom%20key": { activeId: "key-1", keys: [{ id: "key-1", label: "Production", ...secretFields }, { id: "key-2", ...secretFields }] },
    };
    const endpoint = await listen((request, response) => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
      if (request.headers.authorization !== "Bearer management-secret") return json(response, { error: "Unauthorized" }, 401);
      const body = routes[request.url ?? ""];
      json(response, body ?? { error: "Unexpected route" }, body ? 200 : 404);
    });
    const f = await registration(`${endpoint.baseUrl}/v1///`);
    const before = await Promise.all([readFile(f.file), readFile(f.tokenFile), readdir(f.agentDir), readdir(path.dirname(f.tokenFile))]);
    const result = await readOpencodexAccounts(f.agentDir, f.homeDir);
    expect(result).toEqual({ baseUrl: endpoint.baseUrl, error: null, accounts: [
      { id: "oauth-1", provider: "anthropic", name: "Work", email: "work@example.test", active: true, paused: true, needsReauth: true },
      { id: "oauth-2", provider: "kiro", name: "Account 1", email: null, active: false, paused: false, needsReauth: false },
      { id: "codex-1", provider: "openai", name: "Codex", email: "codex@example.test", active: true, paused: false, needsReauth: false },
      { id: "key-1", provider: "custom key", name: "Production", email: null, active: true, paused: false, needsReauth: false },
      { id: "key-2", provider: "custom key", name: "API key 2", email: null, active: false, paused: false, needsReauth: false },
    ] });
    expect(requests).toEqual(Object.keys(routes).map(url => ({ method: "GET", url, authorization: "Bearer management-secret" })));
    expect(JSON.stringify(result)).not.toMatch(/secret|masked|quota|Token/);
    expect(await Promise.all([readFile(f.file), readFile(f.tokenFile), readdir(f.agentDir), readdir(path.dirname(f.tokenFile))])).toEqual(before);
  });

  it("verifies and pins localhost before sending the management token", async () => {
    const authorizations: Array<string | undefined> = [];
    const endpoint = await listen((request, response) => {
      authorizations.push(request.headers.authorization);
      json(response, {}, 401);
    });
    const f = await registration(`${endpoint.baseUrl.replace("127.0.0.1", "localhost")}/v1`);
    const result = await readOpencodexAccounts(f.agentDir, f.homeDir);
    expect(result.error).toMatch(/authorization failed/);
    expect(authorizations).toEqual(["Bearer management-secret"]);
  });

  it("does not use the inference key when the local admin token is missing", async () => {
    const authorizations: Array<string | undefined> = [];
    const endpoint = await listen((request, response) => {
      authorizations.push(request.headers.authorization);
      json(response, { error: "inference-secret management-secret" }, 401);
    });
    const f = await registration(`${endpoint.baseUrl}/v1`);
    const emptyHome = path.join(f.homeDir, "absent-home");
    const result = await readOpencodexAccounts(f.agentDir, emptyHome);
    expect(result.error).toMatch(/authorization failed/);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(authorizations).toEqual([undefined]);
  });

  it("never reads or sends local credentials for a remote unauthorized endpoint", async () => {
    const endpoint = await listen((_request, response) => json(response, {}, 401));
    const f = await registration("https://remote.example/v1");
    // An unreadable admin path would fail if a remote request attempted local token access.
    const invalidHome = path.join(f.tokenFile, "not-a-directory");
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => originalFetch(endpoint.baseUrl, init));
    const result = await readOpencodexAccounts(f.agentDir, invalidHome);
    expect(result.error).toMatch(/Remote.*authorization.*never sent remotely/);
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toEqual({ Accept: "application/json" });
    expect(fetchSpy.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it("rejects redirects without contacting the destination", async () => {
    const destinationRequests: string[] = [];
    const destination = await listen((request, response) => {
      destinationRequests.push(request.url ?? "");
      json(response, {});
    });
    const source = await listen((_request, response) => {
      response.writeHead(302, { Location: `${destination.baseUrl}/stolen` });
      response.end();
    });
    const f = await registration(`${source.baseUrl}/v1`);
    expect((await readOpencodexAccounts(f.agentDir, f.homeDir)).error).toMatch(/redirect/);
    expect(destinationRequests).toEqual([]);
  });

  it("aborts a stalled request using the bounded request signal", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const endpoint = await listen(() => {});
    const f = await registration(`${endpoint.baseUrl}/v1`);
    const requested = once(endpoint.server, "request");
    const result = readOpencodexAccounts(f.agentDir, f.homeDir);
    await requested;
    controller.abort();
    expect((await result).error).toMatch(/timeout/);
    expect(timeout).toHaveBeenCalledWith(5000);
  });

  it.each(["not-json", { providers: ["anthropic"] }, { providers: ["anthropic"], accounts: [{ accessToken: "secret" }] }])("returns a sanitized error for malformed responses %j", async body => {
    const endpoint = await listen((request, response) => {
      if (typeof body === "string") { response.end(body); return; }
      json(response, request.url === "/api/oauth/providers" ? { providers: ["anthropic"] } : body);
    });
    const f = await registration(`${endpoint.baseUrl}/v1`);
    const result = await readOpencodexAccounts(f.agentDir, f.homeDir);
    expect(result.accounts).toEqual([]);
    expect(result.error).toMatch(/invalid/);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("returns an empty unconfigured result without issuing a request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const home = await mkdtemp(path.join(tmpdir(), "omo-opencodex-empty-"));
    expect(await readOpencodexAccounts(home, home)).toEqual({ baseUrl: "", accounts: [], error: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["http://user:secret@127.0.0.1/v1", "file:///secret", "http://127.0.0.1/v1?token=secret"]) ("rejects unsafe registered URLs %s", async baseUrl => {
    const f = await registration(baseUrl);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await readOpencodexAccounts(f.agentDir, f.homeDir);
    expect(result.baseUrl).toBe("");
    expect(result.error).toMatch(/Invalid/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
