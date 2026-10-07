import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverMcpConfigs, importMcpConfig, readConfiguredMcpServers } from "../../electron/omo/mcp-config";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

afterEach(() => vi.clearAllMocks());

async function fixture(source: unknown, original?: string) {
  // Kept in the OS temp directory: this focused suite performs no file deletions.
  const dir = await fs.mkdtemp(path.join(tmpdir(), "omo-ui-mcp-import-"));
  const agentDir = path.join(dir, "agent");
  await fs.mkdir(agentDir);
  const sourcePath = path.join(dir, "claude.json");
  const text = typeof source === "string" ? source : JSON.stringify(source);
  await fs.writeFile(sourcePath, text);
  const file = path.join(agentDir, "mcp.json");
  if (original !== undefined) await fs.writeFile(file, original);
  return { agentDir, sourcePath, file, text };
}

describe("importMcpConfig", () => {
  it("discovers existing Claude servers and shows configured inventory before a session connects", async () => {
    const f = await fixture({});
    await fs.mkdir(path.join(f.agentDir, ".claude"));
    const sourcePath = path.join(f.agentDir, ".claude", ".mcp.json");
    await fs.writeFile(sourcePath, '\uFEFF' + JSON.stringify({ mcpServers: { docs: { command: "node", env: { TOKEN: "private" } } } }));
    const sources = await discoverMcpConfigs(f.agentDir);
    expect(sources).toEqual([{ label: "Claude", path: sourcePath, serverNames: ["docs"] }]);
    await importMcpConfig(f.agentDir, sourcePath);
    expect(await readConfiguredMcpServers(f.agentDir)).toEqual([{ name: "docs", enabled: true, type: "stdio" }]);
  });

  it("imports VS Code servers and preserves native authentication and connection fields", async () => {
    const entry = { type: "http", url: "https://example.com/mcp", auth: "bearer", bearerTokenEnv: "DOCS_TOKEN", oauth: { clientId: "public", scopes: ["read"] }, lifecycle: "eager", connectTimeoutMs: 7000 };
    const f = await fixture({ mcp: { servers: { docs: entry } } });
    await importMcpConfig(f.agentDir, f.sourcePath);
    expect(JSON.parse(await fs.readFile(f.file, "utf8")).mcpServers.docs).toEqual(entry);
  });
  it("imports stdio and HTTP/SSE in omo's mcp.json schema and preserves all existing fields and credentials", async () => {
    const original = '{\r\n  "settings": {"toolPrefix":"custom"}, "credential":"keep-private",\r\n  "mcpServers":{"existing":{"command":"old","env":{"TOKEN":"original-secret"},"enabled":false}}, "future":{"unchanged":true}\r\n}\r\n';
    const source = {
      mcpServers: {
        existing: { command: "replacement", env: { TOKEN: "new-secret" } },
        local: { command: "npx", args: ["-y", "server", ""], env: { TOKEN: "import-secret", EXPAND: "${TOKEN}" }, cwd: "C:/workspace", disabled: true },
        remote: { url: "https://example.com/mcp?token=private-query", headers: { Authorization: "Bearer private-header" } },
        legacy: { type: "sse", url: "http://localhost:8000/sse" },
      },
      unrelated: "must-not-import",
    };
    const f = await fixture(source, original);
    const settings = '{"model":"keep","apiKey":"settings-secret"}';
    const auth = '{"provider":{"access":"auth-secret"}}';
    await fs.writeFile(path.join(f.agentDir, "settings.json"), settings);
    await fs.writeFile(path.join(f.agentDir, "auth.json"), auth);
    const result = await importMcpConfig(f.agentDir, f.sourcePath);
    expect(result).toEqual({ imported: ["local", "remote", "legacy"] });
    expect(JSON.parse(await fs.readFile(f.file, "utf8"))).toEqual({
      ...JSON.parse(original),
      mcpServers: {
        existing: JSON.parse(original).mcpServers.existing,
        local: { type: "stdio", command: "npx", args: ["-y", "server", ""], env: { TOKEN: "import-secret", EXPAND: "${TOKEN}" }, cwd: "C:/workspace", enabled: false },
        remote: { type: "http", url: source.mcpServers.remote.url, headers: source.mcpServers.remote.headers },
        legacy: { type: "http", url: "http://localhost:8000/sse" },
      },
    });
    expect(await fs.readFile(`${f.file}.bak`, "utf8")).toBe(original);
    expect(await fs.readFile(f.sourcePath, "utf8")).toBe(f.text);
    expect(await fs.readFile(path.join(f.agentDir, "settings.json"), "utf8")).toBe(settings);
    expect(await fs.readFile(path.join(f.agentDir, "auth.json"), "utf8")).toBe(auth);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("creates missing agent directories and never manufactures an original backup for a new file", async () => {
    const f = await fixture({ mcpServers: { fresh: { type: "stdio", command: "node" } } });
    const agentDir = path.join(f.agentDir, "new");
    await expect(importMcpConfig(agentDir, f.sourcePath)).resolves.toEqual({ imported: ["fresh"] });
    expect(JSON.parse(await fs.readFile(path.join(agentDir, "mcp.json"), "utf8"))).toEqual({ mcpServers: { fresh: { type: "stdio", command: "node" } } });
    expect(await fs.readdir(agentDir)).toEqual(["mcp.json"]);
  });

  it("preserves native enabled and maps the documented Claude streamable-http alias to omo http", async () => {
    const f = await fixture({ mcpServers: {
      off: { command: "node", enabled: false },
      on: { type: "streamable-http", url: "https://example.com/mcp?key=private-query", enabled: true, disabled: false },
    } });
    await expect(importMcpConfig(f.agentDir, f.sourcePath)).resolves.toEqual({ imported: ["off", "on"] });
    expect(JSON.parse(await fs.readFile(f.file, "utf8"))).toEqual({ mcpServers: {
      off: { type: "stdio", command: "node", enabled: false },
      on: { type: "http", url: "https://example.com/mcp?key=private-query", enabled: true },
    } });
    expect(await fs.readFile(f.sourcePath, "utf8")).toBe(f.text);
  });

  it("leaves a duplicate-only import byte-identical, skips malformed duplicate entries, and writes no backup", async () => {
    const original = '{"mcpServers":{"same":{"enabled":false}}}  \n';
    const f = await fixture({ mcpServers: { same: null } }, original);
    await expect(importMcpConfig(f.agentDir, f.sourcePath)).resolves.toEqual({ imported: [] });
    expect(await fs.readFile(f.file, "utf8")).toBe(original);
    expect(await fs.readdir(f.agentDir)).toEqual(["mcp.json"]);
  });

  it("keeps one exact first backup across repeated successful imports", async () => {
    const original = '{"settings":{"importConfigs":["claude"]},"mcpServers":{}}\n';
    const f = await fixture({ mcpServers: { first: { command: "first" } } }, original);
    await importMcpConfig(f.agentDir, f.sourcePath);
    await fs.writeFile(f.sourcePath, JSON.stringify({ mcpServers: { second: { command: "second" } } }));
    await expect(importMcpConfig(f.agentDir, f.sourcePath)).resolves.toEqual({ imported: ["second"] });
    expect(Object.keys(JSON.parse(await fs.readFile(f.file, "utf8")).mcpServers)).toEqual(["first", "second"]);
    expect(await fs.readFile(`${f.file}.bak`, "utf8")).toBe(original);
    expect(await fs.readdir(f.agentDir)).toEqual(["mcp.json", "mcp.json.bak"]);
  });

  it.each([
    null, [], {}, { command: "" }, { command: "secret\0" }, { command: 7 },
    { command: "node", args: "secret" }, { command: "node", args: [4] },
    { command: "node", args: ["secret\0"] }, { command: "node", env: [] },
    { command: "node", env: { TOKEN: 4 } }, { command: "node", env: { "BAD=KEY": "secret" } },
    { command: "node", env: { TOKEN: "secret\0" } }, { command: "node", cwd: "" },
    { type: "stdio", command: "node", url: "https://example.com" },
    { type: "http", url: "https://example.com", command: "node" },
    { url: "file:///secret" }, { url: "not-a-url-secret" }, { url: 7 },
    { url: "https://example.com/secret\n" }, { url: "https://example.com", headers: [] },
    { url: "https://example.com", headers: { Authorization: 5 } },
    { url: "https://example.com", headers: { "Bad Header": "secret" } },
    { url: "https://example.com", headers: { Authorization: "secret\r\nInjected: true" } },
    { type: "websocket", url: "https://example.com" }, { command: "node", disabled: "true" },
    { url: "https://user:secret@example.com/mcp" }, { url: "https://secret@example.com/mcp" },
    { command: "node", enabled: "false" }, { command: "node", enabled: false, disabled: false },
  ])("rejects invalid new server %# before any write and does not expose values", async (entry) => {
    const original = '{"mcpServers":{"keep":{"command":"keep"}},"token":"original-secret"}\n';
    const f = await fixture({ mcpServers: { valid: { command: "node" }, bad: entry } }, original);
    const error = await importMcpConfig(f.agentDir, f.sourcePath).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("secret");
    expect(await fs.readFile(f.file, "utf8")).toBe(original);
    expect(await fs.readFile(f.sourcePath, "utf8")).toBe(f.text);
    expect(await fs.readdir(f.agentDir)).toEqual(["mcp.json"]);
  });

  it.each(['{"mcpServers": secret', "[]", "null", "{}", '{"mcpServers":[]}'])("rejects malformed source %# without changing agent files", async (source) => {
    const original = '{"mcpServers":{}}';
    const f = await fixture(source, original);
    await expect(importMcpConfig(f.agentDir, f.sourcePath)).rejects.toThrow();
    expect(await fs.readFile(f.file, "utf8")).toBe(original);
    expect(await fs.readdir(f.agentDir)).toEqual(["mcp.json"]);
  });

  it.each(["{secret", "[]", '{"mcpServers":[]}'])("never repairs a malformed existing configuration %#", async (original) => {
    const f = await fixture({ mcpServers: { fresh: { command: "node" } } }, original);
    await expect(importMcpConfig(f.agentDir, f.sourcePath)).rejects.toThrow();
    expect(await fs.readFile(f.file, "utf8")).toBe(original);
    expect(await fs.readdir(f.agentDir)).toEqual(["mcp.json"]);
  });

  it("treats prototype-like server names as own entries without losing them or overwriting existing ones", async () => {
    const f = await fixture('{"mcpServers":{"__proto__":{"command":"node"},"constructor":{"command":"npx"}}}', '{"mcpServers":{"constructor":{"enabled":false}}}');
    await expect(importMcpConfig(f.agentDir, f.sourcePath)).resolves.toEqual({ imported: ["__proto__"] });
    const config = JSON.parse(await fs.readFile(f.file, "utf8"));
    expect(Object.hasOwn(config.mcpServers, "__proto__")).toBe(true);
    expect(config.mcpServers["__proto__"]).toEqual({ type: "stdio", command: "node" });
    expect(config.mcpServers.constructor).toEqual({ enabled: false });
  });

  it("rejects selecting the destination itself, keeping source bytes read-only", async () => {
    const original = '{"mcpServers":{"same":{"command":"node"}}}';
    const f = await fixture({}, original);
    await expect(importMcpConfig(f.agentDir, f.file)).rejects.toThrow();
    expect(await fs.readFile(f.file, "utf8")).toBe(original);
  });

  it("does not replace the destination if backup creation fails", async () => {
    const original = '{"mcpServers":{}}';
    const f = await fixture({ mcpServers: { fresh: { command: "node" } } }, original);
    await fs.mkdir(`${f.file}.bak`);
    await expect(importMcpConfig(f.agentDir, f.sourcePath)).rejects.toThrow();
    expect(await fs.readFile(f.file, "utf8")).toBe(original);
    expect(await fs.readFile(f.sourcePath, "utf8")).toBe(f.text);
  });

  it("stages complete JSON in the same directory, then atomically renames; a failed rename leaves original bytes intact", async () => {
    const original = '{"mcpServers":{}}';
    const f = await fixture({ mcpServers: { fresh: { command: "node" } } }, original);
    const rename = vi.mocked(fs.rename).mockImplementationOnce(async (from, to) => {
      expect(path.dirname(String(from))).toBe(f.agentDir);
      expect(to).toBe(f.file);
      expect(JSON.parse(await fs.readFile(from, "utf8")).mcpServers.fresh).toEqual({ type: "stdio", command: "node" });
      expect(await fs.readFile(f.file, "utf8")).toBe(original);
      throw new Error("private-write-secret");
    });
    const error = await importMcpConfig(f.agentDir, f.sourcePath).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("private-write-secret");
    expect(rename).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(f.file, "utf8")).toBe(original);
    expect(await fs.readFile(`${f.file}.bak`, "utf8")).toBe(original);
    expect(await fs.readFile(f.sourcePath, "utf8")).toBe(f.text);
  });
});
