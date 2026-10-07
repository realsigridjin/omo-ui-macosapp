import { rmSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { TESTID } from "../src/ui/testids.ts";
import { byTestId, launchApp, newSession, send, setTheme, shot, tempDir, threadRow, type LaunchedApp } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

const SIDE_MARKER = "[OmO UI side chat background]";

let fakeHome = "";
let userData = "";
let pickDir = "";
let launched: LaunchedApp | null = null;
let mainId = "";
let secondId = "";

const start = async (): Promise<LaunchedApp> => {
  launched = await launchApp({ omo: "fake", fakeHome, userData, pickDir });
  return launched;
};

const current = (): LaunchedApp => {
  if (launched === null) throw new Error("the app is not running");
  return launched;
};

const panel = (page: Page) => byTestId(page, TESTID.sidePanel);
const mainTurns = (page: Page) => page.locator(`[data-testid="${TESTID.conversation}"] [data-testid="${TESTID.turn}"]`);
const sideTurns = (page: Page) => panel(page).locator(`[data-testid="${TESTID.sideTurn}"]`);
const sideQuestions = (page: Page) => panel(page).locator(`[data-testid="${TESTID.sideQuestion}"]`);
const sideAnswer = (page: Page) => panel(page).locator(`[data-testid="${TESTID.assistantMessage}"]`).last();

interface TurnStart {
  threadId: string;
  text: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function turnStarts(log: Record<string, unknown>[]): TurnStart[] {
  return log.flatMap((frame): TurnStart[] => {
    const params = frame["params"];
    if (frame["method"] !== "turn/start" || !isRecord(params) || typeof params["threadId"] !== "string") return [];
    const input = Array.isArray(params["input"]) ? params["input"] : [];
    const first: unknown = input[0];
    const text = isRecord(first) && typeof first["text"] === "string" ? first["text"] : "";
    return [{ threadId: params["threadId"], text }];
  });
}

function methodCount(log: Record<string, unknown>[], method: string): number {
  return log.filter((frame) => frame["method"] === method).length;
}

/** Records every thread row id the sidebar ever renders into `<html data-seen-rows>`. */
async function recordRows(page: Page): Promise<void> {
  await page.evaluate((rowTestId) => {
    const root = document.documentElement;
    const record = (): void => {
      const seen = new Set((root.dataset["seenRows"] ?? "").split(" ").filter((id) => id !== ""));
      for (const row of document.querySelectorAll(`[data-testid="${rowTestId}"]`)) {
        const id = row.getAttribute("data-thread-id");
        if (id !== null) seen.add(id);
      }
      root.dataset["seenRows"] = [...seen].join(" ");
    };
    record();
    new MutationObserver(record).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-thread-id"] });
  }, TESTID.threadRow);
}

async function seenRows(page: Page): Promise<string[]> {
  return ((await page.locator("html").getAttribute("data-seen-rows")) ?? "").split(" ").filter((id) => id !== "");
}

async function resize(width: number, height: number): Promise<void> {
  await current().app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
  }, { width, height });
  await expect.poll(() => current().page.evaluate(() => window.innerWidth)).toBe(width);
}

test.beforeAll(async () => {
  fakeHome = tempDir("fake-home");
  userData = tempDir("user-data");
  pickDir = tempDir("workspace");
  await start();
});

