import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OMO_INSTALL_COMMAND, type BridgeStatus } from "../../shared/ipc";
import { IphoneBridge, FrameDecoder, allowedMethod, encodeFrame, loadIphoneToken } from "../../electron/iphone/bridge";
import { Usbmux, type UsbDevice } from "../../electron/iphone/usbmux";
import { RpcRequestError } from "../../electron/omo/app-server-client";
import type { OmoSupervisor } from "../../electron/omo/supervisor";

class PhoneSocket extends EventEmitter {
  destroyed = false;
  frames: Record<string, unknown>[] = [];
  private decoder = new FrameDecoder();
  write(bytes: Buffer): void { this.decoder.push(bytes, (frame) => { this.frames.push(frame as Record<string, unknown>); this.emit("frame", frame); }); }
  resume(): void {}
  destroy(): void { if (this.destroyed) return; this.destroyed = true; this.emit("close"); }
  send(frame: unknown): void { this.emit("data", encodeFrame(frame)); }
}
const status: BridgeStatus = { state: "connected", omo: null, userAgent: null, message: null, stderrTail: null, exitCode: null, restartAttempt: 0, installCommand: OMO_INSTALL_COMMAND };
function harness(enabled = true) {
  const mux = new Usbmux("/fake-only-unused.sock");
  let attached!: (device: UsbDevice) => void;
  let detached!: (id: number) => void;
  vi.spyOn(mux, "listen").mockImplementation((a, d) => { attached = a; detached = d; return new PhoneSocket() as unknown as Socket; });
  vi.spyOn(mux, "stop").mockImplementation(() => {});
  const socket = new PhoneSocket();
  const connect = vi.spyOn(mux, "connect").mockResolvedValue(socket as unknown as Socket);
  const request = vi.fn().mockResolvedValue({ ok: true });
  let notify!: Parameters<OmoSupervisor["onNotification"]>[0];
  let change!: Parameters<OmoSupervisor["onStatus"]>[0];
  let ask!: Parameters<OmoSupervisor["onServerRequest"]>[0];
  const respond = vi.fn().mockResolvedValue(undefined);
  const dispose = vi.fn();
  const supervisor = { getStatus: () => status, request: request as OmoSupervisor["request"], respond: respond as OmoSupervisor["respond"], onStatus: (listener: typeof change) => { change = listener; return dispose; }, onNotification: (listener: typeof notify) => { notify = listener; return dispose; }, onServerRequest: (listener: typeof ask) => { ask = listener; return dispose; } };
  const bridge = new IphoneBridge(supervisor, mux, enabled);
  return { bridge, mux, socket, connect, request, respond, dispose, attach: () => attached({ id: 1, serial: "fake", name: "iPhone" }), detach: () => detached(1), notify: (value: Parameters<typeof notify>[0]) => notify(value), change: (value: BridgeStatus) => change(value), ask: (value: Parameters<typeof ask>[0]) => ask(value) };
}
async function attach(h: ReturnType<typeof harness>): Promise<void> {
  const connected = new Promise<void>((resolve) => { const off = h.bridge.onStatus((value) => { if (value.state === "connected") { off(); resolve(); } }); });
  h.attach();
  await connected;
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("phone bridge lifecycle", () => {
  it("sends hello first, forwards status/notifications, replies to ping", async () => {
    const h = harness(); h.bridge.start();
    try {
      await attach(h);
      expect(h.socket.frames[0]).toMatchObject({ type: "hello", version: 1, bridge: { state: "connected" } });
      expect(h.socket.frames[0]?.["token"]).toMatch(/^[0-9a-f]{64}$/);
      expect(h.socket.frames[1]).toEqual({ type: "bridgeStatus", state: "connected" });
      h.change({ ...status, state: "restarting" });
      h.notify({ method: "turn/completed", params: {} });
      h.socket.send({ type: "ping", t: 19 });
      expect(h.socket.frames.slice(2)).toEqual([{ type: "bridgeStatus", state: "restarting" }, { type: "notification", notification: { method: "turn/completed", params: {} } }, { type: "pong", t: 19 }]);
    } finally { h.bridge.stop(); }
    expect(h.socket.destroyed).toBe(true); expect(h.dispose).toHaveBeenCalledTimes(3);
  });
  it("retries a failed connection at 2 seconds and cancels on detach", async () => {
    vi.useFakeTimers(); const h = harness(); h.connect.mockRejectedValue(new Error("app closed")); h.bridge.start(); h.attach();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.bridge.getStatus().state).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1999); expect(h.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(h.connect).toHaveBeenCalledTimes(2);
    h.detach(); await vi.advanceTimersByTimeAsync(4000);
    expect(h.connect).toHaveBeenCalledTimes(2); expect(h.bridge.getStatus().state).toBe("searching"); h.bridge.stop();
  });
  it("pings every 10 seconds and closes after 30 seconds of silence", async () => {
    vi.useFakeTimers(); const h = harness(); h.bridge.start(); await attach(h);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.socket.frames.at(-1)?.["type"]).toBe("ping");
    await vi.advanceTimersByTimeAsync(123);
    h.socket.send({ type: "pong", t: 1 });
    await vi.advanceTimersByTimeAsync(29_999); expect(h.socket.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(h.socket.destroyed).toBe(true); h.bridge.stop();
  });
  it("forwards allowed RPC and preserves app-server error codes", async () => {
    const h = harness(); h.request.mockRejectedValue(new RpcRequestError(-32001, "failed")); h.bridge.start();
    try {
      await attach(h);
      const response = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("RPC response timeout")), 1000);
        h.socket.once("frame", (frame: unknown) => { clearTimeout(timer); resolve(frame); });
      });
      h.socket.send({ type: "rpc", id: 2, method: "thread/start", params: { cwd: "/tmp" } });
      expect(await response).toEqual({ type: "rpcError", id: 2, error: { code: -32001, message: "failed" } });
      expect(h.request).toHaveBeenCalledWith("thread/start", { cwd: "/tmp" });
    } finally { h.bridge.stop(); }
  });
  it("rejects disallowed methods and invalid params without invoking omo", async () => {
    const h = harness(); h.bridge.start();
    try {
      await attach(h);
      h.socket.send({ type: "rpc", id: 1, method: "config/value/write", params: {} });
      h.socket.send({ type: "rpc", id: 2, method: "thread/start", params: [] });
      expect(h.request).not.toHaveBeenCalled();
      expect(h.socket.frames.slice(2)).toMatchObject([{ type: "rpcError", id: 1, error: { code: -32601 } }, { type: "rpcError", id: 2, error: { code: -32602 } }]);
    } finally { h.bridge.stop(); }
  });
  it("does not discover devices when disabled", () => { const h = harness(false); h.bridge.start(); expect(h.mux.listen).not.toHaveBeenCalled(); h.bridge.stop(); });
  it("allows thread rename, delete and archive", () => {
    for (const method of ["thread/name/set", "thread/delete", "thread/archive"]) expect(allowedMethod(method)).toBe(true);
    expect(allowedMethod("config/value/write")).toBe(false);
  });
  it("ignores unknown frame types but closes on a non-object frame", async () => {
    const h = harness(); h.bridge.start();
    try {
      await attach(h);
      const response = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("RPC response timeout")), 1000);
        h.socket.on("frame", (frame: Record<string, unknown>) => { if (frame["type"] === "rpcResult") { clearTimeout(timer); resolve(frame); } });
      });
      h.socket.send({ type: "made-up" });
      h.socket.send({ type: "rpc", id: 4, method: "thread/list", params: {} });
      expect(await response).toEqual({ type: "rpcResult", id: 4, result: { ok: true } });
      expect(h.socket.destroyed).toBe(false);
      h.socket.send([1, 2]);
      expect(h.socket.destroyed).toBe(true);
    } finally { h.bridge.stop(); }
  });
});

