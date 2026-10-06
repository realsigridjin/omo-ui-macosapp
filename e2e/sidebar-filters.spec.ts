import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { TESTID } from "../src/ui/testids.ts";
import { byTestId, launchApp, send, tempDir, threadRow, type LaunchedApp } from "./helpers.ts";

let fakeHome = "";
let pickDir = "";
let userData = "";
let launched: LaunchedApp | null = null;

const current = (): LaunchedApp => {
  if (launched === null) throw new Error("the app is not running");
  return launched;
};

const periodPill = (page: Page, period: string): Locator =>
  page.locator(`[data-testid="${TESTID.sidebarFilterPeriod}"][data-period="${period}"]`);

test.beforeAll(async () => {
  fakeHome = tempDir("fake-home");
  pickDir = tempDir("workspace");
  // These seeds are three days old and older; auto-settle would move them into the Settled section.
  userData = tempDir("user-data");
  writeFileSync(path.join(userData, "preferences.json"), JSON.stringify({ autoSettle: false }));
  const now = Date.now() / 1000;
  const seedFile = path.join(fakeHome, "seed.json");
  writeFileSync(
    seedFile,
    JSON.stringify([
      { id: "three-days", cwd: pickDir, name: "Three days old", preview: "three", updatedAt: now - 3 * 86400 },
      { id: "ten-days", cwd: pickDir, name: "Ten days old", preview: "ten", updatedAt: now - 10 * 86400 },
      { id: "forty-days", cwd: pickDir, name: "Forty days old", preview: "forty", updatedAt: now - 40 * 86400 },
    ]),
  );
  launched = await launchApp({ omo: "fake", fakeHome, userData, pickDir, extraEnv: { FAKE_OMO_SEED_THREADS: seedFile } });
});

test.afterAll(async () => {
  await launched?.close();
  launched = null;
  for (const dir of [fakeHome, pickDir, userData]) if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

test("period pills keep only threads updated within the period, one period at a time", async () => {
  const { page } = current();
  const rows = byTestId(page, TESTID.threadRow);
  await expect(rows).toHaveCount(3);

  await periodPill(page, "week").click();
  await expect(periodPill(page, "week")).toHaveAttribute("aria-pressed", "true");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-thread-id", "three-days");

  await periodPill(page, "month").click();
  await expect(periodPill(page, "week")).toHaveAttribute("aria-pressed", "false");
  await expect(rows).toHaveCount(2);

  await periodPill(page, "month").click();
  await expect(periodPill(page, "month")).toHaveAttribute("aria-pressed", "false");
  await expect(rows).toHaveCount(3);
});

test("the running pill keeps only threads with a running turn until the turn ends", async () => {
  const { page } = current();
  const rows = byTestId(page, TESTID.threadRow);
  const running = byTestId(page, TESTID.sidebarFilterRunning);
  await threadRow(page, "ten-days").getByRole("button").first().click();
  await send(page, "SCENARIO:flood:6000:10");
  await expect(running).toContainText("1");

  await running.click();
  await expect(running).toHaveAttribute("aria-pressed", "true");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-thread-id", "ten-days");

  await byTestId(page, TESTID.composerStop).click();
  await expect(byTestId(page, TESTID.sidebarNoMatch)).toBeVisible();
  await expect(rows).toHaveCount(0);

  await byTestId(page, TESTID.sidebarFilterClear).click();
  await expect(running).toHaveAttribute("aria-pressed", "false");
  await expect(rows).toHaveCount(3);
});
