import { createServer } from "node:http";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AndroidBridge, parseDevices, type AdbExec } from "../../electron/android/bridge";
import { OmoSupervisor, type SupervisedClient } from "../../electron/omo/supervisor";
import { RpcRequestError } from "../../electron/omo/app-server-client";
import type { RpcNotification, RpcServerRequest } from "../../shared/protocol";

const devices = "List of devices attached\n192.168.1.10:39421 device product:dm1q model:SM_S911B device:dm1q\nemulator-5560 device product:sdk model:SDK_Phone device:emu\nlocked unauthorized\nlost offline\n";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); vi.restoreAllMocks(); });

async function harness(port = 0) {
  let notify: (value: RpcNotification) => void = () => undefined;
  let ask: (value: RpcServerRequest) => void = () => undefined;
  const requests = vi.fn().mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === "model/list") return { data: [{ id: "provider/model-1", model: "model-1", displayName: "Model One", isDefault: true }], nextCursor: null };
    if (method === "thread/list") return { data: [], nextCursor: null };
    if (method === "thread/start") return { thread: { id: "thread-1", cwd: params["cwd"], turns: [] }, model: "model-1", cwd: params["cwd"] };
    if (method === "turn/start") return { turn: { id: "turn-1", status: "inProgress", items: [] } };
    return {};
  });
  const respond = vi.fn();
  const client: SupervisedClient = {
    pid: 123, initializeResult: { userAgent: "test" },
    start: async () => ({ userAgent: "test" }), stop: async () => {},
    request: requests as SupervisedClient["request"], respond,
    onNotification: (listener) => { notify = listener; return () => {}; },
    onServerRequest: (listener) => { ask = listener; return () => {}; },
    onMalformed: () => () => {}, onExit: () => () => {},
  };
  const supervisor = new OmoSupervisor({
    homeDir: "P:/coding", baseEnv: {}, clientVersion: "test", restartDelaysMs: [],
    resolveEnv: async () => ({ env: {}, fromLoginShell: false }),
    locate: async () => ({ ok: true, binary: { path: "fake-omo", version: "test", source: "override" } }),
    createClient: () => client,
  });
  await supervisor.start(); cleanup.push(() => supervisor.stop());
  const exec = vi.fn<AdbExec>().mockImplementation(async (_file, args) => ({ stdout: args[0] === "devices" ? devices : "", stderr: "" }));
  const bridge = new AndroidBridge(supervisor, { adbPath: "fake-adb", execFile: exec, port });
  cleanup.push(() => bridge.stop());
  const connect = async (serial = "192.168.1.10:39421") => {
    const status = await bridge.connect(serial);
    if (!status.url) throw new Error(status.message ?? "No phone URL");
    const url = new URL(status.url), token = new URLSearchParams(url.hash.slice(1)).get("token")!;
    const post = (path: string, value: unknown, auth = token, extra: Record<string, string> = {}) => fetch(url.origin + path, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + auth, ...extra }, body: JSON.stringify(value), signal: AbortSignal.timeout(5_000),
    });
    return { url, token, post };
  };
  return { bridge, exec, requests, respond, supervisor, connect, notify: (value: RpcNotification) => notify(value), ask: (value: RpcServerRequest) => ask(value) };
}

async function events(origin: string, token: string) {
  const abort = new AbortController();
  const response = await fetch(origin + "/events?token=" + token, { signal: abort.signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffered = "";
  cleanup.push(async () => { abort.abort(); await reader.cancel().catch(() => {}); });
  async function next(): Promise<Record<string, unknown>> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("SSE event timeout")), 5_000); });
    const read = async () => {
      while (!buffered.includes("\n\n")) { const chunk = await reader.read(); if (chunk.done) throw new Error("SSE closed"); buffered += decoder.decode(chunk.value, { stream: true }); }
      const end = buffered.indexOf("\n\n"), frame = buffered.slice(0, end); buffered = buffered.slice(end + 2);
      return JSON.parse(frame.replace(/^data: /, "")) as Record<string, unknown>;
    };
    try { return await Promise.race([read(), timeout]); } finally { clearTimeout(timer!); }
  }
  return { next };
}

