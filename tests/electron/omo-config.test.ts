import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { omoConfigPath, readModelMapping, writeModelChain } from "../../electron/omo-config";

const SOURCE = `{
  // keep me
  "$schema": "https://example.invalid/omo.schema.json",
  "[opencode]": { "agents": { "explore": { "model": "old/model" } } },
  "[native]": {
    "agents": {
      "librarian": { "description": "docs", "model": "openai/gpt-6-luna-fast", "reasoning": "low" }
    },
    "categories": {
      "quick": { "models": ["kimi-coding/k3", { "model": "openai/gpt-6-luna", "reasoning": "high" }] }
    }
  },
  "telemetry": { "enabled": false },
}
`;

describe("omo.jsonc model mapping", () => {
  let home = "";
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "omo-ui-config-"));
    await mkdir(path.join(home, ".omo"), { recursive: true });
    await writeFile(omoConfigPath(home), SOURCE);
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("reads single-model and list entries of the native block only", async () => {
    const mapping = await readModelMapping(home);
    expect(mapping.agents).toEqual({ librarian: [{ model: "openai/gpt-6-luna-fast", reasoning: "low" }] });
    expect(mapping.categories["quick"]).toEqual([
      { model: "kimi-coding/k3", reasoning: null },
      { model: "openai/gpt-6-luna", reasoning: "high" },
    ]);
  });

  it("writes a chain in place and keeps comments and unrelated keys", async () => {
    await writeModelChain(home, "categories", "deep-high", [
      { model: "openai/gpt-6-astra", reasoning: "high" },
      { model: "anthropic/claude-opus-5-5", reasoning: null },
    ]);
    const text = await readFile(omoConfigPath(home), "utf8");
    expect(text).toContain("// keep me");
    const json = parse(text) as Record<string, Record<string, Record<string, unknown>>>;
    expect(json["[opencode]"]).toEqual({ agents: { explore: { model: "old/model" } } });
    expect(json["telemetry"]).toEqual({ enabled: false });
    expect(json["[native]"]?.["categories"]?.["deep-high"]).toEqual({
      models: [{ model: "openai/gpt-6-astra", reasoning: "high" }, "anthropic/claude-opus-5-5"],
    });
    expect((await readModelMapping(home)).categories["quick"]).toHaveLength(2);
  });

  it("replaces a single model with the chain, and reset keeps the entry's other fields", async () => {
    await writeModelChain(home, "agents", "librarian", [{ model: "kimi-coding/k3", reasoning: "low" }]);
    let json = parse(await readFile(omoConfigPath(home), "utf8")) as Record<string, Record<string, Record<string, unknown>>>;
    expect(json["[native]"]?.["agents"]?.["librarian"]).toEqual({ description: "docs", models: [{ model: "kimi-coding/k3", reasoning: "low" }] });
    await writeModelChain(home, "agents", "librarian", null);
    json = parse(await readFile(omoConfigPath(home), "utf8")) as Record<string, Record<string, Record<string, unknown>>>;
    expect(json["[native]"]?.["agents"]?.["librarian"]).toEqual({ description: "docs" });
    await writeModelChain(home, "categories", "quick", null);
    expect((await readModelMapping(home)).categories).toEqual({});
  });

  it("creates the file when it is missing and refuses malformed input", async () => {
    await rm(omoConfigPath(home));
    await writeModelChain(home, "agents", "explore", [{ model: "kimi-coding/k3", reasoning: null }]);
    expect((await readModelMapping(home)).agents).toEqual({ explore: [{ model: "kimi-coding/k3", reasoning: null }] });
    await expect(writeModelChain(home, "agents", "../x", null)).rejects.toThrow(/name/);
    await expect(writeModelChain(home, "agents", "explore", [{ model: "no-provider", reasoning: null }])).rejects.toThrow(/provider\/model/);
    await writeFile(omoConfigPath(home), "{ broken");
    await expect(writeModelChain(home, "agents", "explore", null)).rejects.toThrow(/not valid JSONC/);
    expect(await readFile(omoConfigPath(home), "utf8")).toBe("{ broken");
  });
});
