import { ENV, getOmoInstallCommand } from "../../shared/ipc";
import type { BridgeStatus, Diagnostics, OmoBinary } from "../../shared/ipc";
import type { ClientMethod, ClientParams, ClientResult, RequestId, RpcNotification, RpcServerRequest } from "../../shared/protocol";
import { AppServerClient, AppServerStartError, BRIDGE_ERROR_CODES, RpcRequestError } from "./app-server-client";
import type { AppServerClientOptions, ExitInfo, InitializeResult } from "./app-server-client";
import { locateOmo } from "./locate";
import type { LocateOptions, LocateResult } from "./locate";
import { resolveLoginShellEnv, scrubChildEnv } from "./shell-env";
import type { LoginShellEnv, ResolveLoginShellEnvOptions } from "./shell-env";
import { autoUpdateOmo } from "./updater";
import type { AutoUpdateOptions } from "./updater";

/** The AppServerClient surface the supervisor uses; tests inject fakes through createClient. */
export type SupervisedClient = Pick<
  AppServerClient,
  "start" | "stop" | "request" | "respond" | "onNotification" | "onServerRequest" | "onMalformed" | "onExit" | "pid" | "initializeResult"
>;

export interface OmoSupervisorOptions {
  homeDir: string;
  baseEnv: Record<string, string | undefined>;
  clientVersion: string;
  restartDelaysMs?: readonly number[];
  locate?: (options: LocateOptions) => Promise<LocateResult>;
  resolveEnv?: (options: ResolveLoginShellEnvOptions) => Promise<LoginShellEnv>;
  createClient?: (options: AppServerClientOptions) => SupervisedClient;
  /** When supplied, updates once per app lifetime before the first app-server launch. */
  autoUpdate?: AutoUpdateOptions;
}

export type SupervisorDiagnostics = Pick<Diagnostics, "omo" | "childPid" | "childPath" | "loginShellEnv">;

const DEFAULT_RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000];

function describeExit(code: number | null, signal: string | null): string {
  if (code !== null) return `omo exited with code ${code}`;
  if (signal !== null) return `omo was killed by ${signal}`;
  return "omo exited";
}

/** Owns one omo app-server child at a time, publishes BridgeStatus, and restarts the child after crashes. */
export class OmoSupervisor {
  private status: BridgeStatus = {
    state: "locating",
    omo: null,
    userAgent: null,
    message: null,
    stderrTail: null,
    exitCode: null,
    restartAttempt: 0,
    installCommand: getOmoInstallCommand(process.platform),
  };
  private client: SupervisedClient | null = null;
  private loginEnv: LoginShellEnv | null = null;
  private childPath: string | null = null;
  private generation = 0;
  private stopped = false;
  private readonly updateAbort = new AbortController();
  private updatePromise: Promise<OmoBinary> | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly statusListeners = new Set<(status: BridgeStatus) => void>();
  private readonly notificationListeners = new Set<(notification: RpcNotification) => void>();
  private readonly serverRequestListeners = new Set<(request: RpcServerRequest) => void>();

  constructor(private readonly options: OmoSupervisorOptions) {}

  getStatus(): BridgeStatus {
    return this.status;
  }

  get initializeResult(): InitializeResult | null {
    return this.status.state === "connected" ? (this.client?.initializeResult ?? null) : null;
  }

  /** Locates omo and connects; failures are reported through status, never thrown. */
  async start(): Promise<void> {
    this.stopped = false;
    this.cancelRestart();
    const generation = ++this.generation;
    this.setStatus({ state: "locating", message: null, restartAttempt: 0 });
    await this.connect(generation);
  }

  /** Stops the current child, re-resolves the login environment, and connects with a fresh attempt counter. */
  async restart(): Promise<void> {
    this.stopped = false;
    this.cancelRestart();
    const generation = ++this.generation;
    const previous = this.client;
    this.client = null;
    this.setStatus({ state: "locating", message: null, restartAttempt: 0, userAgent: null });
    await previous?.stop();
    if (generation !== this.generation) return;
    this.loginEnv = null;
    await this.connect(generation);
  }

  /** Stops the child for good; later exits never schedule restarts. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.updateAbort.abort();
    this.generation++;
    this.cancelRestart();
    const client = this.client;
    this.client = null;
    this.setStatus({ state: "stopped", userAgent: null, message: null });
    await client?.stop();
  }

  request<M extends ClientMethod>(method: M, params: ClientParams<M>): Promise<ClientResult<M>> {
    const client = this.connectedClient();
    if (!client) return Promise.reject(new RpcRequestError(BRIDGE_ERROR_CODES.notConnected, "omo is not connected"));
    return client.request(method, params);
  }

  async respond(id: RequestId, result: unknown): Promise<void> {
    const client = this.connectedClient();
    if (!client) throw new RpcRequestError(BRIDGE_ERROR_CODES.notConnected, "omo is not connected");
    client.respond(id, result);
  }

  /** The cached login-shell environment, resolving it on first use. */
  async getLoginEnv(): Promise<Record<string, string>> {
    return (await this.ensureLoginEnv()).env;
  }