describe("Android ADB lifecycle", () => {
  it("parses ready, unauthorized and offline devices including wireless serials", () => {
    expect(parseDevices(devices)).toEqual([
      { serial: "192.168.1.10:39421", name: "SM S911B", state: "ready" },
      { serial: "emulator-5560", name: "SDK Phone", state: "ready" },
      { serial: "locked", name: "locked", state: "unauthorized" }, { serial: "lost", name: "lost", state: "offline" },
    ]);
  });
  it("does no device operations on construction or refresh and connects only the chosen serial", async () => {
    const h = await harness(); expect(h.exec).not.toHaveBeenCalled();
    expect(h.bridge.getStatus().state).toBe("disabled");
    const listener = vi.fn(), off = h.bridge.onStatus(listener);
    const refreshed = await h.bridge.refresh(); expect(refreshed.devices).toHaveLength(4); expect(refreshed.state).toBe("searching");
    expect(h.exec.mock.calls.map((call) => call[1])).toEqual([["devices", "-l"]]);
    const { url, token } = await h.connect("emulator-5560");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(h.exec).toHaveBeenCalledWith("fake-adb", ["-s", "emulator-5560", "reverse", "tcp:" + url.port, "tcp:" + url.port]);
    expect(h.exec).toHaveBeenCalledWith("fake-adb", ["-s", "emulator-5560", "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url.href]);
    expect(h.bridge.getStatus()).toMatchObject({ state: "connected", selectedSerial: "emulator-5560" });
    expect(listener).toHaveBeenCalled(); off();
    expect(await h.bridge.disconnect()).toMatchObject({ state: "searching", selectedSerial: null, url: null });
    expect(h.exec).toHaveBeenLastCalledWith("fake-adb", ["-s", "emulator-5560", "reverse", "--remove", "tcp:" + url.port]);
    await expect(fetch(url.origin)).rejects.toThrow();
  });
  it("never launches an unauthorized or unlisted device", async () => {
    const h = await harness(); await h.bridge.connect("locked"); await h.bridge.connect("not-attached");
    expect(h.bridge.getStatus().state).toBe("error");
    expect(h.exec.mock.calls.every((call) => call[1][0] === "devices")).toBe(true);
  });
  it("reports missing ADB and cleans up reverse on browser failure without leaking its URL", async () => {
    const h = await harness(); h.exec.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    expect(await h.bridge.refresh()).toMatchObject({ adbAvailable: false, state: "disabled" });
    h.exec.mockImplementation(async (_file, args) => {
      if (args.includes("shell")) throw new Error(args.join(" "));
      return { stdout: args[0] === "devices" ? devices : "", stderr: "" };
    });
    const log = vi.spyOn(console, "error");
    const status = await h.bridge.connect("emulator-5560");
    expect(status).toMatchObject({ state: "error", url: null, selectedSerial: null });
    expect(status.message).not.toContain("token"); expect(log).not.toHaveBeenCalled();
    expect(h.exec.mock.calls.at(-1)?.[1]).toContain("--remove");
  });
  it("uses an ephemeral loopback port if the preferred one is occupied", async () => {
    const occupied = createServer(); await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
    const address = occupied.address(); if (!address || typeof address === "string") throw new Error("No occupied port");
    const h = await harness(address.port), { url } = await h.connect(); expect(Number(url.port)).not.toBe(address.port);
  });
  it("revokes URLs on switching and removes disconnected devices on refresh", async () => {
    const h = await harness(), first = await h.connect(), second = await h.connect("emulator-5560");
    expect(second.token).not.toBe(first.token);
    expect((await second.post("/rpc", { method: "model/list", params: {} }, first.token)).status).toBe(401);
    h.exec.mockImplementation(async () => ({ stdout: "List of devices attached\n", stderr: "" }));
    expect(await h.bridge.refresh()).toMatchObject({ devices: [], state: "searching", selectedSerial: null, url: null });
    await h.bridge.stop(); h.exec.mockClear(); await h.bridge.refresh(); await h.bridge.connect("emulator-5560");
    expect(h.exec).not.toHaveBeenCalled(); expect(h.bridge.getStatus().state).toBe("disabled");
  });
});

describe("Android local HTTP and real supervisor integration", () => {
  it("runs the shipped phone client, preserves provider-qualified model IDs and renders agent output separately", async () => {
    const h = await harness(), phone = await h.connect();
    const html = await (await fetch(phone.url.origin)).text();
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1];
    if (!script) throw new Error("Missing phone script");
    class Element {
      value = ""; textContent = ""; className = ""; disabled = false;
      children: Element[] = []; scrollTop = 0; scrollHeight = 0;
      onclick?: (event?: unknown) => Promise<void>;
      onsubmit?: (event?: unknown) => Promise<void>;
      append(...children: Element[]): void { this.children.push(...children); }
      replaceChildren(...children: Element[]): void { this.children = children; }
    }
    const elements = new Map<string, Element>();
    const element = (id: string): Element => { let value = elements.get(id); if (!value) { value = new Element(); elements.set(id, value); } return value; };
    let stream: { onmessage?: (event: { data: string }) => void };
    const context = createContext({
      document: { getElementById: element, createElement: () => new Element() },
      location: { hash: phone.url.hash, pathname: "/" }, history: { replaceState: () => {} },
      sessionStorage: { getItem: () => null, setItem: () => {} }, URLSearchParams,
      EventSource: class { constructor() { stream = this; } onmessage?: (event: { data: string }) => void; }, fetch: (route: string, init: RequestInit) => fetch(phone.url.origin + route, init),
    });
    runInContext(script, context);
    await runInContext("loadModels()", context);
    expect(element("model").children.map((option) => option.value)).toEqual(["", "provider/model-1"]);
    expect(element("model").value).toBe("");
    element("model").value = "provider/model-1"; element("cwd").value = "P:/coding";
    runInContext("connected = true", context);
    await element("new").onclick!();
    expect(h.requests).toHaveBeenCalledWith("thread/start", { cwd: "P:/coding", model: "provider/model-1" });
    element("text").value = "Hello from Android";
    await element("composer").onsubmit!();
    expect(h.requests).toHaveBeenCalledWith("turn/start", { threadId: "thread-1", model: "provider/model-1", input: [{ type: "text", text: "Hello from Android" }] });
    expect(element("error").textContent).toBe("");
    expect(element("text").value).toBe("");
    const emit = (method: string, params: unknown) => stream.onmessage!({ data: JSON.stringify({ type: "notification", notification: { method, params } }) });
    emit("item/started", { threadId: "thread-1", turnId: "turn-1", item: { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Hello from Android" }] } });
    expect(element("messages").children.map((card) => card.children[0]!.textContent)).toEqual(["You"]);
    emit("item/agentMessage/delta", { threadId: "other-thread", turnId: "turn-1", itemId: "agent-1", delta: "Unrelated" });
    expect(element("messages").children).toHaveLength(1);
    emit("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1", delta: "Android " });
    emit("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId: "agent-1", delta: "reply" });
    expect(element("messages").children.map((card) => card.children.map((part) => part.textContent))).toEqual([["You", "Hello from Android"], ["OmO", "Android reply"]]);
    emit("item/completed", { threadId: "thread-1", turnId: "turn-1", item: { id: "agent-1", type: "agentMessage", text: "Android reply complete" } });
    emit("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "completed", items: [] } });
    expect(element("messages").children).toHaveLength(2);
    expect(element("messages").children[1]!.children[1]!.textContent).toBe("Android reply complete");
    expect(element("interrupt").disabled).toBe(true);
  });
  it("enforces token and origin, rejects unsafe methods/params and preserves supervisor errors", async () => {
    const h = await harness(), phone = await h.connect();
    for (const auth of ["", "bad-token", "\u00e9".repeat(64)]) expect((await phone.post("/rpc", { method: "model/list", params: {} }, auth)).status).toBe(401);
    expect((await fetch(phone.url.origin + "/events")).status).toBe(401);
    expect((await phone.post("/rpc", { method: "model/list", params: {} }, phone.token, { Origin: "https://untrusted.example" })).status).toBe(403);
    expect((await phone.post("/rpc", { method: "config/value/write", params: {} })).status).toBe(403);
    expect((await phone.post("/rpc", { method: "model/list", params: [] })).status).toBe(400);
    expect(h.requests).not.toHaveBeenCalled();
    h.requests.mockRejectedValueOnce(new RpcRequestError(-32001, "provider unavailable"));
    expect(await (await phone.post("/rpc", { method: "model/list", params: {} })).json()).toEqual({ error: { code: -32001, message: "provider unavailable" } });
    const page = await fetch(phone.url.origin); expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(await page.text()).not.toContain(phone.token);
  });
  it("starts a thread and text turn, streams output, replays approvals and responds once", async () => {
    const h = await harness(), phone = await h.connect();
    const call = async (method: string, params: unknown) => (await (await phone.post("/rpc", { method, params })).json()) as { result: Record<string, unknown> };
    expect((await call("model/list", {})).result["data"]).toHaveLength(1);
    expect((await call("thread/start", { cwd: "P:/coding", model: "model-1" })).result["thread"]).toMatchObject({ id: "thread-1" });
    await call("turn/start", { threadId: "thread-1", input: [{ type: "text", text: "Hello" }] });
    expect(h.requests).toHaveBeenCalledWith("turn/start", { threadId: "thread-1", input: [{ type: "text", text: "Hello" }] });
    const approval = { id: "approval-1", method: "item/commandExecution/requestApproval", params: { command: "dir", threadId: "thread-1" } };
    h.ask(approval); h.ask({ ...approval, id: "desktop-resolved" }); h.notify({ method: "serverRequest/resolved", params: { requestId: "desktop-resolved" } });
    const stream = await events(phone.url.origin, phone.token);
    expect(await stream.next()).toEqual({ type: "bridgeStatus", state: "connected" });
    expect(await stream.next()).toEqual({ type: "serverRequest", ...approval });
    const next = stream.next();
    const notification = { method: "item/agentMessage/delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "answer", delta: "<script>hello</script>" } };
    h.notify(notification); expect(await next).toEqual({ type: "notification", notification });
    const resolved = stream.next();
    expect((await phone.post("/answer", { id: "approval-1", result: { decision: "accept" } })).status).toBe(200);
    expect(h.respond).toHaveBeenCalledExactlyOnceWith("approval-1", { decision: "accept" });
    expect(await resolved).toMatchObject({ type: "notification", notification: { method: "serverRequest/resolved", params: { requestId: "approval-1" } } });
    expect((await phone.post("/answer", { id: "approval-1", result: { decision: "decline" } })).status).toBe(409);
    const disconnected = stream.next(); await h.supervisor.stop(); expect(await disconnected).toEqual({ type: "bridgeStatus", state: "stopped" });
    expect((await phone.post("/rpc", { method: "thread/list", params: {} })).status).toBe(502);
  });
});
