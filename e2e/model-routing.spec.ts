import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, tempDir, shot } from "./helpers.ts";

test("available models append unique research fallbacks and replace a mapping target", async () => {
  const home = tempDir("routing-model-list");
  mkdirSync(path.join(home, ".omo"));
  writeFileSync(path.join(home, ".omo", "omo.json"), '{"model_profile":"daily-normal"}');
  const running = await launchApp({ omo: "fake", extraEnv: { HOME: home, USERPROFILE: home } });
  try {
    await running.page.getByTestId("open-settings").click();
    await running.page.locator('[data-section="model"]').click();
    const list = running.page.locator('[data-model-list-group="agents"][data-model-list-name="librarian"]');
    const editor = running.page.locator('[data-route-group="agents"][data-route-name="librarian"]');
    const values = await list.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value).filter(Boolean));
    expect(values.length).toBeGreaterThan(1);
    await list.selectOption(values[0]!);
    await list.selectOption(values[1]!);
    await list.selectOption(values[0]!);
    await expect(editor).toHaveValue(`${values[0]}\n${values[1]}`);
    await running.page.getByTestId("mapping-name").fill("research-main");
    await running.page.getByRole("button", { name: "Add mapping", exact: true }).click();
    const mapping = running.page.locator('[data-model-list-group="mappings"][data-model-list-name="research-main"]');
    await mapping.selectOption(values[0]!);
    await mapping.selectOption(values[1]!);
    await running.page.getByTestId("routing-save").click();
    await expect(running.page.getByTestId("routing-saved")).toBeVisible();
    const saved = JSON.parse(readFileSync(path.join(home, ".omo", "omo.json"), "utf8"));
    expect(saved["[senpi]"].agents.librarian.models).toEqual([values[0], values[1]]);
    expect(saved["[senpi]"].models["research-main"].model).toBe(values[1]);
    await shot(running.page, "model-routing-list");
  } finally { await running.close(); }
});
