import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { TESTID } from "../src/ui/testids.ts";
import { byTestId, launchApp, setTheme, shot, tempDir } from "./helpers.ts";

test("imports MCP JSON through the native file picker without replacing existing servers", async () => {
  const home = tempDir("mcp-import");
  const source = path.join(home, "source.json");
  writeFileSync(source, JSON.stringify({ mcpServers: { imported: { command: "node", args: ["server.mjs"], env: { KEEP: "value" } } } }));
  const running = await launchApp({ omo: "fake", fakeHome: home });
  try {
    await running.app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    }, source);
    await byTestId(running.page, TESTID.openSettings).click();
    await running.page.locator('[data-section="mcp"]').click();
    await running.page.getByTestId("mcp-import").click();
    await expect(running.page.getByTestId("mcp-import-status")).toContainText("1");
    await expect(running.page.locator("html")).toHaveAttribute("data-bridge-state", "connected");
    await expect(running.page.locator('[data-testid="mcp-configured-server"][data-server-name="imported"]')).toBeVisible();
    expect(JSON.parse(readFileSync(path.join(home, "mcp.json"), "utf8"))).toMatchObject({ mcpServers: { imported: { command: "node", args: ["server.mjs"] } } });
  } finally { await running.close(); rmSync(home, { recursive: true, force: true }); }
});

for (const theme of ["light", "dark"] as const) {
  test(`MCP inventory, tools, refresh and notification (${theme})`, async () => {
    const workspace = tempDir("mcp-workspace");
    const running = await launchApp({ omo: "fake", pickDir: workspace });
    const { page } = running;
    try {
      await setTheme(page, theme);
      await byTestId(page, TESTID.openSettings).click();
      await page.locator('[data-section="mcp"]').click();
      const connected = page.locator(`[data-testid="${TESTID.mcpServer}"][data-server-name="demo-tools"]`);
      const needsLogin = page.locator(`[data-testid="${TESTID.mcpServer}"][data-server-name="pganalyze"]`);
      await expect(connected).toHaveAttribute("data-status", "connected");
      await expect(connected).toContainText("Connected");
      await expect(connected).toContainText("Version 1.0.0");
      await expect(connected).toContainText("3 tools");
      await expect(needsLogin).toHaveAttribute("data-status", "needs_auth");
      await expect(needsLogin).toContainText("Needs login");
      await expect(needsLogin).toContainText("0 tools");
      await byTestId(page, TESTID.mcpServerTools).locator("summary").click();
      await expect(connected.locator("code")).toHaveText(["list_projects", "read_document", "search"]);
      await expect(connected).toContainText("List available demo projects.");
      await expect(connected).toContainText("Read a demo document by ID.");
      await expect(connected).toContainText("Search the demo knowledge base.");
      const requests = () => running.readFakeLog().filter((entry) => entry["method"] === "mcpServerStatus/list");
      const before = requests().length;
      // Observe the exact completed refresh state before triggering the button, not a timed log poll.
      await page.evaluate(({ sectionId, refreshId }) => new Promise<void>((resolve, reject) => {
        const section = document.querySelector(`[data-testid="${sectionId}"]`)!;
        const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("refresh did not complete")); }, 5000);
        const observer = new MutationObserver((records) => {
          if (!records.some((record) => record.oldValue === "true") || section.getAttribute("aria-busy") !== "false") return;
          clearTimeout(timeout); observer.disconnect(); resolve();
        });
        observer.observe(section, { attributes: true, attributeFilter: ["aria-busy"], attributeOldValue: true });
        (document.querySelector(`[data-testid="${refreshId}"]`) as HTMLButtonElement).click();
      }), { sectionId: TESTID.settingsMcp, refreshId: TESTID.mcpRefresh });
      expect(requests()).toHaveLength(before + 1);
      // The fake changes its server version and emits the notification on thread/start.
      await page.evaluate(async (cwd) => { await window.omo.request("thread/start", { cwd }); }, workspace);
      await expect(connected).toContainText("Version 1.1.0");
      expect(requests().length).toBeGreaterThan(before + 1);
      await shot(page, `mcp-${theme}`);
    } finally {
      await running.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}

test("MCP empty configuration", async () => {
  const running = await launchApp({ omo: "fake", extraEnv: { FAKE_OMO_MCP_EMPTY: "1" } });
  try {
    await byTestId(running.page, TESTID.openSettings).click();
    await running.page.locator('[data-section="mcp"]').click();
    await expect(byTestId(running.page, TESTID.mcpEmpty)).toContainText("No MCP servers configured");
    await expect(byTestId(running.page, TESTID.settingsMcp)).toContainText("~/.omo/agent/mcp.json");
    await expect(byTestId(running.page, TESTID.mcpServer)).toHaveCount(0);
  } finally { await running.close(); }
});
