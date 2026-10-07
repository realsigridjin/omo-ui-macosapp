import { rmSync } from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { createFakeUsbmuxd, type PhoneFrame } from "../tests/fixtures/fake-usbmuxd.mjs";
import { TESTID } from "../src/ui/testids.ts";
import { byTestId, launchApp, setTheme, shot, tempDir } from "./helpers.ts";

test("USB phone controls omo and Settings tracks detach", async () => {
  if (process.platform === "win32") {
    const app = await launchApp({ omo: "fake" });
    try {
      await byTestId(app.page, TESTID.openSettings).click();
      await app.page.locator('[data-section="android"]').click();
      await expect(app.page.getByTestId("android-refresh")).toBeVisible();
      await expect(app.page.locator('[data-section="iphone"]')).toHaveCount(0);
      expect(await app.page.evaluate(() => window.omo.getIphoneStatus())).toMatchObject({ enabled: false, devices: [] });
      await shot(app.page, "iphone-windows-unsupported");
    } finally {
      await app.close();
    }
    return;
  }
  const dir = tempDir("iphone");
  const fake = await createFakeUsbmuxd(path.join(dir, "mux.sock"));
  try {
    const hello = fake.waitFor((frame) => frame.type === "hello");
    const app = await launchApp({ omo: "fake", extraEnv: { OMO_UI_IPHONE_BRIDGE: "1", OMO_UI_USBMUXD_SOCKET: path.join(dir, "mux.sock") } });
    try {
      const firstHello = await hello;
      expect(firstHello.version).toBe(1);
      const token = "token" in firstHello ? firstHello.token : undefined;
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      await fake.waitFor((frame) => frame.type === "bridgeStatus" && (frame as unknown as { state: string }).state === "connected");
      const started = fake.waitFor((frame) => frame.type === "rpcResult" && frame.id === 1);
      fake.send({ type: "rpc", id: 1, method: "thread/start", params: { cwd: dir } });
      const threadId = (await started).result?.thread?.id;
      expect(threadId).toBeTruthy();
      const delta = fake.waitFor((frame) => frame.notification?.method === "item/agentMessage/delta");
      const completed = fake.waitFor((frame) => frame.notification?.method === "turn/completed");
      const turn = fake.waitFor((frame) => frame.type === "rpcResult" && frame.id === 2);
      fake.send({ type: "rpc", id: 2, method: "turn/start", params: { threadId, input: [{ type: "text", text: "Hello from USB" }] } });
      await Promise.all([turn, delta, completed]);
      const rejected = fake.waitFor((frame) => frame.type === "rpcError" && frame.id === 3);
      fake.send({ type: "rpc", id: 3, method: "config/value/write", params: { threadId } });
      expect((await rejected).error?.code).toBe(-32601);
      expect(app.readFakeLog().some((entry) => entry["method"] === "config/value/write")).toBe(false);

      // Approval and question round trip: omo asks, the phone answers, omo records the phone's decision.
      const mark = fake.frames.length;
      type ServerRequestFrame = { type: "serverRequest"; id: number | string; method: string; params: Record<string, unknown> };
      const after = (predicate: (frame: PhoneFrame) => boolean) => (frame: PhoneFrame) => fake.frames.indexOf(frame) >= mark && predicate(frame);
      const serverRequest = (method: string) => fake.waitFor(after((frame) => frame.type === "serverRequest" && (frame as unknown as ServerRequestFrame).method === method)) as unknown as Promise<ServerRequestFrame>;
      const approval = serverRequest("item/commandExecution/requestApproval");
      const question = serverRequest("item/tool/requestUserInput");
      const scenarioDone = fake.waitFor(after((frame) => frame.notification?.method === "turn/completed"));
      fake.send({ type: "rpc", id: 4, method: "turn/start", params: { threadId, input: [{ type: "text", text: "SCENARIO:full" }] } });
      const asked = await approval;
      expect(asked.params["command"]).toBe("rm -rf /tmp/fake-demo");
      await byTestId(app.page, TESTID.openSettings).click();
      await app.page.locator('[data-section="iphone"]').click();
      await expect(byTestId(app.page, TESTID.settingsIphone)).toContainText("FAKE-IPHONE-007");
      await expect(app.page.locator('[data-pending-approval="true"]')).toBeVisible();
      await shot(app.page, "iphone-pending-approval");
      fake.send({ type: "serverAnswer", id: asked.id, result: { decision: "accept" } });
      fake.send({ type: "serverAnswer", id: (await question).id, result: { answers: { q1: { answers: ["B"] } } } });
      await scenarioDone;
      await expect(app.page.locator('[data-pending-approval="false"]')).toBeVisible();
      await app.page.locator('[data-section="general"]').click();
      await app.page.keyboard.press("Escape");
      const answers = app.readFakeLog().filter((entry) => entry["method"] === undefined && "result" in entry);
      expect(answers).toContainEqual({ id: asked.id, result: { decision: "accept" } });
      expect(answers).toContainEqual(expect.objectContaining({ result: { answers: { q1: { answers: ["B"] } } } }));

      // An unknown frame type is ignored; the link stays up and later RPCs still answer.
      fake.send({ type: "made-up" });
      const renamed = fake.waitFor((frame) => frame.type === "rpcResult" && frame.id === 5);
      fake.send({ type: "rpc", id: 5, method: "thread/name/set", params: { threadId, name: "From the phone" } });
      await renamed;
      expect(app.readFakeLog()).toContainEqual(expect.objectContaining({ method: "thread/name/set", params: { threadId, name: "From the phone" } }));
      const reconnectMark = fake.frames.length;
      const nextHello = fake.waitFor((frame) => fake.frames.indexOf(frame) >= reconnectMark && frame.type === "hello");
      fake.send([]);
      const secondHello = await nextHello;
      expect("token" in secondHello ? secondHello.token : undefined).toBe(token);
      for (const theme of ["light", "dark"] as const) {
        await setTheme(app.page, theme);
        await byTestId(app.page, TESTID.openSettings).click();
        await app.page.locator('[data-section="iphone"]').click();
        await expect(byTestId(app.page, TESTID.iphoneStatus)).toHaveAttribute("data-state", "connected");
        await expect(byTestId(app.page, TESTID.settingsIphone)).toContainText("Test iPhone");
        await shot(app.page, `iphone-${theme}`);
        await app.page.locator('[data-section="general"]').click();
        await app.page.keyboard.press("Escape");
      }
      await byTestId(app.page, TESTID.openSettings).click();
      await app.page.locator('[data-section="iphone"]').click();
      fake.detach();
      await expect(byTestId(app.page, TESTID.iphoneStatus)).toHaveAttribute("data-state", "searching");
      await expect(byTestId(app.page, TESTID.iphoneStatus)).toHaveText("Not connected");
    } finally { await app.close(); }
  } finally { await fake.close(); rmSync(dir, { recursive: true, force: true }); }
});
