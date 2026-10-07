import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { launchApp, newSession, shot } from "./helpers.ts";

test("workspace panel previews real files and changes", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "omo-workspace-panel-"));
  execFileSync("git", ["init", workspace]);
  writeFileSync(path.join(workspace, "hello.ts"), "export const hello = 'workspace-ready';\n");
  const running = await launchApp({ omo: "fake", pickDir: workspace });
  try {
    await newSession(running.page);
    await running.page.getByTestId("workspace-toggle").click();
    const panel = running.page.getByTestId("workspace-panel");
    await panel.getByRole("button", { name: "hello.ts U", exact: true }).click();
    await expect(panel.locator('[data-read="true"]')).toContainText("workspace-ready");
    await panel.getByRole("button", { name: "Diff", exact: true }).click();
    await expect(panel.locator('[data-diff="true"]')).toContainText("+export const hello");
    await shot(running.page, "workspace-real-file-diff");
  } finally { await running.close(); }
});
