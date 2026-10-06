import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { TESTID } from "../src/ui/testids.ts";
import { byTestId, launchApp, setTheme, shot, tempDir, threadRow } from "./helpers.ts";

/** A session in omo's own format: a memory write with its write notice, then one recalled-memory message. */
function writeSession(fakeHome: string, cwd: string): void {
  const dir = path.join(fakeHome, "sessions");
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const iso = (offsetMs: number): string => new Date(now + offsetMs).toISOString();
  const lines = [
    { type: "session", version: 3, id: "notice-thread", timestamp: iso(-60_000), cwd },
    { type: "message", id: "u1", parentId: null, timestamp: iso(-50_000), message: { role: "user", content: [{ type: "text", text: "Remember the QA harness" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: iso(-40_000), message: { role: "assistant", content: [
      { type: "text", text: "Writing it to memory." },
      { type: "toolCall", id: "call-mem", name: "memory", arguments: { command: "create", file_path: "reference/qa-harness.md" } },
    ] } },
    { type: "message", id: "r1", parentId: "a1", timestamp: iso(-30_000), message: {
      role: "toolResult", toolCallId: "call-mem", toolName: "memory", content: [{ type: "text", text: "Memory create committed locally (abc1234)." }],
      details: { writeNotice: {
        sha: "abc1234", subject: "Record the QA harness",
        affected: [{ path: "reference/qa-harness.md", insertions: 33, deletions: 0 }],
        size: { systemBytes: 16_384, totalBytes: 701_440, fileCount: 134 },
        timeline: { entriesToday: 8, previousEntryAtISO: iso(-12 * 60_000), lastConsolidationAtISO: iso(-45 * 86_400_000) },
      } },
    } },
    { type: "custom_message", id: "n1", parentId: "r1", timestamp: iso(-20_000), customType: "omo-kibitzer:recall", display: false,
      content: "<recalled-memory source=\"[[notes/qa.md]]\">Run the QA harness before release.\nIt seeds a fake home.</recalled-memory>" },
    { type: "message", id: "a2", parentId: "n1", timestamp: iso(-10_000), message: { role: "assistant", content: [{ type: "text", text: "Saved." }], stopReason: "stop" } },
  ];
  writeFileSync(path.join(dir, "notice-thread.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

test("a memory write shows omo's Remembered card, and special messages show as expandable rows", async () => {
  const fakeHome = tempDir("notices-home");
  const pickDir = tempDir("notices-workspace");
  writeSession(fakeHome, pickDir);
  const launched = await launchApp({ omo: "fake", fakeHome, pickDir });
  try {
    const { page } = launched;
    await threadRow(page, "notice-thread").getByRole("button").first().click();
    const card = byTestId(page, TESTID.memoryWrite);
    await expect(card).toBeVisible();
    await expect(card).toContainText("Remembered");
    await expect(card).toContainText("8th entry today");
    await expect(card).toContainText("Added 33 lines to reference/qa-harness.md");
    await expect(card).toContainText("16K injected · 685K total · 134 files");
    await expect(card).toContainText("last consolidation 45 days ago");

    const notice = byTestId(page, TESTID.sessionNotice).and(page.locator('[data-type="omo-kibitzer:recall"]'));
    await expect(notice).toContainText("Recalled memory");
    await expect(notice).toContainText("Run the QA harness before release.");
    await expect(notice).not.toContainText("It seeds a fake home.");
    await notice.getByRole("button").click();
    await expect(notice).toContainText("It seeds a fake home.");
    await expect(notice).not.toContainText("<recalled-memory");
    await shot(page, "session-notices-light");
    await setTheme(page, "dark");
    await threadRow(page, "notice-thread").getByRole("button").first().click();
    await expect(card).toBeVisible();
    await shot(page, "session-notices-dark");
  } finally {
    await launched.close();
    for (const dir of [fakeHome, pickDir]) rmSync(dir, { recursive: true, force: true });
  }
});
