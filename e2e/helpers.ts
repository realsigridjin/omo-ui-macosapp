import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { ENV } from "../shared/ipc.ts";
import { TESTID, type TestId } from "../src/ui/testids.ts";

export const WT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FAKE_OMO = path.join(WT, "tests", "fixtures", "fake-omo.mjs");
const EVIDENCE_DIR = process.env["OMO_UI_EVIDENCE_DIR"] ?? path.join(WT, "test-results", "evidence");
const LAUNCH_TIMEOUT_MS = 60_000;

export interface LaunchOptions {
  omo: "fake" | "installed";
  userData?: string;
  pickDir?: string;
  /** FAKE_OMO_HOME for the fake; FAKE_OMO_LOG is `<fakeHome>/fake-omo.log`. */
  fakeHome?: string;
  size?: { width: number; height: number };
  /** Extra environment variables for the app (and, through the login-shell environment, the omo child). */
  extraEnv?: Record<string, string>;
  /** Wait for the bridge to report "connected" before returning; defaults to true. */
  waitForConnected?: boolean;
}

export interface LaunchDirs {
  userData: string;
  pickDir: string | null;
  fakeHome: string | null;
  fakeLog: string | null;
}

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  dirs: LaunchDirs;
  readFakeLog(): Record<string, unknown>[];
  /** Closes the app and removes the temp dirs launchApp created (never the ones passed in). */
  close(): Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function tempDir(label: string): string {
  return mkdtempSync(path.join(tmpdir(), `omo-ui-e2e-${label}-`));
}

export function readFakeLog(logPath: string): Record<string, unknown>[] {
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch (error) {
    if (isRecord(error) && error["code"] === "ENOENT") return [];
    throw error;
  }
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line): unknown => JSON.parse(line))
    .filter(isRecord);
}

export function byTestId(page: Page, id: TestId): Locator {
  return page.locator(`[data-testid="${id}"]`);
}

export async function launchApp(options: LaunchOptions): Promise<LaunchedApp> {
  const created: string[] = [];
  const own = (label: string): string => {
    const dir = tempDir(label);
    created.push(dir);
    return dir;
  };
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env["ELECTRON_RUN_AS_NODE"];
  delete env[ENV.omoBin];
  delete env["FAKE_OMO_HOME"];
  delete env["FAKE_OMO_LOG"];

  const userData = options.userData ?? own("user-data");
  const preferences = path.join(userData, "preferences.json");
  if (!existsSync(preferences)) writeFileSync(preferences, JSON.stringify({ locale: "en" }));
  env[ENV.userData] = userData;
  const pickDir = options.pickDir ?? null;
  if (pickDir !== null) env[ENV.qaPickDir] = pickDir;

  let fakeHome: string | null = null;
  let fakeLog: string | null = null;
  if (options.omo === "fake") {
    fakeHome = options.fakeHome ?? own("fake-home");
    fakeLog = path.join(fakeHome, "fake-omo.log");
    env[ENV.omoBin] = FAKE_OMO;
    env["FAKE_OMO_HOME"] = fakeHome;
    env["FAKE_OMO_LOG"] = fakeLog;
  }

  env["OMO_UI_IPHONE_BRIDGE"] = "0";
  // A test must never replace the user's installed omo; the update spec drives a fake launcher instead.
  if (options.omo === "installed") env[ENV.omoAutoUpdate] = "0";
  Object.assign(env, options.extraEnv ?? {});

  const removeCreated = (): void => {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  };
  let app: ElectronApplication;
  try {
    app = await electron.launch({ args: ["."], cwd: WT, env, timeout: LAUNCH_TIMEOUT_MS });
  } catch (error) {
    removeCreated();
    throw error;
  }
  const close = async (): Promise<void> => {
    try {
      await app.close();
    } finally {
      removeCreated();
    }
  };
  try {
    const page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT_MS });
    const size = options.size ?? { width: 1280, height: 820 };
    await app.evaluate(({ BrowserWindow }, wanted) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(wanted.width, wanted.height);
    }, size);
    await expect(byTestId(page, TESTID.appFrame).or(byTestId(page, TESTID.onboarding)).first()).toBeVisible({ timeout: LAUNCH_TIMEOUT_MS });
    if (options.waitForConnected !== false) {
      await expect(page.locator("html")).toHaveAttribute("data-bridge-state", "connected", { timeout: LAUNCH_TIMEOUT_MS });
    }
    const log = fakeLog;
    return {
      app,
      page,
      dirs: { userData, pickDir, fakeHome, fakeLog },
      readFakeLog: () => (log === null ? [] : readFakeLog(log)),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Writes `<EVIDENCE_DIR>/<name>.png` after finite animations settle (only those ending within
 * `options.maxSettleMs` when it is given, so a long toast fade does not erase the toast). The page background is
 * flattened over the theme's opaque sidebar fill for the capture, because CDP screenshots
 * leave out the native vibrancy layer behind the transparent window.
 */
export async function shot(page: Page, name: string, options: { maxSettleMs?: number } = {}): Promise<string> {
  const fill = await page.evaluate(async (limit) => {
    const settling = document.getAnimations().filter((animation) => {
      if (animation.playState !== "running") return false;
      const end = animation.effect?.getComputedTiming().endTime;
      if (typeof end !== "number" || end === Infinity) return false;
      const now = typeof animation.currentTime === "number" ? animation.currentTime : 0;
      return limit === null || end - now <= limit;
    });
    await Promise.all(settling.map((animation) => animation.finished.catch(() => undefined)));
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--dsw-specific-sidebar-fill)";
    document.body.append(probe);
    const value = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return value;
  }, options.maxSettleMs ?? null);
  const file = path.join(EVIDENCE_DIR, `${name}.png`);
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const backdrop = await page.addStyleTag({ content: `html { background: ${fill} !important; }` });
  try {
    await page.screenshot({ path: file });
  } finally {
    await backdrop.evaluate((node) => node.parentNode?.removeChild(node));
    await backdrop.dispose();
  }
  return file;
}

