import { rmSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { TESTID } from "../src/ui/testids.ts";
import { byTestId, launchApp, send, tempDir, threadRow, type LaunchedApp } from "./helpers.ts";

const LONG_ID = "long-session";
const ACTIVE_ROW = `[data-testid="${TESTID.threadRow}"][aria-current="page"]`;

let launched: LaunchedApp | null = null;
let pickDir = "";

const current = (): LaunchedApp => {
  if (launched === null) throw new Error("the app is not running");
  return launched;
};

function distanceFromBottom(page: Page): Promise<number> {
  return byTestId(page, TESTID.turn).last().evaluate((turn) => {
    let scroller = turn.parentElement;
    while (scroller !== null && getComputedStyle(scroller).overflowY !== "auto") scroller = scroller.parentElement;
    if (scroller === null) throw new Error("no transcript scroller");
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  });
}

async function openLongConversation(page: Page): Promise<void> {
  await threadRow(page, LONG_ID).getByRole("button").first().click();
  await expect(byTestId(page, TESTID.turn).nth(29)).toBeAttached();
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(80);
}

test.beforeAll(async () => {
  pickDir = tempDir("workspace");
  launched = await launchApp({
    omo: "fake",
    pickDir,
    extraEnv: { FAKE_OMO_LONG_SESSION: JSON.stringify({ id: LONG_ID, cwd: pickDir, turns: 30, toolCalls: 80 }) },
  });
});

test.afterAll(async () => {
  await launched?.close();
  launched = null;
  if (pickDir !== "") rmSync(pickDir, { recursive: true, force: true });
});

test("a long conversation opens at its latest turn and stays there while an answer streams", async () => {
  const { page } = current();
  await openLongConversation(page);
  await send(page, "SCENARIO:flood:600:2");
  await expect(byTestId(page, TESTID.assistantMessage).last()).toContainText("⟦599@");
  await expect(byTestId(page, TESTID.composerStop)).toHaveCount(0);
  await expect.poll(() => distanceFromBottom(page)).toBeLessThanOrEqual(80);
});

test("a new session opens promptly while an answer streams fast into a long conversation", async () => {
  const { page } = current();
  await openLongConversation(page);
  // The transcript must be large enough that a synchronous layout per streamed delta costs more than the 2 ms between
  // deltas; that per-delta layout is what delayed every other renderer task.
  expect(await page.evaluate(() => document.getElementsByTagName("*").length)).toBeGreaterThan(30_000);
  const compose = page.locator(`[data-testid="${TESTID.workspaceGroup}"][data-cwd=${JSON.stringify(pickDir)}] [data-testid="${TESTID.workspaceCompose}"]`);
  const box = await compose.boundingBox();
  if (box === null) throw new Error("the compose icon is not laid out");

  // The waits and timestamps live in the page and are requested before the stream starts: a driver query sent during the
  // stream queues behind the same backlog, so a click that waited for one would land only after the backlog drained.
  const probe = await page.evaluateHandle(
    ({ answer, marker, sidebar, activeRow, composeIcon, stop, longId }) => {
      const answersBefore = document.querySelectorAll(answer).length;
      const reached = new Promise<void>((resolve) => {
        const check = (): void => {
          const answers = document.querySelectorAll(answer);
          if (answers.length > answersBefore && answers[answers.length - 1]?.textContent?.includes(marker) === true) resolve();
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      });
      let clickedAt: number | null = null;
      const clicked = new Promise<{ onCompose: boolean; streaming: boolean }>((resolve) => {
        const onClick = (event: MouseEvent): void => {
          clickedAt = performance.now();
          const onCompose = event.target instanceof Element && event.target.closest(composeIcon) !== null;
          resolve({ onCompose, streaming: document.querySelector(stop) !== null });
        };
        document.addEventListener("click", onClick, { capture: true, once: true });
      });
      const nav = document.querySelector(sidebar);
      if (nav === null) throw new Error("no sidebar");
      const openedAfterMs = new Promise<number>((resolve) => {
        new MutationObserver((_records, observer) => {
          const row = nav.querySelector(activeRow);
          if (clickedAt === null || row === null || row.getAttribute("data-thread-id") === longId) return;
          observer.disconnect();
          resolve(performance.now() - clickedAt);
        }).observe(nav, { subtree: true, childList: true, attributes: true, attributeFilter: ["aria-current"] });
      });
      return { reached, clicked, openedAfterMs };
    },
    {
      answer: `[data-testid="${TESTID.assistantMessage}"]`,
      marker: "⟦499@",
      sidebar: `[data-testid="${TESTID.sidebar}"]`,
      activeRow: ACTIVE_ROW,
      composeIcon: `[data-testid="${TESTID.workspaceCompose}"]`,
      stop: `[data-testid="${TESTID.composerStop}"]`,
      longId: LONG_ID,
    },
  );
  const reached = probe.evaluate((p) => p.reached);
  const clicked = probe.evaluate((p) => p.clicked);
  const openedAfterMs = probe.evaluate((p) => p.openedAfterMs);

  await send(page, "SCENARIO:flood:2000:2");
  await reached;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  expect(await clicked).toEqual({ onCompose: true, streaming: true });
  expect(await openedAfterMs).toBeLessThan(2_000);
});
