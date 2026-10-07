import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { TESTID } from "../src/ui/testids.ts";
import { byTestId, lastTurn, launchApp, newSession, send, setTheme, shot, tempDir, threadRow } from "./helpers.ts";

test("a running thread counts its seconds in the sidebar, and running agents get a strip whose Stop interrupts", async () => {
  const pickDir = tempDir("strip-workspace");
  const launched = await launchApp({ omo: "fake", pickDir });
  try {
    const { page, readFakeLog } = launched;
    const quiet = await newSession(page);
    await send(page, "SCENARIO:quiet:4000 think");
    const pill = threadRow(page, quiet).getByTestId(TESTID.threadRunning);
    await expect(pill).toHaveText(/^Working \d+s$/);
    const first = Number((await pill.innerText()).match(/(\d+)s/)?.[1]);
    await expect.poll(async () => Number((await pill.innerText()).match(/(\d+)s/)?.[1])).toBeGreaterThan(first);
    await expect(lastTurn(page)).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
    await expect(pill).toHaveCount(0);

    await newSession(page);
    await send(page, "SCENARIO:dag");
    const strip = byTestId(page, TESTID.agentsWorkingStrip);
    await expect(strip).toContainText(/\d+ agents? working/);
    await shot(page, "working-strip-light");
    await setTheme(page, "dark");
    await expect(strip).toBeVisible();
    await shot(page, "working-strip-dark");
    await strip.getByTestId(TESTID.agentsWorkingStop).click();
    await expect.poll(() => readFakeLog().some((entry) => entry["method"] === "turn/interrupt")).toBe(true);
    await expect(lastTurn(page)).toHaveAttribute("data-status", "interrupted", { timeout: 15_000 });
  } finally {
    await launched.close();
    rmSync(pickDir, { recursive: true, force: true });
  }
});
