import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readModelRouting, saveModelRouting } from "../../electron/omo/model-routing";

describe("native model routing", () => {
  it("reads JSONC native overrides and preserves root fields, other harnesses and reasoning objects", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "omo-ui-routing-"));
    await mkdir(path.join(home, ".omo"));
    const file = path.join(home, ".omo", "omo.jsonc");
    const original = '// user notes\n{"model_profile":"daily-normal","[codex]":{"task":{"concurrency":2}},"categories":{"quick":{"description":"keep","models":[{"model":"openai/gpt-6.1-sol","reasoning":"high"}]}},"[senpi]":{"agents":{"librarian":{"models":["opencodex/openai/gpt-6.1-sol:high"],"prompt_append":"keep"}}},}';
    await writeFile(file, original);
    const settings = await readModelRouting(home);
    expect(settings.agents[0]?.models).toEqual(["opencodex/openai/gpt-6.1-sol:high"]);
    await saveModelRouting(home, { categories: [{ name: "quick", models: ["openai/gpt-6.1-sol:high", "openai/other:low"] }], agents: [{ name: "librarian", models: ["openai/other:high"] }], mappings: [{ name: "research", models: ["openai/other:high"] }] });
    const result = JSON.parse(await readFile(file, "utf8"));
    expect(result["model_profile"]).toBe("daily-normal");
    expect(result["[codex]"]).toEqual({ task: { concurrency: 2 } });
    expect(result["[senpi]"].categories.quick).toEqual({ description: "keep", models: [{ model: "openai/gpt-6.1-sol", reasoning: "high" }, "openai/other:low"] });
    expect(result["[senpi]"].agents.librarian).toEqual({ prompt_append: "keep", models: ["openai/other:high"] });
    expect(result["[senpi]"].models.research.model).toBe("openai/other:high");
    expect(await readFile(`${file}.models.bak`, "utf8")).toBe(original);
  });
  it("rejects invalid references without changing the original configuration", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "omo-ui-routing-invalid-"));
    await mkdir(path.join(home, ".omo"));
    const file = path.join(home, ".omo", "omo.json");
    await writeFile(file, '{"model_profile":"daily-normal"}');
    await expect(saveModelRouting(home, { categories: [], agents: [], mappings: [{ name: "unsafe", models: ["a\nb"] }] })).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe('{"model_profile":"daily-normal"}');
  });
});