test.afterAll(async () => {
  await launched?.close();
  launched = null;
  for (const dir of [fakeHome, userData, pickDir]) if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

test("/btw in the composer answers in a side chat and leaves the main transcript alone", async () => {
  const { page, readFakeLog } = current();
  mainId = await newSession(page);
  await recordRows(page);
  await send(page, "fix the login bug");
  await expect(mainTurns(page)).toHaveCount(1);
  await expect(mainTurns(page).last()).toHaveAttribute("data-status", "completed");

  await send(page, "/btw what changed?");
  await expect(panel(page)).toBeVisible();
  await expect(sideQuestions(page).first()).toHaveText("what changed?");
  await expect(sideAnswer(page)).toContainText('Side answer to "what changed?" from 2 main messages; the first main request was "fix the login bug".');
  await expect(sideTurns(page).last()).toHaveAttribute("data-status", "completed");
  await expect(mainTurns(page)).toHaveCount(1);

  const starts = turnStarts(readFakeLog());
  expect(starts.filter((entry) => entry.threadId === mainId).map((entry) => entry.text)).toEqual(["fix the login bug"]);
  const sides = starts.filter((entry) => entry.threadId !== mainId);
  expect(sides).toHaveLength(1);
  expect(sides[0]?.text.startsWith(SIDE_MARKER)).toBe(true);
  expect(sides[0]?.text).toContain("<user>\nfix the login bug\n</user>");
  expect(sides[0]?.text.endsWith("Side question: what changed?")).toBe(true);
  expect(await seenRows(page)).toEqual([mainId]);
  await shot(page, "C001-light");
});

test("a follow-up in the side composer answers in the same side chat", async () => {
  const { page, readFakeLog } = current();
  const input = byTestId(page, TESTID.sideInput);
  await input.fill("and then?");
  await input.press("Enter");
  await expect(sideTurns(page)).toHaveCount(2);
  await expect(sideAnswer(page)).toContainText("echo: and then?");
  const sideThreads = new Set(turnStarts(readFakeLog()).filter((entry) => entry.threadId !== mainId).map((entry) => entry.threadId));
  expect(sideThreads.size).toBe(1);
  await expect(mainTurns(page)).toHaveCount(1);
});

test("a second /btw creates a second retained side chat listed in the picker", async () => {
  const { page } = current();
  await send(page, "/btw second question");
  await expect(sideQuestions(page).first()).toHaveText("second question");
  await expect(sideAnswer(page)).toContainText('Side answer to "second question"');
  const picker = byTestId(page, TESTID.sidePicker);
  await expect(picker).toContainText("BTW #2");
  await picker.click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: /BTW #1/ })).toContainText("what changed?");
  await expect(menu.getByRole("menuitem", { name: /BTW #2/ })).toContainText("second question");
  await expect(menu.getByRole("menuitem", { name: "New side chat" })).toBeVisible();
  await shot(page, "C001-picker");
  await menu.getByRole("menuitem", { name: /BTW #1/ }).click();
  await expect(sideQuestions(page).first()).toHaveText("what changed?");
  await expect(sideTurns(page)).toHaveCount(2);
});

test("closing and reopening the panel restores the side chats; ⌘E toggles it", async () => {
  const { page } = current();
  await byTestId(page, TESTID.sideClose).click();
  await expect(panel(page)).toBeHidden();
  await expect(byTestId(page, TESTID.sideToggle)).toContainText("2");
  await byTestId(page, TESTID.sideToggle).click();
  await expect(panel(page)).toBeVisible();
  await expect(byTestId(page, TESTID.sidePicker)).toContainText("BTW #1");
  await expect(sideQuestions(page).first()).toHaveText("what changed?");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+e" : "Control+e");
  await expect(panel(page)).toBeHidden();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+e" : "Control+e");
  await expect(panel(page)).toBeVisible();
  await expect(sideTurns(page)).toHaveCount(2);
});

test("the panel follows the Aside-derived design in dark and at 760x600", async () => {
  const { page } = current();
  await setTheme(page, "dark");
  await shot(page, "C001-dark");
  await resize(760, 600);
  await expect(panel(page)).toHaveAttribute("data-placement", "overlay");
  await shot(page, "C001-narrow-dark");
  await setTheme(page, "light");
  await shot(page, "C001-narrow");
  await resize(1280, 820);
  await expect(panel(page)).toHaveAttribute("data-placement", "docked");
});

test("/btw without a question opens the panel without sending, and the / menu lists /btw", async () => {
  const { page, readFakeLog } = current();
  await byTestId(page, TESTID.sideClose).click();
  const input = byTestId(page, TESTID.composerInput);
  const before = { turns: methodCount(readFakeLog(), "turn/start"), threads: methodCount(readFakeLog(), "thread/start") };
  await input.fill("/btw");
  await input.press("Escape");
  await input.press("Enter");
  await expect(panel(page)).toBeVisible();
  await expect(input).toHaveValue("");
  expect(methodCount(readFakeLog(), "turn/start")).toBe(before.turns);
  expect(methodCount(readFakeLog(), "thread/start")).toBe(before.threads);

  await input.fill("/bt");
  const command = page.locator(`[data-testid="${TESTID.commandOption}"][data-command="btw"]`);
  await expect(command).toBeVisible();
  await expect(command).toHaveAttribute("aria-selected", "true");
  await shot(page, "C002-menu");
  await input.press("Enter");
  await expect(input).toHaveValue("/btw ");
  await input.press("End");
  await input.pressSequentially("from the menu");
  await input.press("Enter");
  await expect(sideQuestions(page).first()).toHaveText("from the menu");
  await expect(sideAnswer(page)).toContainText('Side answer to "from the menu"');
});

test("/btw while a main turn runs neither steers nor interrupts it", async () => {
  const { page, readFakeLog } = current();
  await send(page, "SCENARIO:slow");
  const running = mainTurns(page).last();
  await expect(running.locator(`[data-testid="${TESTID.assistantMessage}"]`)).toContainText("tick 2");
  const input = byTestId(page, TESTID.composerInput);
  const sendButton = byTestId(page, TESTID.composerSend);
  await input.fill("keep going");
  await expect(byTestId(page, TESTID.steeringHint)).toBeVisible();
  const steerLabel = (await sendButton.getAttribute("aria-label")) ?? "";
  await input.fill("/btw are we there yet?");
  await expect(byTestId(page, TESTID.steeringHint)).toHaveCount(0);
  await expect(sendButton).not.toHaveAttribute("aria-label", steerLabel);
  await shot(page, "C002-btw-draft-running");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(sideAnswer(page)).toContainText('Side answer to "are we there yet?"');
  await expect(running).toHaveAttribute("data-status", "inProgress");
  expect(methodCount(readFakeLog(), "turn/steer")).toBe(0);
  expect(methodCount(readFakeLog(), "turn/interrupt")).toBe(0);
  await shot(page, "C002-running");
  await byTestId(page, TESTID.composerStop).click();
  await expect(running).toHaveAttribute("data-status", "interrupted");
});

test("another main thread shows only its own side chats, and a side error stays in the panel", async () => {
  const { page } = current();
  secondId = await newSession(page);
  await expect(panel(page)).toBeVisible();
  await expect(byTestId(page, TESTID.sideIntro)).toBeVisible();
  await expect(byTestId(page, TESTID.sidePicker)).toContainText("New side chat");
  await expect(byTestId(page, TESTID.sideContext)).toHaveAttribute("data-attached", "true");
  await shot(page, "C002-switch");

  await send(page, "/btw SCENARIO:fail now");
  const error = panel(page).locator(`[data-testid="${TESTID.sideError}"]`);
  await expect(error).toContainText("Simulated turn failure");
  await expect(byTestId(page, TESTID.noticeToast)).toHaveCount(0);
  await shot(page, "C002-error");

  await send(page, `/btw ${"does a long side question still leave room for the close button? ".repeat(3).trim()}`);
  await expect(sideAnswer(page)).toContainText("Side answer to");
  const panelBox = await panel(page).boundingBox();
  const closeBox = await byTestId(page, TESTID.sideClose).boundingBox();
  expect(panelBox !== null && closeBox !== null && closeBox.x + closeBox.width <= panelBox.x + panelBox.width).toBe(true);
  await shot(page, "C002-long-question");

  await threadRow(page, mainId).getByRole("button").first().click();
  await expect(threadRow(page, mainId)).toHaveAttribute("aria-current", "page");
  await expect(byTestId(page, TESTID.sidePicker)).toContainText("BTW #");
  await expect(sideQuestions(page).first()).not.toHaveText("SCENARIO:fail now");
});

test("side threads never appear in the sidebar and the side chats survive a relaunch", async () => {
  const { readFakeLog } = current();
  const sideIds = [...new Set(turnStarts(readFakeLog()).map((entry) => entry.threadId))].filter((id) => id !== mainId && id !== secondId);
  expect(sideIds.length).toBeGreaterThanOrEqual(5);
  const seen = await seenRows(current().page);
  expect(seen.sort()).toEqual([mainId, secondId].sort());

  await current().close();
  launched = null;
  const { page } = await start();
  await expect(threadRow(page, mainId)).toBeVisible();
  await expect(threadRow(page, secondId)).toBeVisible();
  for (const id of sideIds) await expect(threadRow(page, id)).toHaveCount(0);
  await threadRow(page, mainId).getByRole("button").first().click();
  await byTestId(page, TESTID.sideToggle).click();
  await expect(panel(page)).toBeVisible();
  await expect(sideQuestions(page).first()).toHaveText("are we there yet?");
  await expect(sideAnswer(page)).toContainText('Side answer to "are we there yet?"');
  await byTestId(page, TESTID.sidePicker).click();
  await expect(page.getByRole("menu").getByRole("menuitem", { name: /BTW #4/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await shot(page, "C002-restored");
});
