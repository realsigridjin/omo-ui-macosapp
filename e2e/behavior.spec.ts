import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { TESTID } from "../src/ui/testids.ts";
import { byTestId, launchApp, newSession, send, setTheme, shot, tempDir, threadRow, type LaunchedApp } from "./helpers.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Writes a session file whose thread reads as last active `ageDays` ago; the fake derives updatedAt from its mtime. */
function writeStaleSession(fakeHome: string, id: string, cwd: string, text: string, ageDays: number): void {
  const dir = path.join(fakeHome, "sessions");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const at = new Date(Date.now() - ageDays * DAY_MS);
  const header = { type: "session", version: 3, id, timestamp: at.toISOString(), cwd };
  const entry = {
    type: "message",
    id: "entry-1",
    parentId: null,
    timestamp: at.toISOString(),
    message: { role: "user", content: [{ type: "text", text }], timestamp: at.getTime() },
  };
  writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(entry)}\n`);
  utimesSync(file, at, at);
}

function readNotifyLog(file: string): Record<string, unknown>[] {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

const settledToggle = (page: Page) => byTestId(page, TESTID.sidebarSettledToggle);
const settledRows = (page: Page) =>
  byTestId(page, TESTID.sidebarSettled).locator(`[data-testid="${TESTID.threadRow}"]`);

async function openSettings(page: Page): Promise<void> {
  await byTestId(page, TESTID.openSettings).click();
  await expect(byTestId(page, TESTID.settingsDialog)).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(byTestId(page, TESTID.settingsDialog)).toBeHidden();
}

/** Starts a quiet turn in `worker`, then activates `watcher` so the turn finishes in a non-active thread. */
async function finishInBackground(page: Page, watcher: string, worker: string): Promise<void> {
  await threadRow(page, worker).getByRole("button").first().click();
  await send(page, "SCENARIO:quiet:1500");
  await threadRow(page, watcher).getByRole("button").first().click();
}

test("thread notifications: background stays silent while focused, always logs, off logs nothing", async () => {
  const userData = tempDir("notify-user-data");
  const pickDir = tempDir("notify-workspace");
  const logFile = path.join(tempDir("notify-log"), "notify.jsonl");
  const launched = await launchApp({ omo: "fake", userData, pickDir, extraEnv: { OMO_UI_QA_NOTIFY_LOG: logFile } });
  try {
    const { page } = launched;
    const watcher = await newSession(page);
    const worker = await newSession(page);
    await finishInBackground(page, watcher, worker);
    await expect(byTestId(page, TESTID.noticeToast)).toContainText("Turn finished", { timeout: 15_000 });
    expect(readNotifyLog(logFile)).toEqual([]);

    await openSettings(page);
    await expect(byTestId(page, TESTID.settingsAutoSettle)).toBeVisible();
    await expect(byTestId(page, TESTID.settingsAutoSettleDays)).toHaveValue("3");
    const notifications = byTestId(page, TESTID.settingsThreadNotifications);
    await expect(notifications).toBeVisible();
    await notifications.getByRole("tab", { name: "Always" }).click();
    await expect(notifications.getByRole("tab", { name: "Always" })).toHaveAttribute("aria-selected", "true");
    await closeSettings(page);

    await finishInBackground(page, watcher, worker);
    await expect.poll(() => readNotifyLog(logFile).length, { timeout: 15_000 }).toBe(1);
    const logged = readNotifyLog(logFile);
    expect(logged[0]).toMatchObject({ threadId: worker, body: "Turn finished" });
    expect(typeof logged[0]?.["title"]).toBe("string");

    // Let the previous toast leave so the next "Turn finished" toast belongs to the turn below.
    await expect(byTestId(page, TESTID.noticeToast)).toHaveCount(0, { timeout: 20_000 });
    await openSettings(page);
    await notifications.getByRole("tab", { name: "Off" }).click();
    await closeSettings(page);
    await finishInBackground(page, watcher, worker);
    // The toast marks the turn as finished; with notifications Off the log must not grow.
    await expect(byTestId(page, TESTID.noticeToast)).toContainText("Turn finished", { timeout: 15_000 });
    expect(readNotifyLog(logFile)).toHaveLength(1);
  } finally {
    await launched.close();
    for (const dir of [userData, pickDir, path.dirname(logFile)]) rmSync(dir, { recursive: true, force: true });
  }
});

test("the in-app toast for another thread opens that thread", async () => {
  const pickDir = tempDir("toast-workspace");
  const launched = await launchApp({ omo: "fake", pickDir });
  try {
    const { page } = launched;
    const watcher = await newSession(page);
    const worker = await newSession(page);
    await finishInBackground(page, watcher, worker);
    const toast = byTestId(page, TESTID.noticeToast);
    await expect(toast).toContainText("Turn finished", { timeout: 15_000 });
    await page.getByRole("alert").getByRole("button", { name: "Open" }).click();
    await expect(threadRow(page, worker)).toHaveAttribute("aria-current", "page");
    await expect(threadRow(page, watcher)).not.toHaveAttribute("aria-current", "page");
  } finally {
    await launched.close();
    rmSync(pickDir, { recursive: true, force: true });
  }
});

test("a session idle for over three days settles, and new activity moves it back", async () => {
  const userData = tempDir("settle-user-data");
  const fakeHome = tempDir("settle-fake-home");
  const pickDir = tempDir("settle-workspace");
  writeStaleSession(fakeHome, "stale-thread", pickDir, "Ship the old feature", 4);
  const launched = await launchApp({ omo: "fake", userData, fakeHome, pickDir });
  try {
    const { page } = launched;
    await expect(settledToggle(page)).toContainText("1");
    await expect(byTestId(page, TESTID.threadRow)).toHaveCount(0);

    await settledToggle(page).click();
    const staleRow = threadRow(page, "stale-thread");
    await expect(staleRow).toBeVisible();
    await shot(page, "behavior-settled-light");
    await setTheme(page, "dark");
    await expect(staleRow).toBeVisible();
    await shot(page, "behavior-settled-dark");
    await setTheme(page, "light");

    await staleRow.getByRole("button").first().click();
    await send(page, "hello there");
    await expect(settledToggle(page)).toContainText("0", { timeout: 15_000 });
    await expect(staleRow).toBeVisible();
    await expect(settledRows(page)).toHaveCount(0);
  } finally {
    await launched.close();
    for (const dir of [userData, fakeHome, pickDir]) rmSync(dir, { recursive: true, force: true });
  }
});

test("manual Settle and Unsettle survive an app relaunch", async () => {
  const userData = tempDir("manual-user-data");
  const fakeHome = tempDir("manual-fake-home");
  const pickDir = tempDir("manual-workspace");
  writeStaleSession(fakeHome, "stale-thread", pickDir, "Old work", 4);
  const dirs = [userData, fakeHome, pickDir];
  let launched: LaunchedApp | null = null;
  const settleThroughMenu = async (page: Page, action: string): Promise<void> => {
    await threadRow(page, "stale-thread").locator(`[data-testid="${TESTID.threadMenu}"]`).click();
    await page.getByRole("menuitem", { name: action }).click();
  };
  try {
    launched = await launchApp({ omo: "fake", userData, fakeHome, pickDir });
    {
      const { page } = launched;
      await settledToggle(page).click();
      await expect(threadRow(page, "stale-thread")).toBeVisible();
      await settleThroughMenu(page, "Unsettle");
      await expect(settledToggle(page)).toContainText("0");
      await expect(threadRow(page, "stale-thread")).toBeVisible();
    }
    await launched.close();
    launched = await launchApp({ omo: "fake", userData, fakeHome, pickDir });
    {
      const { page } = launched;
      await expect(settledToggle(page)).toContainText("0");
      await expect(threadRow(page, "stale-thread")).toBeVisible();
      await settleThroughMenu(page, "Settle");
      await expect(settledToggle(page)).toContainText("1");
      await expect(threadRow(page, "stale-thread")).toHaveCount(0);
    }
    await launched.close();
    launched = await launchApp({ omo: "fake", userData, fakeHome, pickDir });
    {
      const { page } = launched;
      await expect(settledToggle(page)).toContainText("1");
      await settledToggle(page).click();
      await expect(threadRow(page, "stale-thread")).toBeVisible();
    }
  } finally {
    await launched?.close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});
