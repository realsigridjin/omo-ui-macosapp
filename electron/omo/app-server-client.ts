import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import type {
  ClientMethod,
  ClientParams,
  ClientResult,
  RequestId,
  RpcNotification,
  RpcServerRequest,
} from "../../shared/protocol";
import { JsonlDecoder } from "./jsonl";
import { ManagedChild } from "./managed-child";
import type { ExitInfo, StopTimeouts } from "./managed-child";
import { AppServerStartError, assertNever, BRIDGE_ERROR_CODES, classify, describeExit, RpcRequestError } from "./rpc";

export { AppServerStartError, BRIDGE_ERROR_CODES, RpcRequestError } from "./rpc";
export type { ExitInfo } from "./managed-child";

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export type InitializeResult = ClientResult<"initialize">;

const isOptionalString = (value: unknown): boolean => value === undefined || typeof value === "string";

/** Validates the initialize result at the process boundary; the bridge status and history:load read these fields. */
export function isInitializeResult(value: unknown): value is InitializeResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const fields: Record<string, unknown> = { ...value };
  return (
    typeof fields["userAgent"] === "string" &&
    isOptionalString(fields["codexHome"]) &&
    isOptionalString(fields["platformFamily"]) &&
    isOptionalString(fields["platformOs"])
  );
}

export interface AppServerClientOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  clientVersion: string;
  requestTimeoutMs?: number;
  startTimeoutMs?: number;
  /** Grace periods of stop(): wait after closing stdin, then after SIGTERM, before SIGKILL. */
  stopTimeoutsMs?: StopTimeouts;
  spawnImpl?: SpawnImpl;
}

type Listener<T> = (value: T) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_STOP_TIMEOUTS: StopTimeouts = { afterStdinEnd: 2_000, afterSigterm: 3_000 };

/** JSON-RPC client for one `omo app-server --listen stdio://` child process. */
export class AppServerClient {
  private child: ManagedChild | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private initResult: InitializeResult | null = null;
  private readonly notificationListeners = new Set<Listener<RpcNotification>>();
  private readonly serverRequestListeners = new Set<Listener<RpcServerRequest>>();
  private readonly malformedListeners = new Set<(line: string, error: Error) => void>();
  private readonly exitListeners = new Set<Listener<ExitInfo>>();

  constructor(private readonly options: AppServerClientOptions) {}

  get pid(): number | null {
    return this.child?.process.pid ?? null;
  }

  get initializeResult(): InitializeResult | null {
    return this.initResult;
  }

