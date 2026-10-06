import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { TESTID } from "../src/ui/testids.ts";
import { byTestId, lastTurn, launchApp, newSession, send, setTheme, shot, tempDir, threadRow, type LaunchedApp } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

let fakeHome = "";
let userData = "";
let pickDir = "";
let launched: LaunchedApp | null = null;
let historyThreadId = "";

const current = (): LaunchedApp => {
  if (launched === null) throw new Error("the app is not running");
  return launched;
};

const start = async (): Promise<void> => {
  const skills = ["ulw-loop", "mass-ulw", "plan", "user-only-skill", "long-description-skill", "sixth-skill"].map((name) => ({
    name,
    path: `/fake/skills/${name}/SKILL.md`,
    scope: name === "ulw-loop" || name === "mass-ulw" ? "system" : "user",
    enabled: name !== "user-only-skill",
    description: name === "long-description-skill" ? "L".repeat(400) : `Use ${name} for the requested work.`,
  }));
  launched = await launchApp({
    omo: "fake", fakeHome, userData, pickDir,
    extraEnv: { FAKE_OMO_SKILLS: JSON.stringify({ data: [{ cwd: pickDir, skills, errors: [] }] }) },
  });
};

const close = async (): Promise<void> => {
  const running = current();
  const child = running.app.process();
  await running.close();
  launched = null;
  expect(child.exitCode).not.toBeNull();
  await test.info().attach("electron-cleanup", {
    body: `Closed Electron pid ${child.pid}; exit code ${child.exitCode}.`,
    contentType: "text/plain",
  });
};

test.beforeAll(async () => {
  fakeHome = tempDir("skills-fake-home");
  userData = tempDir("skills-user-data");
  pickDir = tempDir("skills-workspace");
  await start();
});

test.afterAll(async () => {
  try {
    if (launched !== null) await close();
  } finally {
    for (const dir of [fakeHome, userData, pickDir]) {
      if (dir === "") continue;
      rmSync(dir, { recursive: true, force: true });
      expect(existsSync(dir)).toBe(false);
    }
    await test.info().attach("directory-cleanup", {
      body: `Removed fakeHome ${fakeHome}, userData ${userData}, workspace ${pickDir}.`,
      contentType: "text/plain",
    });
  }
});

test("hero hints at session loading without priming the skill catalog", async () => {
  const { page, readFakeLog } = current();
  await expect(byTestId(page, TESTID.emptyHero)).toBeVisible();
  await byTestId(page, TESTID.composerInput).fill("/");
  const menu = byTestId(page, TESTID.skillMenu);
  await expect(menu.getByRole("status")).toBeVisible();
  await expect(menu.getByRole("status")).toHaveText("Start the session to load its skills");
  await expect(byTestId(page, TESTID.skillOption)).toHaveCount(0);
  expect(readFakeLog().filter((frame) => frame["method"] === "skills/list")).toEqual([]);
  expect(readFakeLog().filter((frame) => frame["method"] === "thread/start")).toEqual([]);
  await byTestId(page, TESTID.composerInput).fill("");
});

test("open session lists bundled and user-only skills in both themes", async () => {
  const { page, readFakeLog } = current();
  await newSession(page);
  await setTheme(page, "light");
  const input = byTestId(page, TESTID.composerInput);
  await input.fill("/");
  const rows = byTestId(page, TESTID.skillOption);
  await expect(rows).toHaveCount(6);
  for (const name of ["ulw-loop", "mass-ulw", "plan", "user-only-skill", "long-description-skill"]) {
    await expect(page.locator(`[data-testid="${TESTID.skillOption}"][data-skill-name="${name}"]`)).toBeVisible();
  }
  const userOnly = page.locator(`[data-testid="${TESTID.skillOption}"][data-skill-name="user-only-skill"]`);
  await expect(userOnly).toContainText("User only");
  await expect(userOnly).toBeEnabled();
  await shot(page, "C001-menu-light");
  await setTheme(page, "dark");
  await input.fill("");
  await input.fill("/");
  await expect(rows).toHaveCount(6);
  await shot(page, "C001-menu-dark");
  await setTheme(page, "light");
  await input.fill("");
  const log = readFakeLog();
  const loaded = log.findIndex((frame) => frame["method"] === "thread/start");
  const catalog = log.findIndex((frame) => frame["method"] === "skills/list");
  expect(loaded).toBeGreaterThanOrEqual(0);
  expect(catalog).toBeGreaterThan(loaded);
  expect(log[catalog]).toMatchObject({ params: { cwds: [pickDir] } });
});

