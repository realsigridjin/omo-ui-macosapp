import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { TESTID } from "../src/ui/testids.ts";
import { byTestId, launchApp, newSession, send, setTheme, shot, tempDir, threadRow, type LaunchedApp } from "./helpers.ts";

const WORKSPACE = path.join(tmpdir(), "omo-ui-qa", "ws1");
const MODEL_TIMEOUT_MS = 180_000;
const RECONNECT_TIMEOUT_MS = 30_000;

test.describe.configure({ mode: "serial" });
test.skip(process.env["OMO_UI_E2E_REAL"] !== "1", "set OMO_UI_E2E_REAL=1 to drive the installed omo");

let userData = "";
let launched: LaunchedApp | null = null;
let threadId = "";
const createdThreads = new Set<string>();

const start = async (): Promise<LaunchedApp> => {
  launched = await launchApp({ omo: "installed", userData, pickDir: WORKSPACE });
  return launched;
};

const current = (): LaunchedApp => {
  if (launched === null) throw new Error("the app is not running");
  return launched;
};

async function settleTurn(page: Page, done: Locator): Promise<void> {
  const deadline = Date.now() + MODEL_TIMEOUT_MS;
  const accept = byTestId(page, TESTID.approvalAccept);
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("the turn did not finish in time");
    await expect(done.or(accept).first()).toBeVisible({ timeout: remaining });
    if (await done.isVisible()) return;
    await accept.first().click();
  }
}

async function sendAndFinish(page: Page, text: string): Promise<Locator> {
  const turns = byTestId(page, TESTID.turn);
  const index = await turns.count();
  await send(page, text);
  const turn = turns.nth(index);
  const settled = page.locator('[data-status="completed"], [data-status="failed"], [data-status="interrupted"]');
  await settleTurn(page, turn.and(settled));
  await expect(turn).toHaveAttribute("data-status", "completed");
  return turn;
}

test.beforeAll(async () => {
  rmSync(WORKSPACE, { recursive: true, force: true });
  mkdirSync(WORKSPACE, { recursive: true });
  userData = tempDir("real-user-data");
  await start();
});

test.afterAll(async () => {
  if (launched !== null) {
    const { page } = launched;
    const workspaces = [WORKSPACE, realpathSync(WORKSPACE)];
    for (const id of createdThreads) {
      // Only threads this spec started, and only while omo still reports them in its own workspace.
      const read = await page.evaluate(async (threadId) => {
        try {
          return { ok: true as const, cwd: (await window.omo.request("thread/read", { threadId })).thread.cwd };
        } catch (error) {
          return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
        }
      }, id);
      if (read.ok && workspaces.includes(read.cwd)) {
        await page.evaluate((threadToDelete) => window.omo.request("thread/delete", { threadId: threadToDelete }), id);
      } else {
        console.warn(`real.spec: kept thread ${id}: ${read.ok ? `its workspace is ${read.cwd}` : read.error}`);
      }
    }
    await launched.close();
    launched = null;
  }
  rmSync(WORKSPACE, { recursive: true, force: true });
  if (userData !== "") rmSync(userData, { recursive: true, force: true });
});

test("C001: pong, a tool call, and the sidebar workspace group", async () => {
  const { page } = current();
  threadId = await newSession(page);
  createdThreads.add(threadId);

  const pongTurn = await sendAndFinish(page, "Reply with exactly: pong");
  await expect(pongTurn.locator(`[data-testid="${TESTID.assistantMessage}"]`).last()).toHaveText(/^\s*pong\s*$/i);

  const toolTurn = await sendAndFinish(page, "Use your tools to run echo omo-ui-42 and reply with only its output.");
  await expect(toolTurn.locator(`[data-testid="${TESTID.toolCard}"]`).first()).toBeVisible();
  await expect(toolTurn.locator(`[data-testid="${TESTID.assistantMessage}"]`).last()).toContainText("omo-ui-42");

  const cwds = [WORKSPACE, realpathSync(WORKSPACE)].map((cwd) => `[data-cwd="${cwd}"]`).join(", ");
  const group = page.locator(`[data-testid="${TESTID.workspaceGroup}"]`).and(page.locator(cwds));
  await expect(group.locator(`[data-testid="${TESTID.threadRow}"][data-thread-id="${threadId}"]`)).toBeVisible();
  await shot(page, "C001-real-light");
  await setTheme(page, "dark");
  await shot(page, "C001-real-dark");
  await setTheme(page, "light");
});

