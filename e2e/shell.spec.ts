import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { TESTID } from "../src/ui/testids.ts";
import { byTestId, launchApp, newSession, shot, tempDir, type LaunchedApp } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

const SERVER_CWD = "/Users/qa/work/server";
const CLIENT_CWD = "/Users/qa/work/omo-ui";

let fakeHome = "";
let userData = "";
let pickDir = "";
let launched: LaunchedApp | null = null;

const current = (): LaunchedApp => {
  if (launched === null) throw new Error("the app is not running");
  return launched;
};

test.beforeAll(async () => {
  fakeHome = tempDir("fake-home");
  userData = tempDir("user-data");
  pickDir = tempDir("workspace");
  const now = Date.now() / 1000;
  const seedFile = path.join(fakeHome, "seed.json");
  writeFileSync(
    seedFile,
    JSON.stringify([
      { id: "seed-server-1", cwd: SERVER_CWD, name: "Fix the login bug", preview: "ulw fix the login bug", updatedAt: now - 2 * 3600 },
      { id: "seed-server-2", cwd: SERVER_CWD, name: "Add rate limiting", preview: "add rate limiting to the API", updatedAt: now - 3 * 86400 },
      { id: "seed-client-1", cwd: CLIENT_CWD, name: "Restyle the sidebar", preview: "restyle the sidebar", updatedAt: now - 5 * 60 },
    ]),
  );
  launched = await launchApp({ omo: "fake", fakeHome, userData, pickDir, extraEnv: { FAKE_OMO_SEED_THREADS: seedFile } });
});