test("arrows wrap, filtering ranks ulw-loop, Tab inserts and Escape preserves", async () => {
  const { page, readFakeLog } = current();
  const input = byTestId(page, TESTID.composerInput);
  const rows = byTestId(page, TESTID.skillOption);
  const options = byTestId(page, TESTID.skillMenu).getByRole("option");
  await input.fill("/");
  await expect(rows.first()).toHaveAttribute("aria-selected", "true");
  await expect(options).toHaveCount(7);
  await expect(options.last()).toHaveAttribute("data-command", "btw");
  await input.press("ArrowUp");
  await expect(options.last()).toHaveAttribute("aria-selected", "true");
  await input.press("ArrowDown");
  await expect(rows.first()).toHaveAttribute("aria-selected", "true");
  for (let index = 0; index < 7; index += 1) await input.press("ArrowDown");
  await expect(rows.first()).toHaveAttribute("aria-selected", "true");
  await input.fill("/ulw");
  await expect(rows.first()).toHaveAttribute("data-skill-name", "ulw-loop");
  await shot(page, "C001-filtered");
  await input.press("Tab");
  await expect(input).toHaveValue("/ulw-loop ");
  await expect(input).toBeFocused();
  await expect(byTestId(page, TESTID.skillMenu)).toBeHidden();
  expect(readFakeLog().filter((frame) => frame["method"] === "turn/start")).toEqual([]);
  await input.press("/");
  await expect(byTestId(page, TESTID.skillMenu)).toBeVisible();
  await input.press("Escape");
  await expect(byTestId(page, TESTID.skillMenu)).toBeHidden();
  await expect(input).toHaveValue("/ulw-loop /");
  await input.press("Backspace");
});

test("two selections send one canonical text message and show two chips", async () => {
  const { page, readFakeLog } = current();
  const input = byTestId(page, TESTID.composerInput);
  await input.press("/");
  await input.pressSequentially("mass");
  await page.locator(`[data-testid="${TESTID.skillOption}"][data-skill-name="mass-ulw"]`).click();
  await expect(input).toHaveValue("/ulw-loop /mass-ulw ");
  await shot(page, "C001-two-skills");
  await input.pressSequentially("build the thing");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(lastTurn(page)).toHaveAttribute("data-status", "completed");
  const starts = readFakeLog().filter((frame) => frame["method"] === "turn/start");
  expect(starts).toHaveLength(1);
  expect(starts[0]).toMatchObject({
    params: { input: [{ type: "text", text: "/skill:ulw-loop /skill:mass-ulw build the thing", text_elements: [] }] },
  });
  const bubble = byTestId(page, TESTID.userMessage);
  await expect(bubble).toHaveCount(1);
  await expect(bubble.locator(`[data-testid="${TESTID.skillChip}"]`)).toHaveCount(2);
  await expect(bubble).toContainText("build the thing");
  await expect(bubble).not.toContainText("/skill:");
  await expect(byTestId(page, TESTID.skillBodyToggle)).toHaveCount(0);
  await shot(page, "C002-invocation");
  await test.info().attach("canonical-wire-log", { body: JSON.stringify(readFakeLog(), null, 2), contentType: "application/json" });
});

test("word-internal slashes and paths leave the skill menu closed", async () => {
  const { page } = current();
  const input = byTestId(page, TESTID.composerInput);
  for (const text of ["a/b", "/tmp/project/file", "https://example.test/path"]) {
    await input.fill(text);
    await expect(input).toHaveValue(text);
    await expect(byTestId(page, TESTID.skillMenu)).toBeHidden();
  }
  await input.fill("");
});

test("a sixth distinct selection shows the five-skill limit", async () => {
  const { page, readFakeLog } = current();
  const input = byTestId(page, TESTID.composerInput);
  const before = readFakeLog().filter((frame) => frame["method"] === "turn/start").length;
  for (const name of ["ulw-loop", "mass-ulw", "plan", "user-only-skill", "long-description-skill"]) {
    await input.press("/");
    await input.pressSequentially(name);
    await page.locator(`[data-testid="${TESTID.skillOption}"][data-skill-name="${name}"]`).click();
  }
  await input.press("/");
  await input.pressSequentially("sixth");
  const draft = await input.inputValue();
  await page.locator(`[data-testid="${TESTID.skillOption}"][data-skill-name="sixth-skill"]`).click();
  await expect(byTestId(page, TESTID.skillLimit)).toHaveText("Up to 5 skills per message");
  await expect(input).toHaveValue(draft);
  expect(readFakeLog().filter((frame) => frame["method"] === "turn/start")).toHaveLength(before);
  await input.press("Escape");
  await input.fill("");
});

