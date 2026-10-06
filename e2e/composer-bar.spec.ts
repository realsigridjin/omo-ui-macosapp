import { execFile as execFileCallback } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { TESTID } from "../src/ui/testids.ts";
import { byTestId, launchApp, newSession, send, setTheme, shot, tempDir } from "./helpers.ts";

const execFile = promisify(execFileCallback);
const BRANCH = "feature/very-long-branch-name-for-truncation";

const git = (cwd: string, ...args: string[]): Promise<{ stdout: string }> =>
  execFile("git", ["-C", cwd, "-c", "user.email=e2e@omo.ui", "-c", "user.name=OmO E2E", ...args]);

async function makeRepo(): Promise<{ repo: string; remote: string }> {
  const repo = tempDir("composer-bar-repo");
  const remote = tempDir("composer-bar-remote");
  await execFile("git", ["init", "--bare", "-b", "main", remote]);
  await execFile("git", ["init", "-b", "main", repo]);
  await git(repo, "commit", "--allow-empty", "-m", "init");
  await git(repo, "checkout", "-b", BRANCH);
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", "HEAD");
  return { repo, remote };
}

test("checkout bar shows branch and counts; reasoning writes turn/start effort; commit & push reaches the remote", async () => {
  const { repo, remote } = await makeRepo();
  const launched = await launchApp({ omo: "fake", pickDir: repo });
  try {
    const page = launched.page;
    await newSession(page);
    const bar = byTestId(page, TESTID.checkoutBar);
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute("data-git", "");
    const branch = byTestId(page, TESTID.checkoutBranch);
    await expect(branch).toHaveAttribute("data-branch", BRANCH);
    await expect(branch).toContainText("…");
    await expect(byTestId(page, TESTID.checkoutFolder)).toContainText(path.basename(repo));
    const counts = byTestId(page, TESTID.checkoutCounts);
    await expect(counts).toBeVisible();
    await expect(bar).toHaveAttribute("data-ahead", "0");
    await expect(bar).toHaveAttribute("data-behind", "0");

    await setTheme(page, "light");
    await shot(page, "composer-bar-light");
    await setTheme(page, "dark");
    await shot(page, "composer-bar-dark");

    await byTestId(page, TESTID.modelPicker).click();
    await byTestId(page, TESTID.specificModelTab).click();
    await page.getByRole("searchbox").fill("Fake Beta");
    await byTestId(page, TESTID.modelOption).click();
    await expect(byTestId(page, TESTID.modelPicker)).toContainText("Fake Beta");
    const reasoning = byTestId(page, TESTID.reasoningPicker);
    await expect(reasoning).toBeVisible();
    await reasoning.click();
    await page.locator(`[data-testid="${TESTID.reasoningOption}"][data-effort="high"]`).click();
    await expect(reasoning).toHaveAttribute("data-effort", "high");
    await send(page, "SCENARIO:echo reasoning effort");
    await expect(byTestId(page, TESTID.turn).last()).toHaveAttribute("data-status", "completed");
    expect(launched.readFakeLog()).toContainEqual(
      expect.objectContaining({
        method: "turn/start",
        params: expect.objectContaining({ model: "fake/beta", effort: "high" }),
      }),
    );

    await byTestId(page, TESTID.modelPicker).click();
    await byTestId(page, TESTID.profileTab).click();
    await byTestId(page, TESTID.profileDot).click();
    await page.keyboard.press("Enter");
    await expect(byTestId(page, TESTID.reasoningPicker)).toHaveCount(0);

    writeFileSync(path.join(repo, "local.txt"), "committed outside the app\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-m", "outside the app");
    await send(page, "SCENARIO:echo refresh the bar");
    await expect(byTestId(page, TESTID.turn).last()).toHaveAttribute("data-status", "completed");
    await expect(bar).toHaveAttribute("data-ahead", "1");

    writeFileSync(path.join(repo, "notes.txt"), "committed through the app\n");
    await byTestId(page, TESTID.commitButton).locator("button").first().click();
    const dialog = byTestId(page, TESTID.commitDialog);
    await expect(dialog).toBeVisible();
    await expect(byTestId(page, TESTID.commitChanges)).toContainText("notes.txt");
    await byTestId(page, TESTID.commitMessage).fill("through the app");
    await byTestId(page, TESTID.commitSubmit).click();
    await expect(byTestId(page, TESTID.commitResult)).toContainText("pushed");
    await byTestId(page, TESTID.commitCancel).click();
    await expect(dialog).toBeHidden();
    await expect(bar).toHaveAttribute("data-ahead", "0");
    const localHead = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
    const remoteHead = (
      await execFile("git", ["--git-dir", remote, "rev-parse", `refs/heads/${BRANCH}`])
    ).stdout.trim();
    expect(remoteHead).toBe(localHead);
  } finally {
    await launched.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});

test("a non-git workspace shows only the folder", async () => {
  const plain = tempDir("composer-bar-plain");
  const launched = await launchApp({ omo: "fake", pickDir: plain });
  try {
    const page = launched.page;
    await newSession(page);
    await expect(byTestId(page, TESTID.checkoutBar)).toBeVisible();
    await expect(byTestId(page, TESTID.checkoutBar)).not.toHaveAttribute("data-git", "");
    await expect(byTestId(page, TESTID.checkoutFolder)).toContainText(path.basename(plain));
    await expect(byTestId(page, TESTID.checkoutBranch)).toHaveCount(0);
    await expect(byTestId(page, TESTID.commitButton)).toHaveCount(0);
  } finally {
    await launched.close();
    rmSync(plain, { recursive: true, force: true });
  }
});
