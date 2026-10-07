import { expect, test } from "@playwright/test";
import { launchApp, shot } from "./helpers.ts";

test("app update reports unpublished releases and a verified installer candidate", async () => {
  const running = await launchApp({ omo: "fake" });
  try {
    await running.app.evaluate(() => {
      let checks = 0;
      globalThis.fetch = async () => new Response(JSON.stringify(++checks === 1 ? [] : [{
        tag_name: "v0.1.5-win.1", draft: false, prerelease: true,
        assets: [{ name: "OmO UI Windows Setup 0.1.5-win.1.exe", size: 5,
          browser_download_url: "https://github.com/JunesuChoi/omo-ui-windows/releases/download/v0.1.5-win.1/OmO%20UI%20Windows%20Setup%200.1.5-win.1.exe",
          digest: `sha256:${"a".repeat(64)}` }],
      }]), { status: 200 });
    });
    await running.page.getByTestId("open-settings").click();
    await running.page.locator('[data-section="about"]').click();
    await running.page.getByTestId("app-update-check").click();
    await expect(running.page.getByTestId("app-update-status")).toHaveAttribute("data-state", "unpublished");
    await expect(running.page.getByTestId("app-update-install")).toHaveCount(0);
    await running.page.getByTestId("app-update-check").click();
    await expect(running.page.getByTestId("app-update-status")).toHaveAttribute("data-state", "available");
    await expect(running.page.getByTestId("app-update-install")).toBeEnabled();
    await shot(running.page, "app-update-available");
  } finally { await running.close(); }
});
