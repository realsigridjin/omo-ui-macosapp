import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { TESTID } from "../src/ui/testids.ts";
import { byTestId, launchApp } from "./helpers.ts";

async function openLightSettings(page: Page): Promise<void> {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await byTestId(page, TESTID.openSettings).click();
  await byTestId(page, TESTID.settingsDialog).locator('[data-section="appearance"]').click();
  await byTestId(page, TESTID.settingsThemeLight).click();
  await expect(page.locator("body")).not.toHaveAttribute("data-ds-dark-theme");
}

test("reveals dark from the control centre and finishes with dark tokens", async () => {
  const launched = await launchApp({ omo: "fake" });
  try {
    const { page } = launched;
    await openLightSettings(page);
    await page.emulateMedia({ reducedMotion: "no-preference", colorScheme: "light" });
    const button = byTestId(page, TESTID.settingsThemeDark);
    const bounds = await button.boundingBox();
    if (bounds === null) throw new Error("theme control has no bounds");
    // Subscribe before clicking and pause at creation: no race with the 500 ms finish.
    await page.evaluate(() => {
      const original = Element.prototype.animate;
      Element.prototype.animate = function (frames, options) {
        const animation = original.call(this, frames, options);
        if (typeof options === "object" && options.pseudoElement?.startsWith("::view-transition")) {
          animation.pause();
          animation.currentTime = 250;
          if (options.pseudoElement === "::view-transition-new(root)") document.dispatchEvent(new Event("theme-reveal-ready"));
        }
        return animation;
      };
      const state = window as typeof window & { revealReady: Promise<void> };
      state.revealReady = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("theme reveal did not start")), 5000);
        document.addEventListener("theme-reveal-ready", () => { clearTimeout(timeout); resolve(); }, { once: true });
      });
    });
    await button.click();
    await page.evaluate(() => (window as typeof window & { revealReady: Promise<void> }).revealReady);
    const firstClip = await page.evaluate(() => {
      const animation = document.getAnimations().find((item) =>
        item.effect instanceof KeyframeEffect && item.effect.pseudoElement === "::view-transition-new(root)");
      if (!(animation?.effect instanceof KeyframeEffect)) throw new Error("missing root reveal animation");
      return String(animation.effect.getKeyframes()[0]?.clipPath);
    });
    const centre = /circle\(0px at ([\d.]+)px ([\d.]+)px\)/.exec(firstClip);
    expect(centre).not.toBeNull();
    expect(Math.abs(Number(centre?.[1]) - (bounds.x + bounds.width / 2))).toBeLessThanOrEqual(2);
    expect(Math.abs(Number(centre?.[2]) - (bounds.y + bounds.height / 2))).toBeLessThanOrEqual(2);
    const evidence = process.env["OMO_UI_THEME_EVIDENCE"];
    if (evidence) {
      mkdirSync(path.dirname(evidence), { recursive: true });
      await page.screenshot({ path: evidence });
    }
    await page.evaluate(async () => {
      const animations = document.getAnimations().filter((item) =>
        item.effect instanceof KeyframeEffect && (item.effect.pseudoElement === "::view-transition-old(root)"
          || item.effect.pseudoElement === "::view-transition-new(root)"));
      if (animations.length !== 2) throw new Error(`expected two snapshot animations, found ${animations.length}`);
      const finished = Promise.all(animations.map((animation) => animation.finished));
      for (const animation of animations) animation.play();
      await finished;
    });
    await expect(page.locator("body")).toHaveAttribute("data-ds-dark-theme", "");
  } finally {
    await launched.close();
  }
});

test("reduced motion, same darkness and unsupported transitions switch without snapshots", async () => {
  const launched = await launchApp({ omo: "fake" });
  try {
    const { page } = launched;
    await openLightSettings(page);
    await page.evaluate(() => {
      const original = document.startViewTransition.bind(document);
      document.startViewTransition = (...args) => {
        document.documentElement.dataset.transitionStarted = "true";
        return original(...args);
      };
    });
    await byTestId(page, TESTID.settingsThemeDark).click();
    await expect(page.locator("body")).toHaveAttribute("data-ds-dark-theme", "");
    expect(await page.evaluate(() => document.getAnimations().some((item) =>
      item.effect instanceof KeyframeEffect && item.effect.pseudoElement?.startsWith("::view-transition")))).toBe(false);
    await expect(page.locator("html")).not.toHaveAttribute("data-transition-started");
    await page.emulateMedia({ reducedMotion: "no-preference", colorScheme: "dark" });
    await byTestId(page, TESTID.settingsThemeSystem).click();
    await expect(byTestId(page, TESTID.settingsThemeSystem)).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("html")).not.toHaveAttribute("data-transition-started");
    await page.evaluate(() => { Object.defineProperty(document, "startViewTransition", { value: undefined }); });
    await byTestId(page, TESTID.settingsThemeLight).click();
    await expect(page.locator("body")).not.toHaveAttribute("data-ds-dark-theme");
    await expect(page.locator("html")).not.toHaveAttribute("data-transition-started");
  } finally {
    await launched.close();
  }
});

test("a later choice wins over an earlier theme reveal that has not applied yet", async () => {
  const launched = await launchApp({ omo: "fake" });
  try {
    const { page } = launched;
    await openLightSettings(page);
    await page.emulateMedia({ reducedMotion: "no-preference", colorScheme: "light" });
    // Both clicks land in one task, before the Dark reveal's snapshot update callback can run.
    await page.evaluate(({ dark, system }) => {
      (document.querySelector(`[data-testid="${dark}"]`) as HTMLButtonElement).click();
      (document.querySelector(`[data-testid="${system}"]`) as HTMLButtonElement).click();
    }, { dark: TESTID.settingsThemeDark, system: TESTID.settingsThemeSystem });
    await expect(byTestId(page, TESTID.settingsThemeSystem)).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator("body")).not.toHaveAttribute("data-ds-dark-theme");
    await expect(byTestId(page, TESTID.settingsThemeSystem)).toHaveAttribute("aria-pressed", "true");
    expect((await page.evaluate(() => window.omo.getPreferences())).theme).toBe("system");
  } finally {
    await launched.close();
  }
});
