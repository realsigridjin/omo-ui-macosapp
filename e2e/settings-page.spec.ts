import { expect, test, type Page } from "@playwright/test";
import { TESTID } from "../src/ui/testids.ts";
import { byTestId, launchApp, shot } from "./helpers.ts";

const SECTIONS: ReadonlyArray<{ section: string; label: string }> = [
  { section: "general", label: "General" },
  { section: "appearance", label: "Appearance" },
  { section: "keybindings", label: "Keybindings" },
  { section: "model", label: "Model" },
  { section: "mcp", label: "MCP" },
  { section: "skills", label: "Skills" },
  { section: "accounts", label: "Providers" },
  { section: "iphone", label: "Connections" },
  { section: "omo", label: "omo" },
  { section: "about", label: "About" },
];

const sidebarFill = (page: Page): Promise<string> =>
  page.evaluate(() => getComputedStyle(document.body).getPropertyValue("--dsw-specific-sidebar-fill").trim());

/** True when the point over the app sidebar is covered by the Settings page. */
const coversAppSidebar = (page: Page): Promise<boolean> =>
  page.evaluate((testId) => {
    const hit = document.elementFromPoint(8, Math.round(window.innerHeight / 2));
    return hit !== null && hit.closest(`[data-testid="${testId}"]`) !== null;
  }, TESTID.settingsDialog);

test("opens as a full page, walks every section through the breadcrumb, searches and closes", async () => {
  const launched = await launchApp({ omo: "fake" });
  try {
    const { page } = launched;
    await byTestId(page, TESTID.openSettings).click();
    const dialog = byTestId(page, TESTID.settingsDialog);
    await expect(dialog).toBeVisible();
    await expect.poll(() => coversAppSidebar(page)).toBe(true);
    await expect(byTestId(page, TESTID.settingsBreadcrumb)).toHaveText("Settings / General");

    for (const entry of SECTIONS) {
      await dialog.locator(`[data-section="${entry.section}"]`).click();
      await expect(byTestId(page, TESTID.settingsBreadcrumb)).toHaveText(`Settings / ${entry.label}`);
    }

    const navItems = dialog.locator(`[data-testid="${TESTID.settingsNavItem}"]`);
    await expect(navItems).toHaveCount(SECTIONS.length);
    await byTestId(page, TESTID.settingsNavSearch).fill("mcp");
    await expect(navItems).toHaveCount(1);
    await expect(navItems.first()).toHaveAttribute("data-section", "mcp");
    await byTestId(page, TESTID.settingsNavSearch).fill("");
    await expect(navItems).toHaveCount(SECTIONS.length);

    await byTestId(page, TESTID.settingsBreadcrumb).click();
    await page.keyboard.press("/");
    await expect(page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).resolves.toBe(
      TESTID.settingsNavSearch,
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(byTestId(page, TESTID.sidebar)).toBeVisible();

    await byTestId(page, TESTID.openSettings).click();
    await expect(dialog).toBeVisible();
    await byTestId(page, TESTID.settingsBack).click();
    await expect(dialog).toBeHidden();
  } finally {
    await launched.close();
  }
});

test("appearance changes the scheme and palette, and restore device defaults resets both", async () => {
  const launched = await launchApp({ omo: "fake" });
  try {
    const { page } = launched;
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await byTestId(page, TESTID.openSettings).click();
    const dialog = byTestId(page, TESTID.settingsDialog);
    await dialog.locator('[data-section="appearance"]').click();
    await expect(byTestId(page, TESTID.settingsBreadcrumb)).toHaveText("Settings / Appearance");
    const omoLightFill = await sidebarFill(page);
    await shot(page, "settings-appearance-light");

    await byTestId(page, TESTID.settingsThemeDark).click();
    await expect(page.locator("body")).toHaveAttribute("data-ds-dark-theme", "");
    await expect(byTestId(page, TESTID.settingsThemeDark)).toHaveAttribute("aria-pressed", "true");
    await shot(page, "settings-appearance-dark");

    const darkBefore = await sidebarFill(page);
    await dialog.locator(`[data-testid="${TESTID.settingsColorTheme}"][data-theme="classic"]`).click();
    await expect(page.locator("body")).toHaveAttribute("data-color-theme", "classic");
    await expect.poll(() => sidebarFill(page)).not.toBe(darkBefore);
    await shot(page, "settings-appearance-classic-dark");
    expect(await page.evaluate(() => window.omo.getPreferences())).toMatchObject({
      theme: "dark",
      colorTheme: "classic",
    });

    await byTestId(page, TESTID.settingsRestoreDefaults).click();
    await byTestId(page, TESTID.settingsRestoreConfirm).click();
    await expect(page.locator("body")).not.toHaveAttribute("data-color-theme", "classic");
    await expect(page.locator("body")).not.toHaveAttribute("data-ds-dark-theme", "");
    await expect(byTestId(page, TESTID.settingsThemeSystem)).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => sidebarFill(page)).toBe(omoLightFill);
    expect(await page.evaluate(() => window.omo.getPreferences())).toMatchObject({
      theme: "system",
      colorTheme: "omo",
      modelId: null,
      lastWorkspace: null,
    });
  } finally {
    await launched.close();
  }
});

test("the default model picker writes the preference and restore resets it", async () => {
  const launched = await launchApp({ omo: "fake" });
  try {
    const { page } = launched;
    await byTestId(page, TESTID.openSettings).click();
    const dialog = byTestId(page, TESTID.settingsDialog);
    await dialog.locator('[data-section="model"]').click();
    await expect(page.locator(`[data-testid="${TESTID.settingsModelRow}"]`).first()).toBeVisible();
    await byTestId(page, TESTID.settingsDefaultModel).selectOption("fake/beta");
    expect(await page.evaluate(() => window.omo.getPreferences())).toMatchObject({ modelId: "fake/beta" });

    await dialog.locator('[data-section="general"]').click();
    await shot(page, "settings-general-light");
    await byTestId(page, TESTID.settingsRestoreDefaults).click();
    await byTestId(page, TESTID.settingsRestoreConfirm).click();
    await expect.poll(() => page.evaluate(() => window.omo.getPreferences().then((prefs) => prefs.modelId))).toBeNull();
  } finally {
    await launched.close();
  }
});
