import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeStatus } from "../../shared/ipc";
import { RpcRequestError } from "../../electron/omo/app-server-client";
import type { ExitInfo, InitializeResult } from "../../electron/omo/app-server-client";
import { OmoSupervisor } from "../../electron/omo/supervisor";
import type { SupervisedClient } from "../../electron/omo/supervisor";

const CRASH = path.join(__dirname, "..", "fixtures", process.platform === "win32" ? "omo-crash.mjs" : "omo-crash.sh");
const loginEnv = async () => ({ env: { PATH: "/usr/bin:/bin" }, fromLoginShell: false });

function waitForStatus(supervisor: OmoSupervisor, predicate: (status: BridgeStatus) => boolean, timeoutMs = 10_000): Promise<BridgeStatus> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`timed out; last status ${JSON.stringify(supervisor.getStatus())}`));
    }, timeoutMs);
    const off = supervisor.onStatus((status) => {
      if (!predicate(status)) return;
      clearTimeout(timer);
      off();
      resolve(status);
    });
  });
}

class FakeClient implements SupervisedClient {
  readonly pid = 4242;
  initializeResult: InitializeResult | null = null;
  private exitListener: ((info: ExitInfo) => void) | null = null;
  constructor(private readonly startResult: InitializeResult | Error) {}
  async start(): Promise<InitializeResult> {
    if (this.startResult instanceof Error) throw this.startResult;
    this.initializeResult = this.startResult;
    return this.startResult;
  }
  async stop(): Promise<void> {}
  request = (): Promise<never> => Promise.reject(new Error("unused"));
  respond(): void {}
  onNotification(): () => void {
    return () => undefined;
  }
  onServerRequest(): () => void {
    return () => undefined;
  }
  private malformedListener: ((line: string, error: Error) => void) | null = null;
  onMalformed(listener: (line: string, error: Error) => void): () => void {
    this.malformedListener = listener;
    return () => undefined;
  }
  emitMalformed(line: string): void {
    let parseError = new Error("unreachable");
    try {
      JSON.parse(line);
    } catch (error) {
      if (error instanceof Error) parseError = error;
    }
    this.malformedListener?.(line, parseError);
  }
  onExit(listener: (info: ExitInfo) => void): () => void {
    this.exitListener = listener;
    return () => undefined;
  }
  crash(code: number): void {
    this.exitListener?.({ code, signal: null, stderrTail: "fake crash", expected: false });
  }
}

const INIT: InitializeResult = { userAgent: "omo/test", codexHome: "/tmp/codex", platformFamily: "unix", platformOs: "macos" };
const binary = { path: "/fake/omo", version: "9.9.9", source: "override" as const };

afterEach(() => {
  vi.useRealTimers();
});

describe("OmoSupervisor", () => {
  it("reports not-found with what was tried when the override is missing", async () => {
    const supervisor = new OmoSupervisor({
      homeDir: "/nonexistent-home",
      baseEnv: { OMO_UI_OMO_BIN: "/nonexistent/omo" },
      clientVersion: "0.0.0-test",
      resolveEnv: loginEnv,
    });
    await supervisor.start();
    const status = supervisor.getStatus();
    expect(status.state).toBe("not-found");
    expect(status.message).toContain("/nonexistent/omo");
    await expect(supervisor.request("model/list", {})).rejects.toMatchObject({ code: -32000 });
  });

  it("restarts a crashing omo after each delay and gives up when the delays run out", async () => {
    const supervisor = new OmoSupervisor({
      homeDir: __dirname,
      baseEnv: { OMO_UI_OMO_BIN: CRASH },
      clientVersion: "0.0.0-test",
      restartDelaysMs: [1, 1],
      resolveEnv: loginEnv,
    });
    const seen: Array<[BridgeStatus["state"], number]> = [];
    supervisor.onStatus((status) => seen.push([status.state, status.restartAttempt]));
    const finalExit = waitForStatus(supervisor, (status) => status.state === "exited" && status.restartAttempt === 2);
    await supervisor.start();
    const status = await finalExit;
    expect(status.exitCode).toBe(3);
    expect(status.stderrTail).toContain("omo-crash: fatal startup error");
    expect(status.omo).toMatchObject({ path: CRASH, version: "0.0.0-crash", source: "override" });
    expect(seen.map(([state]) => state)).toEqual([
      "locating", "starting", "exited", "restarting",
      "starting", "exited", "restarting",
      "starting", "exited", "exited",
    ]);
    expect(seen.at(-1)).toEqual(["exited", 2]);
    await supervisor.stop();
  });

  it("connects, then schedules a restart after an unexpected exit", async () => {
    const clients: FakeClient[] = [];
    const supervisor = new OmoSupervisor({
      homeDir: "/h",
      baseEnv: {},
      clientVersion: "0.0.0-test",
      restartDelaysMs: [1],
      resolveEnv: loginEnv,
      locate: async () => ({ ok: true, binary }),
      createClient: () => {
        const client = new FakeClient(INIT);
        clients.push(client);
        return client;
      },
    });
    await supervisor.start();
    expect(supervisor.getStatus()).toMatchObject({ state: "connected", userAgent: "omo/test", restartAttempt: 0 });
    expect(supervisor.diagnostics()).toEqual({ omo: binary, childPid: 4242, childPath: "/usr/bin:/bin", loginShellEnv: false });
    const reconnected = waitForStatus(supervisor, (status) => status.state === "connected");
    clients[0]?.crash(9);
    expect(supervisor.getStatus()).toMatchObject({ state: "restarting", exitCode: 9, restartAttempt: 1 });
    await reconnected;
    expect(clients).toHaveLength(2);
    expect(supervisor.getStatus().restartAttempt).toBe(0);
    await supervisor.stop();
  });

  it("logs a malformed app-server line by its length, never its text", async () => {
    const client = new FakeClient(INIT);
    const supervisor = new OmoSupervisor({
      homeDir: "/h",
      baseEnv: {},
      clientVersion: "0.0.0-test",
      resolveEnv: loginEnv,
      locate: async () => ({ ok: true, binary }),
      createClient: () => client,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await supervisor.start();
      client.emitMalformed("secret prompt text {");
      expect(warn.mock.calls).toEqual([["[omo-ui] ignored a malformed line from omo app-server (20 characters, SyntaxError)"]]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    } finally {
      warn.mockRestore();
      await supervisor.stop();
    }
  });

  it("stop() cancels a scheduled restart", async () => {
    vi.useFakeTimers();
    const createClient = vi.fn(() => new FakeClient(new Error("spawn failed")));
    const supervisor = new OmoSupervisor({
      homeDir: "/h",
      baseEnv: {},
      clientVersion: "0.0.0-test",
      restartDelaysMs: [1_000],
      resolveEnv: loginEnv,
      locate: async () => ({ ok: true, binary }),
      createClient,
    });
    await supervisor.start();
    expect(supervisor.getStatus()).toMatchObject({ state: "restarting", restartAttempt: 1 });
    await supervisor.stop();
    await vi.runAllTimersAsync();
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(supervisor.getStatus().state).toBe("stopped");
    await expect(supervisor.respond(1, {})).rejects.toBeInstanceOf(RpcRequestError);
  });
});