describe("phone bridge server requests", () => {
  const approval = { id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: "t", command: "ls" } };
  it("forwards server requests and answers omo with the phone's result once", async () => {
    const h = harness(); h.bridge.start();
    try {
      await attach(h);
      h.ask(approval);
      expect(h.bridge.getStatus().devices[0]?.pendingApproval).toBe(true);
      expect(h.socket.frames.at(-1)).toEqual({ type: "serverRequest", ...approval });
      h.socket.send({ type: "serverAnswer", id: "approval-1", result: { decision: "accept" } });
      // The bridge hands the answer to omo synchronously while handling the frame.
      expect(h.respond).toHaveBeenCalledWith("approval-1", { decision: "accept" });
      expect(h.bridge.getStatus().devices[0]?.pendingApproval).toBe(false);
      h.socket.send({ type: "serverAnswer", id: "approval-1", result: { decision: "decline" } });
      h.socket.send({ type: "serverAnswer", id: 99, result: { decision: "accept" } });
      expect(h.respond).toHaveBeenCalledTimes(1);
      expect(h.socket.destroyed).toBe(false);
    } finally { h.bridge.stop(); }
  });
  it("replays pending requests on connect and drops ones resolved on the Mac", async () => {
    const h = harness(); h.bridge.start();
    try {
      h.ask(approval);
      h.ask({ id: 7, method: "item/tool/requestUserInput", params: { questions: [] } });
      h.notify({ method: "serverRequest/resolved", params: { threadId: "t", requestId: 7 } });
      await attach(h);
      expect(h.socket.frames.slice(2)).toEqual([{ type: "serverRequest", ...approval }]);
      expect(h.bridge.getStatus().devices[0]?.pendingApproval).toBe(true);
      h.notify({ method: "serverRequest/resolved", params: { threadId: "t", requestId: "approval-1" } });
      expect(h.bridge.getStatus().devices[0]?.pendingApproval).toBe(false);
      h.socket.send({ type: "serverAnswer", id: 7, result: { answers: {} } });
      h.socket.send({ type: "serverAnswer", id: "approval-1", result: "accept" });
      expect(h.respond).not.toHaveBeenCalled();
      h.ask(approval);
      h.change({ ...status, state: "restarting" });
      expect(h.bridge.getStatus().devices[0]?.pendingApproval).toBe(false);
      h.socket.send({ type: "serverAnswer", id: "approval-1", result: { decision: "accept" } });
      expect(h.respond).not.toHaveBeenCalled();
    } finally { h.bridge.stop(); }
  });
  it("replays requests still pending when the phone confirms trust", async () => {
    const h = harness(); h.bridge.start();
    try {
      await attach(h);
      h.ask(approval);
      h.ask({ id: 7, method: "item/tool/requestUserInput", params: { questions: [] } });
      h.notify({ method: "serverRequest/resolved", params: { threadId: "t", requestId: 7 } });
      const mark = h.socket.frames.length;
      h.socket.send({ type: "trusted" });
      expect(h.socket.frames.slice(mark)).toEqual([{ type: "bridgeStatus", state: "connected" }, { type: "serverRequest", ...approval }]);
    } finally { h.bridge.stop(); }
  });
});

describe("installation token", () => {
  it("persists a private random token across store loads", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "iphone-token-"));
    try {
      const token = loadIphoneToken(dir);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      expect(loadIphoneToken(dir)).toBe(token);
      expect(JSON.parse(readFileSync(path.join(dir, "iphone-token.json"), "utf8"))).toEqual({ token });
      if (process.platform !== "win32") expect(statSync(path.join(dir, "iphone-token.json")).mode & 0o777).toBe(0o600);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