test.afterAll(async () => {
  await launched?.close();
  launched = null;
  for (const dir of [fakeHome, userData, pickDir]) if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

test("search filters thread rows by title and clears", async () => {
  const { page } = current();
  const rows = byTestId(page, TESTID.threadRow);
  await expect(rows).toHaveCount(3);
  await expect(byTestId(page, TESTID.workspaceGroup)).toHaveCount(2);

  const search = byTestId(page, TESTID.sidebarSearch);
  await search.fill("LOGIN");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-title", "Fix the login bug");
  await expect(byTestId(page, TESTID.workspaceGroup)).toHaveCount(1);
  await shot(page, "C002-search");

  await byTestId(page, TESTID.sidebarSearchClear).click();
  await expect(search).toHaveValue("");
  await expect(rows).toHaveCount(3);

  await search.fill("sidebar");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-title", "Restyle the sidebar");
  await search.fill("nothing matches this");
  await expect(byTestId(page, TESTID.sidebarNoMatch)).toBeVisible();
  await expect(rows).toHaveCount(0);
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(rows).toHaveCount(3);
});

test("the collapse toggle hides the sidebar and the header toggle restores it", async () => {
  const { page } = current();
  const frame = byTestId(page, TESTID.appFrame);
  await expect(frame).not.toHaveAttribute("data-sidebar-collapsed");
  await expect(byTestId(page, TESTID.headerSidebarToggle)).toHaveCount(0);

  await byTestId(page, TESTID.sidebarToggle).click();
  await expect(frame).toHaveAttribute("data-sidebar-collapsed", "true");
  await expect(byTestId(page, TESTID.sidebarSearch)).not.toBeInViewport();
  const restore = byTestId(page, TESTID.headerSidebarToggle);
  await expect(restore).toBeVisible();
  await shot(page, "C002-collapsed");

  await restore.click();
  await expect(frame).not.toHaveAttribute("data-sidebar-collapsed");
  await expect(byTestId(page, TESTID.sidebarSearch)).toBeInViewport();
  await expect(restore).toHaveCount(0);
});

test("New project picks a folder and starts a thread there", async () => {
  const { page, readFakeLog } = current();
  await expect(byTestId(page, TESTID.newSession)).toHaveText(/New project/);
  const threadId = await newSession(page);
  const started = readFakeLog().filter((frame) => frame["method"] === "thread/start");
  expect(started).toHaveLength(1);
  expect(started[0]).toMatchObject({ params: { cwd: pickDir } });
  const group = page.locator(`[data-testid="${TESTID.workspaceGroup}"][data-cwd=${JSON.stringify(pickDir)}]`);
  await expect(group).toBeVisible();
  await expect(group.locator(`[data-testid="${TESTID.threadRow}"][data-thread-id="${threadId}"]`)).toHaveAttribute("aria-current", "page");
  await expect(byTestId(page, TESTID.conversationHeader)).toContainText(path.basename(pickDir));
  await expect(byTestId(page, TESTID.emptyHero)).toHaveText("Send a message to start the conversation.");
});

test("a magic keyword highlights, shows the hint and is sent unchanged", async () => {
  const { page, readFakeLog } = current();
  const input = byTestId(page, TESTID.composerInput);
  const composer = byTestId(page, TESTID.composer);
  const hint = byTestId(page, TESTID.keywordHint);

  await input.fill("mass-ulw keeps the plain border");
  await expect(composer).not.toHaveAttribute("data-keyword");
  await expect(hint).toHaveCount(0);

  await input.fill("/ulw-loop fix it");
  await expect(composer).toHaveAttribute("data-keyword", "ulw-loop");
  await expect(byTestId(page, TESTID.keywordHighlight)).toHaveText("/ulw-loop");
  await expect(hint).toHaveText("/ulw-loop: OmO keeps working until the task is done.");
  await shot(page, "G015-ulw-loop");

  await input.fill("ulw fix the login bug");
  await expect(composer).toHaveAttribute("data-keyword", "ulw");
  await expect(byTestId(page, TESTID.keywordHighlight)).toHaveText("ulw");
  await expect(hint).toHaveText("ulw: OmO keeps working until the task is done.");
  await expect(byTestId(page, TESTID.fullAccessChip)).toHaveText("Full access");
  await shot(page, "C002-keyword");

  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(hint).toHaveCount(0);
  const sentTexts = (): string[] =>
    readFakeLog()
      .filter((frame) => frame["method"] === "turn/start")
      .flatMap((frame) => {
        const params = frame["params"];
        const input = typeof params === "object" && params !== null && "input" in params ? params.input : [];
        return Array.isArray(input) ? input.map((item: { text?: unknown }) => String(item.text)) : [];
      });
  await expect.poll(sentTexts).toEqual(["ulw fix the login bug"]);
  await expect(byTestId(page, TESTID.userMessage).last()).toContainText("ulw fix the login bug");
});

test("Open validates the workspace and target at the IPC boundary", async () => {
  const { page } = current();
  const open = byTestId(page, TESTID.openWorkspace);
  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute("data-primary", /^(vscode|cursor|finder)$/);

  const targets = await page.evaluate(() => window.omo.listOpenTargets());
  expect(targets.at(-1)).toEqual({ id: "finder" });

  const rejections = await page.evaluate(async (cwd) => {
    const attempt = async (run: () => Promise<unknown>): Promise<string> => {
      try {
        await run();
        return "resolved";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    return {
      relative: await attempt(() => window.omo.openWorkspace("work/server", "finder")),
      missing: await attempt(() => window.omo.openWorkspace(`${cwd}/does-not-exist`, "finder")),
      target: await attempt(() => window.omo.openWorkspace(cwd, "textedit" as never)),
    };
  }, pickDir);
  expect(rejections.relative).toMatch(/absolute/);
  expect(rejections.missing).toMatch(/does not exist/);
  expect(rejections.target).toMatch(/unknown open target/);
});

test("Settings fills the window with a searchable nav, a breadcrumb and Back", async () => {
  const { page } = current();
  await byTestId(page, TESTID.openSettings).click();
  const dialog = byTestId(page, TESTID.settingsDialog);
  await expect(dialog).toBeVisible();
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  expect(await dialog.boundingBox()).toEqual({ x: 0, y: 0, ...viewport });
  expect((await dialog.locator("nav").boundingBox())?.width).toBe(260);

  const cells = dialog.locator("[data-section]");
  const total = await cells.count();
  const crumb = page.getByTestId("settings-breadcrumb").locator("h2");
  const activeLabel = (): Promise<string> => dialog.locator('[data-section][aria-current="true"]').innerText();
  await expect(dialog).toHaveAttribute("data-active-section", "general");
  await expect(crumb).toHaveText(await activeLabel());
  await shot(page, "settings-full-window");

  const search = page.getByTestId("settings-search");
  await search.fill("opencodex");
  await expect(dialog.locator('[data-section="omo"]')).toBeVisible();
  await expect(dialog.locator('[data-section="accounts"]')).toBeVisible();
  await expect(dialog.locator('[data-section="general"]')).toHaveCount(0);
  await search.press("Enter");
  await expect(dialog).toHaveAttribute("data-active-section", "omo");
  await expect(page.getByTestId("proxy-settings")).toBeVisible();
  await expect(crumb).toHaveText(await activeLabel());

  await search.fill("no setting has this name");
  await expect(page.getByTestId("settings-search-empty")).toBeVisible();
  await expect(cells).toHaveCount(0);
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(cells).toHaveCount(total);
  await expect(dialog).toBeVisible();

  await dialog.locator('[data-section="general"]').click();
  await page.getByTestId("settings-back").click();
  await expect(dialog).toBeHidden();
  await expect(byTestId(page, TESTID.openSettings)).toBeFocused();
});

test("a narrow window tucks the settings nav behind the header toggle", async () => {
  const { app, page } = current();
  const resize = async (width: number, height: number): Promise<void> => {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height), { width, height });
    await expect(page.locator("html")).toHaveJSProperty("clientWidth", width);
  };
  await byTestId(page, TESTID.openSettings).click();
  const dialog = byTestId(page, TESTID.settingsDialog);
  const nav = dialog.locator("nav");
  const toggle = page.getByTestId("settings-nav-toggle");
  await expect(nav).toBeVisible();
  await expect(toggle).toHaveCount(0);

  await resize(600, 820);
  await expect(nav).toBeHidden();
  await toggle.click();
  await expect(nav).toBeVisible();
  await dialog.locator('[data-section="about"]').click();
  await expect(dialog).toHaveAttribute("data-active-section", "about");
  await expect(nav).toBeHidden();
  await expect(toggle).toBeFocused();
  await shot(page, "settings-narrow");

  await resize(1280, 820);
  await expect(nav).toBeVisible();
  await dialog.locator('[data-section="general"]').click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("Model settings store a profile's model and return it to Automatic", async () => {
  const { page } = current();
  await byTestId(page, TESTID.openSettings).click();
  const dialog = byTestId(page, TESTID.settingsDialog);
  await dialog.locator('[data-section="model"]').click();
  const select = page.locator('[data-testid="settings-model"] select[data-profile="geeky-normal"]');
  await expect(select).toHaveValue("");
  const catalog = await page.evaluate(async () => (await window.omo.request("model/list", { includeHidden: false })).data.map((model) => model.id));
  const [modelId] = catalog;
  if (modelId === undefined) throw new Error("the fake omo lists no models");
  const offered = (): Promise<string[]> =>
    select.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value).sort());
  await expect.poll(offered).toEqual(["", ...catalog].sort());
  const stored = (): Promise<unknown> => page.evaluate(async () => (await window.omo.getPreferences()).profileModels);

  await select.selectOption(modelId);
  await expect(select).toHaveValue(modelId);
  await expect.poll(stored).toEqual({ "geeky-normal": modelId });
  await shot(page, "settings-model");
  await select.selectOption("");
  await expect(select).toHaveValue("");
  await expect.poll(stored).toEqual({});

  await dialog.locator('[data-section="general"]').click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("Keybindings lists every custom menu accelerator", async () => {
  const { app, page } = current();
  const accelerators = await app.evaluate(({ Menu }) =>
    (Menu.getApplicationMenu()?.items ?? [])
      .flatMap((menu) => menu.submenu?.items ?? [])
      .filter((item) => !item.role && typeof item.accelerator === "string" && item.accelerator !== "")
      .map((item) => String(item.accelerator)),
  );
  expect(accelerators.length).toBeGreaterThan(0);
  await byTestId(page, TESTID.openSettings).click();
  const dialog = byTestId(page, TESTID.settingsDialog);
  await dialog.locator('[data-section="keybindings"]').click();
  const rows = page.locator('[data-testid="settings-keybindings"] [data-shortcut]');
  await expect(rows.first()).toBeVisible();
  const listed = await rows.evaluateAll((items) => items.map((item) => [...item.querySelectorAll("kbd")].map((key) => key.textContent).join("+")));
  const modifier = process.platform === "darwin" ? "⌘" : "Ctrl";
  for (const accelerator of accelerators) expect(listed).toContain(accelerator.replace(/^(CmdOrCtrl|CommandOrControl)/, modifier));

  await dialog.locator('[data-section="general"]').click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