  /** Spawns the child and performs initialize + initialized; rejects with AppServerStartError. */
  async start(): Promise<InitializeResult> {
    if (this.child) throw new Error("AppServerClient.start() may only be called once");
    const child = this.spawnChild();
    const startTimeoutMs = this.options.startTimeoutMs ?? 20_000;
    try {
      // initialize is bounded by startTimeoutMs, not requestTimeoutMs.
      const result = await this.send(
        "initialize",
        {
          clientInfo: { name: "omo-ui", title: "OmO UI", version: this.options.clientVersion },
          capabilities: { experimentalApi: true },
        },
        startTimeoutMs,
      );
      if (!isInitializeResult(result)) throw new Error("omo app-server returned a malformed initialize result");
      this.write({ method: "initialized" });
      this.initResult = result;
      return result;
    } catch (error) {
      if (child.hasExited) {
        const info = await child.exited;
        const spawnError = child.spawnError;
        const reason = spawnError ? `failed to spawn (${spawnError.message})` : `exited with ${describeExit(info.code, info.signal)}`;
        const tail = info.stderrTail.trim();
        const message = `omo app-server ${reason} before initializing${tail ? `: ${tail}` : ""}`;
        throw new AppServerStartError(message, info.code, info.signal, info.stderrTail);
      }
      await this.stop();
      if (error instanceof RpcRequestError && error.code === BRIDGE_ERROR_CODES.timeout) {
        throw new AppServerStartError(`omo app-server did not initialize within ${startTimeoutMs} ms`, null, null, child.stderrTail);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new AppServerStartError(`omo app-server initialize failed: ${message}`, null, null, child.stderrTail);
    }
  }

  request<M extends ClientMethod>(method: M, params: ClientParams<M>): Promise<ClientResult<M>> {
    // Results are relayed to the renderer as ClientRequestMap declares; src/state validates the fields it consumes
    // (src/state/wire.ts) before they reach the store.
    return this.send(method, params, this.options.requestTimeoutMs ?? 60_000).then((result) => result as ClientResult<M>);
  }

  /** Answers a server request with {id, result}. */
  respond(id: RequestId, result: unknown): void {
    this.write({ id, result });
  }

  onNotification(listener: Listener<RpcNotification>): () => void {
    return subscribe(this.notificationListeners, listener);
  }

  onServerRequest(listener: Listener<RpcServerRequest>): () => void {
    return subscribe(this.serverRequestListeners, listener);
  }

  onMalformed(listener: (line: string, error: Error) => void): () => void {
    return subscribe(this.malformedListeners, listener);
  }

  onExit(listener: Listener<ExitInfo>): () => void {
    return subscribe(this.exitListeners, listener);
  }

  /** Closes stdin, then escalates to SIGTERM and SIGKILL; resolves once the child has exited. Idempotent. */
  stop(): Promise<void> {
    return this.child?.stop(this.options.stopTimeoutsMs ?? DEFAULT_STOP_TIMEOUTS) ?? Promise.resolve();
  }

  private spawnChild(): ManagedChild {
    const spawnImpl = this.options.spawnImpl ?? spawn;
    const nodeScript = process.platform === "win32" && /\.mjs$/i.test(this.options.command);
    const childProcess = spawnImpl(nodeScript ? process.execPath : this.options.command,
      nodeScript ? [this.options.command, ...this.options.args] : this.options.args, {
      cwd: this.options.cwd,
      env: nodeScript ? { ...this.options.env, ELECTRON_RUN_AS_NODE: "1" } : this.options.env,
      stdio: "pipe",
      windowsHide: true,
    });
    const child = new ManagedChild(childProcess, (code, signal) => {
      this.rejectPending(new RpcRequestError(BRIDGE_ERROR_CODES.notConnected, `omo app-server exited with ${describeExit(code, signal)}`));
    });
    this.child = child;
    const decoder = new JsonlDecoder({
      onFrame: (value) => this.handleFrame(value),
      onMalformed: (line, error) => this.emitMalformed(line, error),
    });
    childProcess.stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
    childProcess.stdout.on("end", () => decoder.end());
    void child.exited.then((info) => {
      for (const listener of [...this.exitListeners]) listener(info);
    });
    return child;
  }

  private send(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcRequestError(BRIDGE_ERROR_CODES.timeout, `${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(frame: object): void {
    const child = this.child;
    if (!child || child.hasExited || !child.process.stdin.writable) {
      throw new RpcRequestError(BRIDGE_ERROR_CODES.notConnected, "omo app-server is not running");
    }
    child.process.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private handleFrame(value: unknown): void {
    const frame = classify(value);
    if (!frame) {
      this.emitMalformed(JSON.stringify(value), new Error("unrecognized JSON-RPC frame"));
      return;
    }
    switch (frame.kind) {
      case "request":
        for (const listener of [...this.serverRequestListeners]) listener(frame.request);
        return;
      case "notification":
        for (const listener of [...this.notificationListeners]) listener(frame.notification);
        return;
      case "response":
      case "error": {
        const pending = typeof frame.id === "number" ? this.pending.get(frame.id) : undefined;
        if (!pending) {
          this.emitMalformed(JSON.stringify(value), new Error(`response for unknown request id ${String(frame.id)}`));
          return;
        }
        this.pending.delete(Number(frame.id));
        clearTimeout(pending.timer);
        if (frame.kind === "response") pending.resolve(frame.result);
        else pending.reject(new RpcRequestError(frame.code, frame.message, frame.data));
        return;
      }
      default:
        assertNever(frame);
    }
  }

  private emitMalformed(line: string, error: Error): void {
    for (const listener of [...this.malformedListeners]) listener(line, error);
  }
}

function subscribe<T>(set: Set<T>, listener: T): () => void {
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}
