import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { TESTID } from "../src/ui/testids.ts";
import { byTestId, launchApp, shot, tempDir, type LaunchedApp } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

let fakeHome = "";
let userData = "";
let pickDir = "";
let projA = "";
let projB = "";
let launched: LaunchedApp | null = null;

const current = (): LaunchedApp => {
  if (launched === null) throw new Error("the app is not running");
  return launched;
};

const stepOf = (page: Page, step: string): Locator =>
  page.locator(`[data-testid="${TESTID.wizardStep}"][data-step="${step}"]`);

const projectRow = (page: Page, cwd: string): Locator =>
  page.locator(`[data-testid="${TESTID.wizardProjectRow}"][data-cwd="${cwd}"]`);

const preferencesOf = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(dir, "preferences.json"), "utf8"));

test.beforeAll(async () => {
  fakeHome = tempDir("fake-home");
  userData = tempDir("user-data");
  pickDir = tempDir("workspace");
  projA = tempDir("proj-a");
  projB = tempDir("proj-b");
  const now = Date.now() / 1000;
  const seedFile = path.join(fakeHome, "seed.json");
  writeFileSync(
    seedFile,
    JSON.stringify([
      { id: "onb-a-1", cwd: projA, name: "Wire the parser", preview: "wire the parser", updatedAt: now - 4 * 60 },
      { id: "onb-a-2", cwd: projA, name: "Ship the release", preview: "ship the release", updatedAt: now - 51 * 60 },
      { id: "onb-b-1", cwd: projB, name: "Sketch the API", preview: "sketch the api", updatedAt: now - 3600 },
    ]),
  );
  launched = await launchApp({
    omo: "fake",
    fakeHome,
    userData,
    pickDir,
    extraEnv: { FAKE_OMO_SEED_THREADS: seedFile },
    onboarding: true,
  });
});