export async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await byTestId(page, TESTID.openSettings).click();
  const dialog = byTestId(page, TESTID.settingsDialog);
  await expect(dialog).toBeVisible();
  const choice = byTestId(page, theme === "dark" ? TESTID.settingsThemeDark : TESTID.settingsThemeLight);
  await choice.click();
  await expect(choice).toHaveAttribute("aria-pressed", "true");
  const body = page.locator("body");
  if (theme === "dark") await expect(body).toHaveAttribute("data-ds-dark-theme", "");
  else await expect(body).not.toHaveAttribute("data-ds-dark-theme", "");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

export async function newSession(page: Page): Promise<string> {
  const before = await byTestId(page, TESTID.threadRow).evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-thread-id")),
  );
  await byTestId(page, TESTID.newSession).click();
  await page.waitForFunction(({ rowTestId, known }) => {
    const row = document.querySelector(`[data-testid="${rowTestId}"][aria-current="page"]`);
    const id = row?.getAttribute("data-thread-id");
    return document.querySelector('[data-testid="project-picker"]') !== null || (id !== undefined && id !== null && !known.includes(id));
  }, { rowTestId: TESTID.threadRow, known: before });
  if (await page.getByTestId("project-picker").count() > 0) await page.getByTestId("project-new").click();
  const opened = await page.waitForFunction(
    ({ rowTestId, known }) => {
      const row = document.querySelector(`[data-testid="${rowTestId}"][aria-current="page"]`);
      const id = row?.getAttribute("data-thread-id") ?? null;
      return id !== null && !known.includes(id) ? id : null;
    },
    { rowTestId: TESTID.threadRow, known: before },
    { timeout: 30_000 },
  );
  const threadId = await opened.jsonValue();
  if (typeof threadId !== "string") throw new Error("new session did not activate a new thread row");
  await expect(byTestId(page, TESTID.composerInput)).toBeEnabled();
  return threadId;
}

export async function send(page: Page, text: string): Promise<void> {
  const input = byTestId(page, TESTID.composerInput);
  await expect(input).toBeEnabled();
  await input.fill(text);
  await input.press("Enter");
  await expect(input).toHaveValue("");
}

export function lastTurn(page: Page): Locator {
  return byTestId(page, TESTID.turn).last();
}

export function threadRow(page: Page, threadId: string): Locator {
  return page.locator(`[data-testid="${TESTID.threadRow}"][data-thread-id="${threadId}"]`);
}

function luminance(color: string): number {
  const match = /^rgba?\(([^)]+)\)$/.exec(color);
  if (match === null) throw new Error(`not an rgb() color: ${color}`);
  const [r = 0, g = 0, b = 0] = (match[1] ?? "").split(",").slice(0, 3).map((part) => Number(part.trim()) / 255);
  const linear = (value: number): number => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio of two computed rgb()/rgba() colors; alpha is ignored, so pass opaque colors. */
export function contrastRatio(foreground: string, background: string): number {
  const [lighter = 0, darker = 0] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/** The computed text and background colors of an element. */
export async function colorsOf(locator: Locator): Promise<{ color: string; background: string }> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor };
  });
}

/** The computed colors of two theme tokens under the current body theme, as text color and background. */
export async function tokenColors(page: Page, foreground: string, background: string): Promise<{ color: string; background: string }> {
  return page.evaluate(({ fg, bg }) => {
    const probe = document.createElement("div");
    probe.style.color = `var(${fg})`;
    probe.style.backgroundColor = `var(${bg})`;
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const colors = { color: style.color, background: style.backgroundColor };
    probe.remove();
    return colors;
  }, { fg: foreground, bg: background });
}
