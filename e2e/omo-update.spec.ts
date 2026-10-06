import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { ENV } from "../shared/ipc.ts";
import { TESTID } from "../src/ui/testids.ts";
import { byTestId, launchApp, shot, tempDir, WT } from "./helpers.ts";

const fakeUpdater = path.join(WT, "tests/electron/fixtures/update-omo.mjs");

test("update checks are nonblocking and the localized setting persists across app launches", async () => {
  const home = tempDir("update-home");
  const userData = tempDir("update-prefs");
  const launch = (mode: string) => launchApp({
    omo: "fake", fakeHome: home, userData,
    extraEnv: { HOME: home, [ENV.omoBin]: fakeUpdater, FAKE_UPDATE_HOME: home, FAKE_UPDATE_MODE: mode, SHELL: "/bin/bash" },
  });
  const openSettings = async (page: Awaited<ReturnType<typeof launch>>["page"]) => {
    await byTestId(page, TESTID.openSettings).click();
    await byTestId(page, TESTID.settingsDialog).locator('[data-section="omo"]').click();
  };
  let launched: Awaited<ReturnType<typeof launch>> | null = null;
  try {
    launched = await launch("current");
    await openSettings(launched.page);
    await expect(byTestId(launched.page, TESTID.omoUpdateStatus)).toHaveAttribute("data-state", "current");
    await expect(byTestId(launched.page, TESTID.omoAutoUpdate)).toHaveAttribute("aria-checked", "true");
    await shot(launched.page, "omo-update-current-desktop");
    await launched.close();
    launched = await launch("offline");
    await openSettings(launched.page);
    await expect(byTestId(launched.page, TESTID.omoUpdateStatus)).toHaveAttribute("data-state", "failed");
    await expect(launched.page.locator("html")).toHaveAttribute("data-bridge-state", "connected");
    await shot(launched.page, "omo-update-failure-desktop");
    await byTestId(launched.page, TESTID.omoAutoUpdate).click();
    await expect(byTestId(launched.page, TESTID.omoAutoUpdate)).toHaveAttribute("aria-checked", "false");
    expect(await launched.page.evaluate(() => window.omo.getPreferences())).toMatchObject({ omoAutoUpdate: false });
    await launched.page.evaluate(() => window.omo.setPreferences({ locale: "ko" }));
    await launched.close();
    launched = await launch("offline");
    await openSettings(launched.page);
    await expect(byTestId(launched.page, TESTID.omoUpdateStatus)).toHaveAttribute("data-state", "disabled");
    await expect(byTestId(launched.page, TESTID.omoAutoUpdate)).toHaveAttribute("aria-checked", "false");
    await shot(launched.page, "omo-update-disabled-ko-desktop");
    await launched.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setContentSize(600, 820); });
    await shot(launched.page, "omo-update-disabled-ko-narrow");
    expect(readFileSync(path.join(home, "update.log"), "utf8")).toBe(
      "check\napp-server 5.1.4\ncheck\napp-server 5.1.4\napp-server 5.1.4\n",
    );
  } finally {
    await launched?.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
});