test.afterAll(async () => {
  await launched?.close();
  launched = null;
  for (const dir of [fakeHome, userData, pickDir, projA, projB]) if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

test("first run steps through the wizard and remembers the choices", async () => {
  const { page } = current();
  const wizard = byTestId(page, TESTID.wizard);
  await expect(wizard).toBeVisible();
  await expect(stepOf(page, "welcome")).toHaveAttribute("data-state", "current");
  await expect(stepOf(page, "model")).toHaveAttribute("data-state", "todo");
  await expect(wizard).toContainText("5.1.4-fake");
  await shot(page, "ONB1-welcome-light");

  await page.keyboard.press("Enter");
  await expect(stepOf(page, "model")).toHaveAttribute("data-state", "current");
  await expect(stepOf(page, "welcome")).toHaveAttribute("data-state", "done");
  await expect(byTestId(page, TESTID.wizardModelOption)).toHaveCount(6);
  await shot(page, "ONB2-model-light");

  const beta = page.locator(`[data-testid="${TESTID.wizardModelOption}"][data-model-id="fake/beta"]`);
  await beta.click();
  await expect(beta).toHaveAttribute("aria-checked", "true");

  await page.keyboard.press("Enter");
  await expect(stepOf(page, "project")).toHaveAttribute("data-state", "current");
  const rows = byTestId(page, TESTID.wizardProjectRow);
  await expect(rows).toHaveCount(2);
  await expect(byTestId(page, TESTID.wizardSelectedCount)).toHaveText("0 of 2 selected");
  await expect(rows.first()).toHaveAttribute("title", projA);
  await expect(rows.first()).toContainText("2 threads");
  await expect(rows.nth(1)).toHaveAttribute("title", projB);
  await expect(rows.nth(1)).toContainText("1h");
  await shot(page, "ONB3-project-light-empty");

  await projectRow(page, projA).locator(`[data-testid="${TESTID.wizardProjectCheckbox}"]`).check();
  await expect(byTestId(page, TESTID.wizardSelectedCount)).toHaveText("1 of 2 selected");
  await byTestId(page, TESTID.wizardSelectAll).click();
  await expect(byTestId(page, TESTID.wizardSelectedCount)).toHaveText("2 of 2 selected");
  await byTestId(page, TESTID.wizardSelectNone).click();
  await expect(byTestId(page, TESTID.wizardSelectedCount)).toHaveText("0 of 2 selected");
  await projectRow(page, projA).locator(`[data-testid="${TESTID.wizardProjectCheckbox}"]`).check();
  await byTestId(page, TESTID.wizardNewProject).click();
  await expect(rows).toHaveCount(3);
  await expect(byTestId(page, TESTID.wizardSelectedCount)).toHaveText("2 of 3 selected");
  await expect(
    projectRow(page, pickDir).locator(`[data-testid="${TESTID.wizardProjectCheckbox}"]`),
  ).toBeChecked();
  await shot(page, "ONB3-project-light");

  await page.keyboard.press("Enter");
  await expect(stepOf(page, "ready")).toHaveAttribute("data-state", "current");
  await expect(wizard).toContainText("Fake Beta");
  await expect(wizard).toContainText(path.basename(projA));
  await expect(wizard).toContainText("OmO UI collects no telemetry.");
  await shot(page, "ONB4-ready-light");

  await byTestId(page, TESTID.wizardStart).click();
  await expect(wizard).toBeHidden();
  await expect(page.locator(`[data-testid="${TESTID.workspaceGroup}"][data-cwd="${projA}"]`)).toBeVisible();
  await expect(byTestId(page, TESTID.modelPicker)).toContainText("Fake Beta");
  const preferences = preferencesOf(userData);
  expect(preferences["onboardingCompleted"]).toBe(true);
  expect(preferences["modelId"]).toBe("fake/beta");
  expect(preferences["recentWorkspaces"]).toEqual([projA, pickDir]);
  expect(preferences["lastWorkspace"]).toBe(projA);
});

test("relaunching with the same profile skips the wizard", async () => {
  await current().close();
  launched = null;
  launched = await launchApp({
    omo: "fake",
    fakeHome,
    userData,
    pickDir,
    extraEnv: { FAKE_OMO_SEED_THREADS: path.join(fakeHome, "seed.json") },
    onboarding: true,
  });
  const { page } = current();
  await expect(byTestId(page, TESTID.wizard)).toBeHidden();
  await expect(page.locator(`[data-testid="${TESTID.workspaceGroup}"][data-cwd="${projA}"]`)).toBeVisible();
  await current().close();
  launched = null;
});

test("Settings ▸ About shows the wizard again and Escape closes it", async () => {
  launched = await launchApp({
    omo: "fake",
    fakeHome,
    userData,
    pickDir,
    extraEnv: { FAKE_OMO_SEED_THREADS: path.join(fakeHome, "seed.json") },
  });
  const { page } = current();
  await byTestId(page, TESTID.openSettings).click();
  const dialog = byTestId(page, TESTID.settingsDialog);
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-section="about"]').click();
  await byTestId(page, TESTID.settingsShowOnboarding).click();
  await expect(byTestId(page, TESTID.wizard)).toBeVisible();
  await expect(stepOf(page, "welcome")).toHaveAttribute("data-state", "current");
  await page.keyboard.press("Escape");
  await expect(byTestId(page, TESTID.wizard)).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(preferencesOf(userData)["onboardingCompleted"]).toBe(true);
  await current().close();
  launched = null;
});

test("closing the wizard early on a fresh profile still completes it", async () => {
  const earlyUserData = tempDir("user-data-early");
  launched = await launchApp({ omo: "fake", fakeHome, userData: earlyUserData, pickDir, onboarding: true });
  const { page } = current();
  await expect(byTestId(page, TESTID.wizard)).toBeVisible();
  await byTestId(page, TESTID.wizardClose).click();
  await expect(byTestId(page, TESTID.wizard)).toBeHidden();
  expect(preferencesOf(earlyUserData)["onboardingCompleted"]).toBe(true);
  await current().close();
  launched = null;

  launched = await launchApp({ omo: "fake", fakeHome, userData: earlyUserData, pickDir, onboarding: true });
  await expect(byTestId(current().page, TESTID.wizard)).toBeHidden();
  await current().close();
  launched = null;
  rmSync(earlyUserData, { recursive: true, force: true });
});

test("every step renders in the dark theme", async () => {
  const darkHome = tempDir("fake-home-dark");
  const darkUserData = tempDir("user-data-dark");
  writeFileSync(path.join(darkUserData, "preferences.json"), `${JSON.stringify({ theme: "dark" })}\n`);
  launched = await launchApp({
    omo: "fake",
    fakeHome: darkHome,
    userData: darkUserData,
    pickDir,
    extraEnv: { FAKE_OMO_SEED_THREADS: path.join(fakeHome, "seed.json") },
    onboarding: true,
  });
  const { page } = current();
  await expect(page.locator("body")).toHaveAttribute("data-ds-dark-theme", "");
  const wizard = byTestId(page, TESTID.wizard);
  await expect(wizard).toBeVisible();
  await shot(page, "ONB1-welcome-dark");

  await page.keyboard.press("Enter");
  await expect(stepOf(page, "model")).toHaveAttribute("data-state", "current");
  await shot(page, "ONB2-model-dark");

  await page.keyboard.press("Enter");
  await expect(stepOf(page, "project")).toHaveAttribute("data-state", "current");
  await shot(page, "ONB3-project-dark");

  await page.keyboard.press("Enter");
  await expect(stepOf(page, "ready")).toHaveAttribute("data-state", "current");
  await shot(page, "ONB4-ready-dark");

  await byTestId(page, TESTID.wizardStart).click();
  await expect(wizard).toBeHidden();
  await current().close();
  launched = null;
  for (const dir of [darkHome, darkUserData]) rmSync(dir, { recursive: true, force: true });
});
