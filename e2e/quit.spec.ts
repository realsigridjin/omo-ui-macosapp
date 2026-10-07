import { rmSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { ENV } from "../shared/ipc.ts";
import { TESTID } from "../src/ui/testids.ts";
import { byTestId, launchApp, tempDir } from "./helpers.ts";

const EXIT_TIMEOUT_MS = 15_000;

test("a native quit request exits the app while omo is not found", async () => {
  const userData = tempDir("quit-user-data");
  const launched = await launchApp({
    omo: "installed",
    userData,
    extraEnv: { [ENV.omoBin]: "/nonexistent/omo" },
    waitForConnected: false,
  });
  const main = launched.app.process();
  try {
    await expect(byTestId(launched.page, TESTID.onboarding)).toBeVisible();
    const exited = new Promise<"exited">((resolve) => main.once("exit", () => resolve("exited")));
    let deadline: NodeJS.Timeout | undefined;
    const running = new Promise<"running">((resolve) => {
      deadline = setTimeout(() => resolve("running"), EXIT_TIMEOUT_MS);
    });
    // SIGTERM enters Electron's Browser::Quit from a native task, as Cmd+Q and the Dock's Quit item do.
    if (process.platform === "win32") await launched.app.evaluate(({ app }) => app.quit());
    else main.kill("SIGTERM");
    const outcome = await Promise.race([exited, running]);
    clearTimeout(deadline);
    expect(outcome).toBe("exited");
  } finally {
    if (main.exitCode === null && main.signalCode === null) await launched.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