test("C003: relaunch restores the real thread history", async () => {
  await current().close();
  launched = null;
  const { page } = await start();
  const row = threadRow(page, threadId);
  await expect(row).toBeVisible();
  await row.getByRole("button").first().click();
  await expect(row).toHaveAttribute("aria-current", "page");
  await expect(byTestId(page, TESTID.toolCard).first()).toBeVisible();
  const answers = byTestId(page, TESTID.assistantMessage);
  await expect(answers.filter({ hasText: /pong/i }).first()).toBeVisible();
  await expect(answers.filter({ hasText: "omo-ui-42" }).first()).toBeVisible();
  await shot(page, "C003-resumed");
});

test("C003: a killed omo child reconnects and the thread keeps working", async () => {
  const { page } = current();
  await page.evaluate(() => {
    const seen: string[] = [];
    Object.assign(window, { __bannerStates: seen });
    const record = (): void => {
      const state = document.querySelector('[data-testid="connection-banner"]')?.getAttribute("data-state");
      if (state !== undefined && state !== null && seen.at(-1) !== state) seen.push(state);
    };
    new MutationObserver(record).observe(document.body, { subtree: true, childList: true, attributes: true });
  });
  const { childPid } = await page.evaluate(() => window.omo.getDiagnostics());
  if (childPid === null) throw new Error("diagnostics report no omo child pid");
  process.kill(childPid, "SIGKILL");

  const bannerStates = (): Promise<string[]> =>
    page.evaluate(() => {
      const value: unknown = Reflect.get(window, "__bannerStates");
      return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
    });
  await expect
    .poll(async () => (await bannerStates()).some((state) => state === "exited" || state === "restarting"))
    .toBe(true);
  await expect(byTestId(page, TESTID.connectionBanner)).toBeHidden({ timeout: RECONNECT_TIMEOUT_MS });
  const restarted = await page.evaluate(() => window.omo.getDiagnostics());
  expect(restarted.childPid).not.toBe(childPid);

  const turn = await sendAndFinish(page, "Reply with exactly: back");
  await expect(turn.locator(`[data-testid="${TESTID.assistantMessage}"]`).last()).toHaveText(/^\s*back\s*$/i);
  await shot(page, "C003-reconnected");
});

test("C006: editing a real message and regenerating its answer branch the thread and keep the original", async () => {
  const { page } = current();
  const original = await newSession(page);
  createdThreads.add(original);
  await sendAndFinish(page, "Reply with exactly: one");
  await sendAndFinish(page, "Reply with exactly: two");
  const activeId = (): Promise<string | null> =>
    page.locator(`[data-testid="${TESTID.threadRow}"][aria-current="page"]`).getAttribute("data-thread-id");

  const users = byTestId(page, TESTID.userMessage);
  await users.nth(1).hover();
  await byTestId(page, TESTID.editMessage).nth(1).click();
  await byTestId(page, TESTID.editMessageInput).fill("Reply with exactly: three");
  await byTestId(page, TESTID.editMessageSend).click();
  await expect.poll(activeId).not.toBe(original);
  const edited = await activeId();
  if (edited !== null) createdThreads.add(edited);
  await expect(users).toHaveText(["Reply with exactly: one", "Reply with exactly: three"]);
  const answers = byTestId(page, TESTID.assistantMessage);
  await expect(answers.last()).toHaveText(/^\s*three\s*$/i, { timeout: MODEL_TIMEOUT_MS });
  await expect(byTestId(page, TESTID.turn).last()).toHaveAttribute("data-status", "completed", { timeout: MODEL_TIMEOUT_MS });
  await shot(page, "C006-real-edited");

  await byTestId(page, TESTID.regenerate).click();
  await expect.poll(activeId).not.toBe(edited);
  const regenerated = await activeId();
  if (regenerated !== null) createdThreads.add(regenerated);
  await expect(users).toHaveText(["Reply with exactly: one", "Reply with exactly: three"]);
  await expect(byTestId(page, TESTID.turn).last()).toHaveAttribute("data-status", "completed", { timeout: MODEL_TIMEOUT_MS });
  await expect(answers.last()).toHaveText(/^\s*three\s*$/i);
  await shot(page, "C006-real-regenerated");

  await threadRow(page, original).getByRole("button").first().click();
  await expect(users).toHaveText(["Reply with exactly: one", "Reply with exactly: two"]);
  await expect(answers.last()).toHaveText(/^\s*two\s*$/i);
});
