import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { TESTID } from "../src/ui/testids.ts";
import { byTestId, lastTurn, launchApp, newSession, send, setTheme, shot, tempDir, type LaunchedApp } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

let fakeHome = "";
let userData = "";
let pickDir = "";
let launched: LaunchedApp | null = null;

const current = (): LaunchedApp => {
  if (launched === null) throw new Error("the app is not running");
  return launched;
};

test.beforeAll(async () => {
  fakeHome = tempDir("work-log-home");
  userData = tempDir("work-log-user-data");
  pickDir = tempDir("work-log-workspace");
  launched = await launchApp({ omo: "fake", fakeHome, userData, pickDir });
});

test.afterAll(async () => {
  await launched?.close();
  launched = null;
  for (const dir of [fakeHome, userData, pickDir]) if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

test("a tool-using turn folds into one Worked-for line that expands back to its steps", async () => {
  const { page } = current();
  await newSession(page);
  await send(page, "SCENARIO:full");

  // While the turn runs, every step stays expanded.
  await byTestId(page, TESTID.approvalCard).locator(`[data-testid="${TESTID.approvalAccept}"]`).click();
  await expect(lastTurn(page).locator(`[data-testid="${TESTID.toolCard}"][data-tool="eval"]`)).toBeVisible();
  const question = byTestId(page, TESTID.questionCard);
  await question.locator(`[data-testid="${TESTID.questionOption}"][data-label="B"]`).click();
  await byTestId(page, TESTID.questionSubmit).click();
  await expect(lastTurn(page)).toHaveAttribute("data-status", "completed");

  const turn = lastTurn(page);
  const fold = turn.locator(`[data-testid="${TESTID.workedFold}"]`);
  await expect(fold).toBeVisible();
  await expect(fold).toContainText(/Worked for \d+(\.\d+)?(ms|s)/);
  await expect(turn.locator(`[data-testid="${TESTID.toolCard}"]`)).toHaveCount(0);
  await expect(turn.locator(`[data-testid="${TESTID.reasoning}"]`)).toHaveCount(0);
  await expect(turn.locator(`[data-testid="${TESTID.assistantMessage}"]`)).toContainText("You picked B");

  const toggle = turn.locator(`[data-testid="${TESTID.workedFoldToggle}"]`);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(turn.locator(`[data-testid="${TESTID.toolCard}"][data-tool="eval"]`)).toBeVisible();
  await expect(turn.locator(`[data-testid="${TESTID.reasoning}"]`)).toBeVisible();
  await toggle.click();
  await expect(turn.locator(`[data-testid="${TESTID.toolCard}"]`)).toHaveCount(0);

  const footer = turn.locator(`[data-testid="${TESTID.answerFooter}"]`);
  await expect(footer).toBeVisible();
  await expect(footer).toContainText(/\d{1,2}:\d{2}/);
  await shot(page, "work-log-fold-light");
  await setTheme(page, "dark");
  await shot(page, "work-log-fold-dark");
  await setTheme(page, "light");
});

test("the waiting line ticks while the model streams nothing, then clears", async () => {
  const { page } = current();
  await send(page, "SCENARIO:quiet:6000 hold");
  const waiting = byTestId(page, TESTID.waitingStatus);
  await expect(waiting).toBeVisible();
  await expect(waiting).toContainText("Waiting for the model");
  const detail = byTestId(page, TESTID.workingDetail);
  await expect(detail).toHaveText(/^\d+s( · .*)?$/);
  const initial = await detail.textContent();
  await expect
    .poll(async () => detail.textContent(), { timeout: 5_000 })
    .not.toBe(initial);

  await expect(lastTurn(page)).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
  await expect(waiting).toHaveCount(0);
  // A plain echo answer has no intermediate steps, so the last turn never folds (earlier turns may).
  await expect(lastTurn(page).locator(`[data-testid="${TESTID.workedFold}"]`)).toHaveCount(0);
  await expect(lastTurn(page).locator(`[data-testid="${TESTID.assistantMessage}"]`)).toContainText("echo: SCENARIO:quiet");
  await expect(lastTurn(page).locator(`[data-testid="${TESTID.answerFooter}"]`)).toBeVisible();
});

test("the answer footer copies through the bridge and rates locally", async () => {
  const { page, app } = current();
  const turn = lastTurn(page);
  const previous = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    await turn.locator(`[data-testid="${TESTID.answerCopy}"]`).click();
    await expect(turn.locator(`[data-testid="${TESTID.answerCopy}"]`)).toHaveAttribute("aria-label", "Copied");
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5_000 })
      .toBe("echo: SCENARIO:quiet:6000 hold");

    const up = turn.locator(`[data-testid="${TESTID.answerThumbUp}"]`);
    const down = turn.locator(`[data-testid="${TESTID.answerThumbDown}"]`);
    await up.click();
    await expect(up).toHaveAttribute("aria-pressed", "true");
    await down.click();
    await expect(down).toHaveAttribute("aria-pressed", "true");
    await expect(up).toHaveAttribute("aria-pressed", "false");
    await down.click();
    await expect(down).toHaveAttribute("aria-pressed", "false");
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), previous);
  }
});

test("the subagent row counts working children during a task scenario", async () => {
  const { page } = current();
  await send(page, "SCENARIO:omo-live");
  const turn = lastTurn(page);
  const row = turn.locator(`[data-testid="${TESTID.subagentRow}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText("Kicked off 1 subagent");
  await expect(row).toContainText("1 working");
  await turn.locator(`[data-testid="${TESTID.subagentToggle}"]`).click();
  const laneA = row.locator(`[data-testid="${TESTID.subagentTask}"]`).first();
  await expect(laneA).toHaveAttribute("data-status", "running");
  await expect(laneA).toContainText("Execute A");
  await expect(laneA).toContainText(/\d+(\.\d+)?(ms|s)/);

  await page.evaluate(async (id) => {
    await window.omo.request("extension_request", { threadId: id, name: "fake.advance", data: {} });
  }, await threadIdOf(page));
  await expect(row).toContainText("Kicked off 2 subagents");
  await expect(laneA).toHaveAttribute("data-status", "completed");
  await shot(page, "work-log-subagents-light");
  await setTheme(page, "dark");
  await shot(page, "work-log-subagents-dark");
  await setTheme(page, "light");
});

async function threadIdOf(page: import("@playwright/test").Page): Promise<string> {
  const threadId = await byTestId(page, TESTID.threadRow).evaluateAll((rows) => {
    const current = rows.find((row) => row.getAttribute("aria-current") === "page");
    return current?.getAttribute("data-thread-id") ?? null;
  });
  if (threadId === null) throw new Error("no active thread row");
  return threadId;
}
