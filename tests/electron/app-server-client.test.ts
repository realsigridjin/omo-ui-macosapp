import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppServerClient, AppServerStartError, RpcRequestError } from "../../electron/omo/app-server-client";
import type { AppServerClientOptions, ExitInfo } from "../../electron/omo/app-server-client";
import type { RpcNotification, RpcServerRequest } from "../../shared/protocol";

const STUB = path.join(__dirname, "fixtures", "fake-app-server.mjs");
const CRASH = path.join(__dirname, "..", "fixtures", "omo-crash.mjs");
const clients: AppServerClient[] = [];

function stubClient(env: Record<string, string> = {}, overrides: Partial<AppServerClientOptions> = {}): AppServerClient {
  const client = new AppServerClient({
    command: process.execPath,
    args: [STUB],
    cwd: __dirname,
    env: { PATH: process.env["PATH"] ?? "", ...env },
    clientVersion: "0.0.0-test",
    ...overrides,
  });
  clients.push(client);
  return client;
}

function nextEvent<T>(subscribe: (listener: (value: T) => void) => () => void, timeoutMs = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("timed out waiting for event"));
    }, timeoutMs);
    const off = subscribe((value) => {
      clearTimeout(timer);
      off();
      resolve(value);
    });
  });
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
});

describe("AppServerClient", () => {
  it("initializes and correlates out-of-order responses", async () => {
    const client = stubClient();
    const init = await client.start();
    expect(init.userAgent).toBe("fake/1.0");
    expect(client.initializeResult?.codexHome).toBe("/tmp/fake-codex");
    const first = client.request("thread/read", { threadId: "a" });
    const second = client.request("thread/read", { threadId: "b" });
    await client.request("thread/archive", { threadId: "release" });
    await expect(first).resolves.toEqual({ thread: { id: "a" } });
    await expect(second).resolves.toEqual({ thread: { id: "b" } });
  });

  it("fans out notifications and server requests, and respond() writes {id, result}", async () => {
    const client = stubClient();
    await client.start();
    const notifications: RpcNotification[] = [];
    client.onNotification((notification) => notifications.push(notification));
    const serverRequest = nextEvent<RpcServerRequest>((listener) => client.onServerRequest(listener));
    const turn = client.request("turn/start", { threadId: "t1", input: [] });
    const request = await serverRequest;
    expect(request).toEqual({ id: "user-input-0", method: "item/tool/requestUserInput", params: { threadId: "t1" } });
    client.respond(request.id, { answers: { q: { answers: ["yes"] } } });
    await turn;
    expect(notifications).toEqual([
      { method: "turn/started", params: { threadId: "t1" }, emittedAtMs: 5 },
      { method: "test/answered", params: { id: "user-input-0", result: { answers: { q: { answers: ["yes"] } } } } },
    ]);
  });

  it("rejects with RpcRequestError carrying the server error fields", async () => {
    const client = stubClient();
    await client.start();
    const error = await client.request("thread/name/set", { threadId: "t", name: "" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcRequestError);
    expect(error).toMatchObject({ code: -32602, message: "bad name", data: { field: "name" } });
  });

  it("reports a malformed stdout line", async () => {
    const client = stubClient();
    await client.start();
    const malformed = nextEvent<string>((listener) => client.onMalformed((line) => listener(line)));
    await client.request("model/list", {});
    await expect(malformed).resolves.toBe("garbage line");
  });

  it("rejects pending requests when the child exits and reports code and stderr tail", async () => {
    const client = stubClient();
    await client.start();
    const exit = nextEvent<ExitInfo>((listener) => client.onExit(listener));
    const pending = client.request("thread/read", { threadId: "held" });
    const fatal = client.request("thread/delete", { threadId: "x" });
    await expect(pending).rejects.toBeInstanceOf(RpcRequestError);
    await expect(fatal).rejects.toBeInstanceOf(RpcRequestError);
    const info = await exit;
    expect(info.code).toBe(7);
    expect(info.expected).toBe(false);
    expect(info.stderrTail).toContain("boom-stderr");
  });

  it("times out a request the server never answers", async () => {
    const client = stubClient({}, { requestTimeoutMs: 50 });
    await client.start();
    await expect(client.request("thread/read", { threadId: "never" })).rejects.toMatchObject({ code: -32001 });
  });

  it("bounds initialize by startTimeoutMs, not requestTimeoutMs", async () => {
    const client = stubClient({ STUB_INIT_DELAY_MS: "300" }, { requestTimeoutMs: 50 });
    await expect(client.start()).resolves.toMatchObject({ userAgent: "fake/1.0" });
  });

  it("rejects start() with AppServerStartError when initialize outlasts startTimeoutMs", async () => {
    const client = stubClient({ STUB_INIT_DELAY_MS: "5000" }, { startTimeoutMs: 100 });
    const error = await client.start().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppServerStartError);
    expect(error).toMatchObject({ message: "omo app-server did not initialize within 100 ms" });
  });

  it("rejects start() with AppServerStartError when the initialize result is malformed", async () => {
    const client = stubClient({ STUB_BAD_INIT: "1" });
    const error = await client.start().then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppServerStartError);
    expect(error).toMatchObject({ message: "omo app-server initialize failed: omo app-server returned a malformed initialize result" });
    expect(client.initializeResult).toBeNull();
  });

  it("rejects start() when the child exits before initializing", async () => {
    const client = new AppServerClient({
      command: process.execPath,
      args: [CRASH, "app-server", "--listen", "stdio://"],
      cwd: __dirname,
      env: { PATH: "/usr/bin:/bin" },
      clientVersion: "0.0.0-test",
    });
    clients.push(client);
    const malformed: string[] = [];
    client.onMalformed((line) => malformed.push(line));
    const error = await client.start().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppServerStartError);
    expect(error).toMatchObject({ exitCode: 3 });
    if (!(error instanceof AppServerStartError)) return;
    expect(error.stderrTail).toContain("omo-crash: fatal startup error");
    expect(error.message).toContain("3");
    expect(error.message).toContain("omo-crash: fatal startup error");
    expect(malformed).toEqual(["this is not json"]);
  });

  it("rejects start() when the command cannot be spawned", async () => {
    const client = stubClient({}, { command: path.join(__dirname, "does-not-exist") });
    await expect(client.start()).rejects.toBeInstanceOf(AppServerStartError);
  });

  it("stop() escalates to SIGTERM when the child ignores stdin end", async () => {
    const client = stubClient({ STUB_IGNORE_STDIN: "1" }, { stopTimeoutsMs: { afterStdinEnd: 100, afterSigterm: 5_000 } });
    await client.start();
    const exit = nextEvent<ExitInfo>((listener) => client.onExit(listener));
    await client.stop();
    const info = await exit;
    expect(info).toMatchObject({ signal: "SIGTERM", expected: true });
    await client.stop();
  });

  it("stop() escalates to SIGKILL when the child also ignores SIGTERM", async () => {
    const client = stubClient(
      { STUB_IGNORE_STDIN: "1", STUB_IGNORE_SIGTERM: "1" },
      { stopTimeoutsMs: { afterStdinEnd: 50, afterSigterm: 100 } },
    );
    await client.start();
    const exit = nextEvent<ExitInfo>((listener) => client.onExit(listener));
    await client.stop();
    await expect(exit).resolves.toMatchObject({ signal: process.platform === "win32" ? "SIGTERM" : "SIGKILL", expected: true });
  });

  it("stop() closes stdin and lets a cooperative child exit cleanly", async () => {
    const client = stubClient();
    await client.start();
    const exit = nextEvent<ExitInfo>((listener) => client.onExit(listener));
    await client.stop();
    await expect(exit).resolves.toMatchObject({ code: 0, expected: true });
    await expect(client.request("model/list", {})).rejects.toMatchObject({ code: -32000 });
  });
});
