import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "jsonc-parser";
import { expect, test } from "@playwright/test";
import { TESTID } from "../src/ui/testids.ts";
import { byTestId, launchApp, setTheme, shot, tempDir } from "./helpers.ts";

test("Settings > Model edits agent and category model chains in ~/.omo/omo.jsonc", async () => {
  const home = tempDir("mapping-home");
  const config = path.join(home, ".omo", "omo.jsonc");
  mkdirSync(path.dirname(config), { recursive: true });
  writeFileSync(config, '{\n  // mine\n  "telemetry": { "enabled": false },\n  "[native]": { "agents": { "librarian": { "model": "fake/beta", "reasoning": "low" } } }\n}\n');
  const launched = await launchApp({ omo: "fake", extraEnv: { HOME: home } });
  try {
    const { page } = launched;
    const openModels = async (): Promise<void> => {
      await byTestId(page, TESTID.openSettings).click();
      await page.locator('[data-section="model"]').click();
    };
    await openModels();
    const row = (kind: string, name: string) => page.locator(`[data-testid="${TESTID.modelMappingRow}"][data-kind="${kind}"][data-name="${name}"]`);
    await expect(row("agents", "librarian")).toHaveAttribute("data-custom", "true");
    await expect(row("agents", "librarian").getByTestId(TESTID.modelMappingRung)).toHaveCount(1);
    await expect(row("categories", "deep-high")).not.toHaveAttribute("data-custom");

    const deepHigh = row("categories", "deep-high");
    await deepHigh.getByTestId(TESTID.modelMappingAdd).selectOption("fake/alpha");
    await expect(deepHigh.getByTestId(TESTID.modelMappingRung)).toHaveCount(1);
    await deepHigh.getByTestId(TESTID.modelMappingAdd).selectOption("fake/beta");
    await expect(deepHigh.getByTestId(TESTID.modelMappingRung)).toHaveCount(2);
    await deepHigh.getByRole("combobox", { name: /fake\/alpha/ }).selectOption("high");
    await expect.poll(() => {
      const json = parse(readFileSync(config, "utf8")) as Record<string, Record<string, Record<string, unknown>>>;
      return json["[native]"]?.["categories"]?.["deep-high"];
    }).toEqual({ models: [{ model: "fake/alpha", reasoning: "high" }, "fake/beta"] });
    await deepHigh.getByRole("button", { name: "Move up" }).nth(1).click();
    await expect(deepHigh.getByTestId(TESTID.modelMappingRung).first()).toContainText("fake/beta");
    await shot(page, "model-mapping-light");
    await page.keyboard.press("Escape");
    await setTheme(page, "dark");
    await openModels();
    await shot(page, "model-mapping-dark");
    await page.keyboard.press("Escape");
    await setTheme(page, "light");
    await openModels();

    await row("agents", "librarian").getByTestId(TESTID.modelMappingReset).click();
    await expect(row("agents", "librarian")).not.toHaveAttribute("data-custom");
    const text = readFileSync(config, "utf8");
    expect(text).toContain("// mine");
    const json = parse(text) as Record<string, Record<string, Record<string, unknown>>>;
    expect(json["telemetry"]).toEqual({ enabled: false });
    expect(json["[native]"]?.["agents"]?.["librarian"]).toBeUndefined();
    expect(json["[native]"]?.["categories"]?.["deep-high"]).toEqual({ models: ["fake/beta", { model: "fake/alpha", reasoning: "high" }] });
  } finally {
    await launched.close();
    rmSync(home, { recursive: true, force: true });
  }
});
