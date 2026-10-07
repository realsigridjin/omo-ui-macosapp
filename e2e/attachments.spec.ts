import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ATTACHMENT_HEADER } from "../src/ui/composer/attachments.ts";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { ENV } from "../shared/ipc.ts";
import { TESTID } from "../src/ui/testids.ts";
import { byTestId, launchApp, newSession, setTheme, shot, WT } from "./helpers.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=";

test("picker sends local images and echoes user thumbnails", async () => {
  const dir = path.join(WT, "test-results", "attachment-picker");
  mkdirSync(dir, { recursive: true });
  const image = path.join(dir, "picked.png");
  writeFileSync(image, Buffer.from(PNG, "base64"));
  const launched = await launchApp({ omo: "fake", pickDir: dir, extraEnv: { [ENV.qaPickImages]: JSON.stringify([image]) } });
  try {
    const { page, readFakeLog } = launched;
    await newSession(page);
    await byTestId(page, TESTID.attachmentPick).click();
    await expect(byTestId(page, TESTID.attachmentThumbnail)).toHaveCount(1);
    await byTestId(page, TESTID.composerInput).fill("Describe this image");
    await byTestId(page, TESTID.composerSend).click();
    await expect(byTestId(page, TESTID.userMessage).locator("img")).toBeVisible();
    await expect(byTestId(page, TESTID.userMessage)).toContainText("Describe this image");
    await expect(byTestId(page, TESTID.userMessage)).not.toContainText("Attached images");
    expect(readFakeLog()).toContainEqual(expect.objectContaining({ method: "turn/start", params: expect.objectContaining({ input: [{ type: "text", text: `Describe this image\n\n${ATTACHMENT_HEADER}\n- ${image}`, text_elements: [] }] }) }));
  } finally { await launched.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("paste and drop preview, remove, and send image-only", async () => {
  const launched = await launchApp({ omo: "fake", pickDir: WT });
  try {
    const { page, readFakeLog } = launched;
    await newSession(page);
    await page.evaluate(({ png, inputId, cardId }) => {
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
      const paste = new DataTransfer();
      paste.items.add(new File([bytes], "pasted.png", { type: "image/png" }));
      document.querySelector(`[data-testid="${inputId}"]`)!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: paste, bubbles: true, cancelable: true }));
      const drop = new DataTransfer();
      drop.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
      document.querySelector(`[data-testid="${cardId}"]`)!.dispatchEvent(new DragEvent("drop", { dataTransfer: drop, bubbles: true, cancelable: true }));
    }, { png: PNG, inputId: TESTID.composerInput, cardId: TESTID.composer });
    await expect(byTestId(page, TESTID.attachmentThumbnail)).toHaveCount(2);
    for (const theme of ["light", "dark"] as const) {
      await setTheme(page, theme);
      await shot(page, `G012-composer-${theme}`);
    }
    await byTestId(page, TESTID.attachmentRemove).first().click();
    await expect(byTestId(page, TESTID.attachmentThumbnail)).toHaveCount(1);
    await expect(byTestId(page, TESTID.composerSend)).toBeEnabled();
    await byTestId(page, TESTID.composerSend).click();
    await expect(byTestId(page, TESTID.userMessage).locator("img")).toBeVisible();
    const request = readFakeLog().find((entry) => entry["method"] === "turn/start");
    expect(request).toMatchObject({ params: { input: [{ type: "text", text: expect.stringMatching(new RegExp(`^${ATTACHMENT_HEADER.replace(/[()]/g, "\\$&")}\\n- .+[\\\\/]attachments[\\\\/][0-9a-f-]+\\.png$`)) }] } });
    const saved = String((request?.["params"] as { input: { text: string }[] }).input[0]?.text).split("\n- ")[1] ?? "";
    expect(readFileSync(saved).equals(Buffer.from(PNG, "base64"))).toBe(true);
    await expect(byTestId(page, TESTID.userMessage).locator("img")).toHaveJSProperty("complete", true);
    expect(await byTestId(page, TESTID.userMessage).locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
    await expect(byTestId(page, TESTID.attachmentThumbnail)).toHaveCount(0);
  } finally { await launched.close(); }
});
