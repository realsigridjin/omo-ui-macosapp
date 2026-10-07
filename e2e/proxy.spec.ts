import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchApp, shot, tempDir } from "./helpers.ts";

test("proxy settings fetch models, save reasoning metadata and reconnect omo", async () => {
  const server = createServer((request, response) => {
    expect(request.url).toBe("/v1/models");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "test-model", supports_reasoning_effort: true, reasoning_efforts: [{ value: "low" }, { value: "high" }] }] }));
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP listener");
  const fakeHome = tempDir("proxy-home");
  const app = await launchApp({ omo: "fake", fakeHome });
  try {
    await app.page.locator('[data-testid="open-settings"]').click();
    await app.page.locator('[data-section="omo"]').click();
    const apply = app.page.locator('[data-testid="proxy-apply"]');
    await expect(apply).toBeEnabled();
    await app.page.locator('[data-testid="proxy-url"]').fill(`http://127.0.0.1:${address.port}/v1`);
    await apply.click();
    await expect(app.page.locator('[data-testid="proxy-status"]')).toContainText("1");
    await expect(apply).toBeEnabled();
    await expect(app.page.locator("html")).toHaveAttribute("data-bridge-state", "connected");
    const config = JSON.parse(readFileSync(path.join(fakeHome, "models.json"), "utf8"));
    expect(config.providers.opencodex.baseUrl).toBe(`http://127.0.0.1:${address.port}/v1`);
    expect(config.providers.opencodex.models[0]).toMatchObject({ id: "test-model", reasoning: true, thinkingLevelMap: { low: "low", high: "high" } });
    await shot(app.page, "proxy-settings-windows");
  } finally {
    await app.close();
    const closed = once(server, "close");
    server.close();
    await closed;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
