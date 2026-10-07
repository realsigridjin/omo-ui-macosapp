import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { TESTID } from "../src/ui/testids.ts";
import { byTestId, launchApp, newSession, send, setTheme, shot, tempDir } from "./helpers.ts";

test("the Agents panel graphs a three-wave run and excludes the side chat", async () => {
  const pickDir = tempDir("agents-workspace");
  const launched = await launchApp({ omo: "fake", pickDir });
  const { page } = launched;
  const capture = async (name: string): Promise<void> => {
    await page.mouse.move(8, 300);
    mkdirSync("/tmp/agents-ev", { recursive: true });
    copyFileSync(await shot(page, `agents-${name}`), `/tmp/agents-ev/${name}.png`);
  };
  const panel = byTestId(page, TESTID.agentsPanel);
  const badge = byTestId(page, TESTID.agentsBadge);
  const node = (id: string) => page.locator(`[data-testid="${TESTID.agentsNode}"][data-node-id="${id}"]`);
  const edge = (from: string, to: string) =>
    page.locator(`[data-testid="${TESTID.agentsEdge}"][data-from="${from}"][data-to="${to}"]`);
  try {
    await setTheme(page, "dark");
    await newSession(page);
    const toggle = byTestId(page, TESTID.agentsToggle);
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(panel).toHaveCount(0);

    await send(page, "SCENARIO:dag-waves");
    await expect(badge).toHaveText("1");
    await toggle.click();
    await expect(panel).toBeVisible();
    await expect(byTestId(page, TESTID.agentsWave)).toHaveCount(3);
    await expect(byTestId(page, TESTID.agentsWave).first()).toHaveText("Wave 1 · 0/1 settled · 1 running");
    await expect(node("plan")).toHaveAttribute("data-state", "running");
    await expect(node("plan").getByTestId(TESTID.agentsNodeStatus)).toContainText("Working ·");
    await expect(node("survey-server")).toHaveAttribute("data-state", "pending");
    await expect(node("survey-web")).toHaveAttribute("data-state", "pending");
    await expect(node("merge")).toHaveAttribute("data-state", "pending");
    await expect(edge("plan", "survey-server")).toHaveAttribute("data-kind", "active");
    await expect(edge("survey-server", "merge")).toHaveAttribute("data-kind", "pending");

    await expect(byTestId(page, TESTID.agentsSubtitle)).toHaveText("1/4 settled · wave 2/3");
    await expect(byTestId(page, TESTID.agentsWave).first()).toHaveText("Wave 1 · 1/1 settled");
    await expect(byTestId(page, TESTID.agentsWave).nth(1)).toHaveText("Wave 2 · 0/2 settled · 2 running");
    await expect(badge).toHaveText("2");
    await expect(node("plan")).toHaveAttribute("data-state", "completed");
    await expect(node("plan").getByTestId(TESTID.agentsNodeStatus)).toContainText("Done");
    await expect(node("survey-server").getByTestId(TESTID.agentsNodeStatus)).toContainText("Working ·");
    await expect(byTestId(page, TESTID.agentsRunStatus)).toHaveAttribute("data-status", "running");
    await expect(edge("plan", "survey-server")).toHaveAttribute("data-kind", "satisfied");
    await expect(edge("plan", "survey-web")).toHaveAttribute("data-kind", "satisfied");
    await expect(edge("survey-server", "merge")).toHaveAttribute("data-kind", "active");
    await expect(edge("survey-web", "merge")).toHaveAttribute("data-kind", "active");
    const activity = byTestId(page, TESTID.agentsActivity);
    await expect(activity).toBeVisible();
    await expect(activity.locator('[data-node-id="plan"][data-state="completed"]')).toContainText("plan — Done");
    await expect(activity.locator('[data-node-id="survey-web"][data-state="running"]').first()).toContainText("just now");
    await capture("stage2-dark");

    await expect(byTestId(page, TESTID.agentsSubtitle)).toHaveText("3/4 settled · wave 3/3");
    await expect(node("merge")).toHaveAttribute("data-state", "running");
    await expect(byTestId(page, TESTID.agentsRunStatus)).toHaveAttribute("data-status", "completed");
    await expect(node("merge").getByTestId(TESTID.agentsNodeStatus)).toContainText("Done");
    await expect(badge).toHaveCount(0);
    await expect(activity.locator('[data-node-id="merge"][data-state="completed"]')).toContainText("merge — Done");

    await byTestId(page, TESTID.agentsViewList).click();
    await expect(panel.getByTestId(TESTID.dagRun)).toBeVisible();
    await byTestId(page, TESTID.agentsViewGraph).click();
    await expect(byTestId(page, TESTID.agentsGraph)).toBeVisible();

    await byTestId(page, TESTID.agentsBack).click();
    await expect(panel).toHaveCount(0);
    await page.keyboard.press("Shift+Meta+a");
    await expect(panel).toBeVisible();

    await send(page, "/btw what changed?");
    await expect(byTestId(page, TESTID.sidePanel)).toBeVisible();
    await expect(panel).toHaveCount(0);
    await byTestId(page, TESTID.agentsToggle).click();
    await expect(panel).toBeVisible();
    await expect(byTestId(page, TESTID.sidePanel)).toHaveCount(0);

    await setTheme(page, "light");
    await capture("final-light");
  } finally {
    await launched.close();
    rmSync(pickDir, { recursive: true, force: true });
  }
});