test("relaunch restores expanded skill history and keeps its hidden pointer in a collapsed notice", async () => {
  const { page } = current();
  historyThreadId = await newSession(page);
  await send(page, "SCENARIO:skills-history");
  await expect(lastTurn(page)).toHaveAttribute("data-status", "completed");
  const raw = readFileSync(path.join(fakeHome, "sessions", `${historyThreadId}.jsonl`), "utf8");
  await test.info().attach("seeded-skill-session", { body: raw, contentType: "application/x-ndjson" });
  expect(raw).toContain('omo-mass-ulw:skill-pointer');
  expect(raw).toContain('"display":false');
  await close();
  await start();
  const restored = current().page;
  const row = threadRow(restored, historyThreadId);
  await expect(row).toBeVisible();
  await row.getByRole("button").first().click();
  await expect(row).toHaveAttribute("aria-current", "page");
  await expect(row).toContainText("/ulw-loop /mass-ulw");
  await expect(row).not.toContainText("The user explicitly invoked");
  await expect(byTestId(restored, TESTID.conversationHeader)).toContainText("/ulw-loop /mass-ulw");
  const bubble = byTestId(restored, TESTID.userMessage);
  await expect(bubble).toHaveCount(1);
  const chips = bubble.locator(`[data-testid="${TESTID.skillChip}"]`);
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toContainText("/ulw-loop");
  await expect(chips.nth(1)).toContainText("/mass-ulw");
  await expect(bubble).toContainText("build the thing");
  await expect(byTestId(restored, TESTID.assistantMessage)).toHaveText("Built the thing.");
  // omo's hidden pointer stays out of the message and shows only as a collapsed special-message row.
  await expect(bubble).not.toContainText("Hidden skill pointer.");
  const pointer = restored.locator(`[data-testid="${TESTID.sessionNotice}"][data-type="omo-mass-ulw:skill-pointer"]`);
  await expect(pointer).toContainText("Skill pointer");
  await expect(pointer.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  const toggle = byTestId(restored, TESTID.skillBodyToggle);
  const bodies = byTestId(restored, TESTID.skillBody);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(bodies).toHaveCount(2);
  for (const body of await bodies.all()) await expect(body).toBeHidden();
  const contextToggle = byTestId(restored, TESTID.omoContextToggle);
  const context = byTestId(restored, TESTID.omoContext);
  await expect(contextToggle).toHaveText("omo context (2)");
  await expect(contextToggle).toHaveAttribute("aria-expanded", "false");
  await expect(context).toBeHidden();
  expect(await bubble.innerText()).not.toMatch(/<omo-|<skill-instruction/);
  await shot(restored, "C002-omo-context");
  await shot(restored, "C002-restored");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(bodies.nth(0)).toContainText("Run the loop.");
  await expect(bodies.nth(1)).toContainText("Dispatch the workflow.");
  for (const body of await bodies.all()) await expect(body).toBeVisible();
  expect(await bubble.innerText()).toContain("<skill-instruction");
  await contextToggle.click();
  await expect(contextToggle).toHaveAttribute("aria-expanded", "true");
  await expect(context).toBeVisible();
  await expect(context).toContainText("ulw-loop pointer");
  await expect(context).toContainText("System reminder");
  await expect(context).toContainText("Keep the synthetic context.");
  expect(await bubble.innerText()).toContain("<omo-");
  await shot(restored, "C002-omo-context-expanded");
  await shot(restored, "C002-expanded");
});

test("the ulw filter ranks ulw-loop first and drops unrelated skills", async () => {
  const { page } = current();
  await newSession(page);
  await byTestId(page, TESTID.composerInput).fill("/ulw");
  await expect(byTestId(page, TESTID.skillOption).first()).toHaveAttribute("data-skill-name", "ulw-loop");
  for (const name of ["plan", "user-only-skill", "long-description-skill", "sixth-skill"]) {
    await expect(page.locator(`[data-testid="${TESTID.skillOption}"][data-skill-name="${name}"]`)).toHaveCount(0);
  }
});