  onStatus(listener: (status: BridgeStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onNotification(listener: (notification: RpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  onServerRequest(listener: (request: RpcServerRequest) => void): () => void {
    this.serverRequestListeners.add(listener);
    return () => {
      this.serverRequestListeners.delete(listener);
    };
  }

  diagnostics(): SupervisorDiagnostics {
    return {
      omo: this.status.omo,
      childPid: this.client?.pid ?? null,
      childPath: this.childPath,
      loginShellEnv: this.loginEnv?.fromLoginShell ?? false,
    };
  }

  private connectedClient(): SupervisedClient | null {
    return this.status.state === "connected" ? this.client : null;
  }

  private async ensureLoginEnv(): Promise<LoginShellEnv> {
    if (!this.loginEnv) {
      const resolveEnv = this.options.resolveEnv ?? resolveLoginShellEnv;
      this.loginEnv = await resolveEnv({ baseEnv: this.options.baseEnv, homeDir: this.options.homeDir });
    }
    return this.loginEnv;
  }

  private async connect(generation: number): Promise<void> {
    const login = await this.ensureLoginEnv();
    if (generation !== this.generation) return;
    const locate = this.options.locate ?? locateOmo;
    const override = this.options.baseEnv[ENV.omoBin] ?? login.env[ENV.omoBin];
    const located = await locate({
      env: { ...login.env, [ENV.omoBin]: override },
      homeDir: this.options.homeDir,
      loginPath: login.env["PATH"] ?? null,
    });
    if (generation !== this.generation) return;
    if (!located.ok) {
      const tried = located.tried.map((entry) => `${entry.source} ${entry.path}: ${entry.problem}`).join("; ");
      this.setStatus({ state: "not-found", omo: null, userAgent: null, message: `omo was not found. Tried: ${tried || "nothing"}` });
      return;
    }
    let binary = located.binary;
    if (this.options.autoUpdate && !this.updateAbort.signal.aborted) {
      this.updatePromise ??= autoUpdateOmo(binary, scrubChildEnv(login.env), this.options.autoUpdate, this.updateAbort.signal,
        (update) => { if (!this.stopped) this.setStatus({ update }); });
      const updated = await this.updatePromise;
      // An explicit restart may locate a different override; do not substitute the old path.
      if (updated.path === binary.path && this.status.update?.state === "updated" && binary.version === this.status.update.from) binary = updated;
    }
    if (generation !== this.generation) return;
    await this.launch(generation, binary, login);
  }

  private async launch(generation: number, binary: OmoBinary, login: LoginShellEnv): Promise<void> {
    const env = scrubChildEnv(login.env);
    this.childPath = env["PATH"] ?? null;
    const createClient = this.options.createClient ?? ((options: AppServerClientOptions) => new AppServerClient(options));
    const client = createClient({
      command: binary.path,
      args: ["app-server", "--listen", "stdio://"],
      cwd: this.options.homeDir,
      env,
      clientVersion: this.options.clientVersion,
    });
    this.client = client;
    this.setStatus({ state: "starting", omo: binary, userAgent: null });
    client.onNotification((notification) => {
      if (this.client === client) for (const listener of [...this.notificationListeners]) listener(notification);
    });
    client.onServerRequest((request) => {
      if (this.client === client) for (const listener of [...this.serverRequestListeners]) listener(request);
    });
    // Neither the line nor the parse error is logged: JSON parse errors quote the input, which may carry conversation text.
    client.onMalformed((line, error) => {
      if (this.client === client) console.warn(`[omo-ui] ignored a malformed line from omo app-server (${line.length} characters, ${error.name})`);
    });
    client.onExit((info) => {
      if (this.client === client && this.status.state === "connected" && !info.expected) this.handleExit(info);
    });

    let result: InitializeResult;
    try {
      result = await client.start();
    } catch (error) {
      if (generation !== this.generation || this.client !== client) return;
      const startError = error instanceof AppServerStartError ? error : null;
      this.handleExit({
        code: startError?.exitCode ?? null,
        signal: startError?.signal ?? null,
        stderrTail: startError?.stderrTail ?? "",
        expected: false,
        message: `omo failed to start: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    if (generation !== this.generation || this.client !== client) {
      await client.stop();
      return;
    }
    this.setStatus({
      state: "connected",
      userAgent: result.userAgent,
      message: null,
      stderrTail: null,
      exitCode: null,
      restartAttempt: 0,
    });
  }

  private handleExit(info: ExitInfo & { message?: string }): void {
    if (this.stopped) return;
    this.client = null;
    const message = info.message ?? describeExit(info.code, info.signal);
    this.setStatus({
      state: "exited",
      userAgent: null,
      exitCode: info.code,
      stderrTail: info.stderrTail,
      message,
    });
    const delays = this.options.restartDelaysMs ?? DEFAULT_RESTART_DELAYS_MS;
    const attempt = this.status.restartAttempt;
    const delay = delays[attempt];
    if (delay === undefined) {
      this.setStatus({ message: `${message}; gave up after ${attempt} restart attempts` });
      return;
    }
    const generation = this.generation;
    this.setStatus({
      state: "restarting",
      restartAttempt: attempt + 1,
      message: `${message}; restarting in ${Math.ceil(delay / 1000)} s (attempt ${attempt + 1} of ${delays.length})`,
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (generation === this.generation && !this.stopped) void this.connect(generation);
    }, delay);
  }

  private cancelRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  private setStatus(patch: Partial<BridgeStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of [...this.statusListeners]) listener(this.status);
  }
}
