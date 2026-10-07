import { describe, expect, it, vi } from "vitest";
import { OMO_INSTALL_COMMAND } from "../../shared/ipc";
import type { AccountUsage, BranchPoint, BranchResult, BridgeStatus, HistoryResult, HistoryTurn, OmoBridgeApi, OpenTarget, OpenTargetId, Preferences } from "../../shared/ipc";
import type {
  ClientMethod,
  ClientParams,
  ClientResult,
  Model,
  RequestId,
  RpcNotification,
  RpcServerRequest,
  SkillsListResponse,
  Turn,
} from "../../shared/protocol";
import {
  SIDE_BACKGROUND_MARKER,
  createActions,
  createAppStore,
  memorySideStorage,
  parseStoredSides,
  selectPanelNotices,
  selectSkillCatalog,
  selectThreadsByWorkspace,
  selectToastNotice,
  sideDraftKey,
} from "../../src/state";
import type { SideStorage } from "../../src/state";
import type { AppState, AppStore } from "../../src/state";
import { projectTitleText } from "../../src/ui/conversation/skill-text";
import { makeThread, notification } from "./helpers";

type Handlers = { [M in ClientMethod]?: (params: ClientParams<M>) => ClientResult<M> | Promise<ClientResult<M>> };

const THREAD_ID = "thread-1";
const SESSION_PATH = "/Users/me/.omo/agent/sessions/thread-1.jsonl";
const BRANCH_ID = "thread-branch";
const BRANCH_PATH = "/Users/me/.omo/agent/sessions/thread-branch.jsonl";

const model: Model = {
  id: "anthropic/claude-fable-5",
  model: "claude-fable-5",
  displayName: "Claude Fable 5",
  description: "",
  hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }],
  defaultReasoningEffort: "medium",
  isDefault: true,
};

const runningTurn: Turn = { id: "turn-9", items: [], status: "inProgress", error: null };

function bridgeStatus(state: BridgeStatus["state"]): BridgeStatus {
  return {
    state,
    omo: null,
    userAgent: null,
    message: null,
    stderrTail: null,
    exitCode: null,
    restartAttempt: 0,
    installCommand: OMO_INSTALL_COMMAND,
  };
}

class FakeBridge implements OmoBridgeApi {
  readModelRouting(): ReturnType<OmoBridgeApi["readModelRouting"]> { return Promise.resolve({ configPath: "", categories: [], agents: [], mappings: [] }); }
  saveModelRouting(input: Parameters<OmoBridgeApi["saveModelRouting"]>[0]): ReturnType<OmoBridgeApi["saveModelRouting"]> { return Promise.resolve({ configPath: "", ...input }); }
  importExistingMcpConfigs(): ReturnType<OmoBridgeApi["importExistingMcpConfigs"]> { return Promise.resolve({ imported: [], sources: 0 }); }
  readConfiguredMcpServers(): ReturnType<OmoBridgeApi["readConfiguredMcpServers"]> { return Promise.resolve([]); }
  getAppUpdateStatus(): ReturnType<OmoBridgeApi["getAppUpdateStatus"]> { return Promise.resolve({ state: "idle", currentVersion: "0.1.4-win.1", latestVersion: null, progress: null, message: null }); }
  checkAppUpdate(): ReturnType<OmoBridgeApi["checkAppUpdate"]> { return this.getAppUpdateStatus(); }
  installAppUpdate(): ReturnType<OmoBridgeApi["installAppUpdate"]> { return this.getAppUpdateStatus(); }
  onAppUpdateStatus(): () => void { return () => {}; }
  getDeviceOverview(): ReturnType<OmoBridgeApi["getDeviceOverview"]> { return Promise.resolve({ hostname: "test", platform: "win32", appVersion: "0.1.3", omoVersion: null, memory: { path: null, branch: null, lastCommitAt: null, changedFiles: 0, remoteConfigured: false, state: "unavailable" } }); }
  listWorkspaceFiles(): ReturnType<OmoBridgeApi["listWorkspaceFiles"]> { return Promise.resolve([]); }
  readWorkspaceFile(): ReturnType<OmoBridgeApi["readWorkspaceFile"]> { return Promise.resolve({ path: "", text: "", language: "text" }); }
  getWorkspaceDiff(): ReturnType<OmoBridgeApi["getWorkspaceDiff"]> { return Promise.resolve(""); }
  importMcpConfig(): ReturnType<OmoBridgeApi["importMcpConfig"]> { return Promise.resolve(null); }
  readOpencodexAccounts(): ReturnType<OmoBridgeApi["readOpencodexAccounts"]> { return Promise.resolve({ baseUrl: "", accounts: [], error: null }); }
  getAndroidStatus(): ReturnType<OmoBridgeApi["getAndroidStatus"]> { return Promise.resolve({ adbAvailable: false, state: "disabled", devices: [], selectedSerial: null, url: null, message: null }); }
  refreshAndroid(): ReturnType<OmoBridgeApi["refreshAndroid"]> { return this.getAndroidStatus(); }
  connectAndroid(): ReturnType<OmoBridgeApi["connectAndroid"]> { return this.getAndroidStatus(); }
  disconnectAndroid(): ReturnType<OmoBridgeApi["disconnectAndroid"]> { return this.getAndroidStatus(); }
  onAndroidStatus(): () => void { return () => {}; }
  getProxySettings(): ReturnType<OmoBridgeApi["getProxySettings"]> { return Promise.resolve({ baseUrl: "", apiKeyConfigured: false, modelCount: 0 }); }
  applyProxySettings(): ReturnType<OmoBridgeApi["applyProxySettings"]> { return Promise.resolve({ baseUrl: "", apiKeyConfigured: false, modelCount: 0 }); }
  loadTaskWork(): ReturnType<OmoBridgeApi["loadTaskWork"]> { return Promise.resolve([]); }
  getIphoneStatus(): ReturnType<OmoBridgeApi["getIphoneStatus"]> { return Promise.resolve({ enabled: false, state: "searching", devices: [] }); }
  onIphoneStatus(): () => void { return () => {}; }
  readonly platform = "darwin";
  readonly calls: Array<{ method: ClientMethod; params: unknown }> = [];
  readonly responses: Array<{ id: RequestId; result: unknown }> = [];
  readonly historyLoads: string[] = [];
  history: () => Promise<HistoryResult> = () => Promise.resolve({ turns: [], todo: null, tasks: [] });
  goal: () => Promise<ClientResult<"thread/goal/get">> = async () => ({ goal: null });
  private readonly notificationListeners = new Set<(notification: RpcNotification) => void>();
  readonly failing = new Set<ClientMethod>();
  skills: (cwds: string[]) => Promise<SkillsListResponse> = async (cwds) => ({
    data: cwds.map((cwd) => ({ cwd, skills: [{
      name: "ulw-loop", description: "Loop", path: "/skills/ulw-loop/SKILL.md", scope: "system", enabled: true,
    }], errors: [] })),
  });
  threadList: () => unknown = () => ({ data: [makeThread(THREAD_ID, { path: SESSION_PATH })], nextCursor: null });
  started: (cwd: string) => unknown = (cwd) => ({
    thread: makeThread(THREAD_ID, { cwd }), model: "claude-fable-5", modelProvider: "anthropic", cwd, reasoningEffort: null,
  });
  mcp: (params: ClientParams<"mcpServerStatus/list">) => unknown = () => ({ data: [], nextCursor: null });
  status = bridgeStatus("starting");
  preferences: Preferences = { theme: "system", locale: "system", lastWorkspace: null, recentWorkspaces: [], modelId: null };
  private readonly statusListeners = new Set<(status: BridgeStatus) => void>();
  private readonly handlers: Handlers = {
    "mcpServerStatus/list": (params) => this.mcp(params) as ClientResult<"mcpServerStatus/list">,
    "thread/goal/get": () => this.goal(),
    "model/list": () => ({ data: [model], nextCursor: null }),
    // Results cross a process boundary; the overrides let tests return malformed payloads.
    "thread/list": () => this.threadList() as ClientResult<"thread/list">,
    "thread/start": ({ cwd }) => this.started(cwd) as ClientResult<"thread/start">,
    "skills/list": ({ cwds }) => this.skills(cwds ?? []),
    "thread/resume": ({ threadId }) => ({
      thread: makeThread(threadId, { path: SESSION_PATH }),
      model: "claude-fable-5",
      modelProvider: "anthropic",
      cwd: "/tmp/work/project",
      reasoningEffort: null,
    }),
    "turn/start": () => ({ turn: runningTurn }),
    "turn/steer": () => ({}),
    "turn/interrupt": () => ({}),
    "thread/name/set": () => ({}),
    "thread/delete": () => ({}),
    "thread/read": ({ threadId }) => ({ thread: makeThread(threadId) }),
    "account/providerAccounts/read": ({ provider }) => ({
      provider, accounts: provider === "anthropic-subscription" ? [{ name: "work", source: "login", blocked: false, pinned: true }] : [],
    }),
    "account/providerAccounts/pin": () => ({}),
    "account/providerAccounts/remove": () => ({}),
  };

  async request<M extends ClientMethod>(method: M, params: ClientParams<M>): Promise<ClientResult<M>> {
    this.calls.push({ method, params });
    if (this.failing.has(method)) throw new Error(`-32000: ${method} failed`);
    const handler = this.handlers[method];
    if (handler === undefined) throw new Error(`-32601: unhandled ${method}`);
    return handler(params);
  }

  emitStatus(status: BridgeStatus): void {
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }

  methods(): ClientMethod[] {
    return this.calls.map((call) => call.method);
  }

  async getStatus(): Promise<BridgeStatus> {
    return this.status;
  }
  onStatus(listener: (status: BridgeStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
  onNotification(listener: (notification: RpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }
  emitNotification(method: string, params: unknown): void {
    for (const listener of this.notificationListeners) listener({ method, params });
  }
  onServerRequest(_listener: (request: RpcServerRequest) => void): () => void {
    return () => undefined;
  }
  async respond(id: RequestId, result: unknown): Promise<void> {
    this.responses.push({ id, result });
  }
  async restart(): Promise<void> {}
  async install(): Promise<{ ok: boolean; exitCode: number | null }> {
    return { ok: true, exitCode: 0 };
  }
  onInstallLog(): () => void {
    return () => undefined;
  }
  loadHistory(sessionPath: string): Promise<HistoryResult> {
    this.historyLoads.push(sessionPath);
    return this.history();
  }
  usageRows: () => Promise<AccountUsage[]> = async () => [];
  readonly logins: string[] = [];
  readAccountUsage(): Promise<AccountUsage[]> { return this.usageRows(); }
  async openAccountLogin(provider: string): Promise<void> { this.logins.push(provider); }
  readonly branches: Array<{ sessionPath: string; point: BranchPoint }> = [];
  async branchSession(sessionPath: string, point: BranchPoint): Promise<BranchResult> {
    this.branches.push({ sessionPath, point });
    return { threadId: BRANCH_ID, path: BRANCH_PATH };
  }
  async pickDirectory(): Promise<string | null> {
    return null;
  }
  async pickImages(): Promise<string[]> { return []; }
  imageFilePath(): string { return ""; }
  async saveImage(): Promise<string> { return "/tmp/saved.png"; }
  async getDiagnostics(): Promise<never> {
    throw new Error("not used");
  }
  async getPreferences(): Promise<Preferences> {
    return this.preferences;
  }
  async setPreferences(patch: Partial<Preferences>): Promise<Preferences> {
    this.preferences = { ...this.preferences, ...patch };
    return this.preferences;
  }
  onMenuCommand(): () => void {
    return () => undefined;
  }
  async copyText(): Promise<void> {}
  async openExternal(): Promise<void> {}
  async revealPath(): Promise<void> {}
  async listOpenTargets(): Promise<OpenTarget[]> {
    return [{ id: "finder" }];
  }
  async openWorkspace(): Promise<OpenTargetId> {
    return "finder";
  }
}

function waitForState(store: AppStore, predicate: (state: AppState) => boolean, timeoutMs = 2_000): Promise<AppState> {
  return new Promise((resolve, reject) => {
    if (predicate(store.getState())) {
      resolve(store.getState());
      return;
    }
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error("state predicate not met in time"));
    }, timeoutMs);
    const unsubscribe = store.subscribe(() => {
      if (!predicate(store.getState())) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(store.getState());
    });
  });
}

function setup() {
  const store = createAppStore();
  const bridge = new FakeBridge();
  let counter = 0;
  const actions = createActions(store, bridge, { now: () => 5_000, newId: () => `id-${++counter}` });
  return { store, bridge, actions };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let settle: (value: T) => void = () => { throw new Error("not initialized"); };
  const promise = new Promise<T>((resolve) => { settle = resolve; });
  return { promise, resolve: (value) => settle(value) };
}

function historyOf(turns: HistoryTurn[]): HistoryResult {
  return { turns, todo: null, tasks: [] };
}

async function listThread(setupResult: ReturnType<typeof setup>): Promise<void> {
  await setupResult.actions.refreshThreads();
  setupResult.bridge.calls.length = 0;
}

describe("createActions", () => {
  it("drops malformed thread/list entries and keeps the valid ones", async () => {
    const context = setup();
    context.bridge.threadList = () => ({ data: [null, { id: 7 }, makeThread(THREAD_ID, { path: SESSION_PATH })], nextCursor: 5 });
    await context.actions.refreshThreads();
    expect(Object.keys(context.store.getState().threads)).toEqual([THREAD_ID]);
    expect(context.store.getState().threadsCursor).toBeNull();
  });
  it("drops a listed thread whose name is not a string so every sidebar title renders", async () => {
    const context = setup();
    context.bridge.threadList = () => ({ data: [{ ...makeThread("bad"), name: 42 }, makeThread("good", { name: "Fix login" })], nextCursor: null });
    await context.actions.refreshThreads();
    const listed = selectThreadsByWorkspace(context.store.getState()).flatMap((group) => group.threads);
    expect(listed.map((thread) => projectTitleText(thread.name ?? ""))).toEqual(["Fix login"]);
  });
  it("reports a malformed thread/start result instead of storing the thread", async () => {
    const context = setup();
    context.bridge.started = (cwd) => ({ thread: { id: THREAD_ID }, model: "m", modelProvider: "p", cwd, reasoningEffort: null });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await context.actions.newThread("/tmp/work/project")).toBeNull();
    } finally {
      warn.mockRestore();
    }
    expect(context.store.getState().threads[THREAD_ID]).toBeUndefined();
    expect(context.store.getState().notices.at(-1)?.message).toContain("malformed thread/start result");
  });
  const activeGoal: ClientResult<"thread/goal/get">["goal"] = {
    threadId: THREAD_ID, objective: "ship", status: "active", tokenBudget: null, tokensUsed: 1, timeUsedSeconds: 2,
    createdAt: 1, updatedAt: 2,
  };
  it("reads the native goal once after start and again after turn settlement", async () => {
    const context = setup();
    context.bridge.goal = async () => ({ goal: activeGoal });
    const disconnect = context.actions.connect();
    try {
      await context.actions.newThread("/tmp/work/project");
      expect(context.store.getState().conversations[THREAD_ID]?.live.goal).toEqual(activeGoal);
      context.bridge.goal = async () => ({ goal: null });
      const settled = waitForState(context.store, (state) => state.conversations[THREAD_ID]?.live.goal === null);
      context.bridge.emitNotification("turn/completed", { threadId: THREAD_ID, turn: { ...runningTurn, status: "completed" } });
      await settled;
      expect(context.bridge.methods().filter((method) => method === "thread/goal/get")).toHaveLength(2);
    } finally {
      disconnect();
    }
  });
  it("does not let an older goal read overwrite a goal notification", async () => {
    const context = setup();
    const pending = deferred<ClientResult<"thread/goal/get">>();
    context.bridge.goal = () => pending.promise;
    const disconnect = context.actions.connect();
    const opened = waitForState(context.store, (state) => state.conversations[THREAD_ID]?.resumed === true);
    const start = context.actions.newThread("/tmp/work/project");
    await opened;
    context.bridge.emitNotification("thread/goal/updated", { threadId: THREAD_ID, turnId: null, goal: activeGoal });
    pending.resolve({ goal: null });
    await start;
    expect(context.store.getState().conversations[THREAD_ID]?.live.goal).toEqual(activeGoal);
    disconnect();
  });
  it.each(["todo", "eval"] as const)("refreshes durable todo once after a completed %s call", async (tool) => {
    const context = setup();
    await listThread(context);
    await context.actions.openThread(THREAD_ID);
    context.bridge.historyLoads.length = 0;
    const phases = [{ name: "phase", tasks: [{ content: "item", status: "abandoned" as const }] }];
    context.bridge.history = async () => ({ turns: [], todo: { phases }, tasks: [] });
    const disconnect = context.actions.connect();
    await waitForState(context.store, (state) => state.bridge?.state === "starting");
    const refreshed = waitForState(context.store, (state) => state.conversations[THREAD_ID]?.live.todo?.source === "live");
    context.bridge.emitNotification("item/completed", { threadId: THREAD_ID, turnId: "turn", item: {
      type: "dynamicToolCall", id: "todo-1", tool, namespace: null, arguments: tool === "eval" ? { code: 'await tool.todo({op:"view"})' } : {},
      status: "completed", contentItems: [], success: true, durationMs: 0,
    } });
    await refreshed;
    context.bridge.emitNotification("item/completed", { threadId: THREAD_ID, turnId: "turn", item: {
      type: "dynamicToolCall", id: "todo-1", tool, namespace: null, arguments: tool === "eval" ? { code: 'await tool.todo({op:"view"})' } : {},
      status: "completed", contentItems: [], success: true, durationMs: 0,
    } });
    expect(context.bridge.historyLoads).toEqual([SESSION_PATH]);
    expect(context.store.getState().conversations[THREAD_ID]?.live.todo).toEqual({ phases, source: "live" });
    disconnect();
  });
  it("ignores a todo refresh response after bridge reconnect", async () => {
    const context = setup();
    await listThread(context);
    await context.actions.openThread(THREAD_ID);
    const pending = deferred<HistoryResult>();
    context.bridge.history = () => pending.promise;
    const disconnect = context.actions.connect();
    await waitForState(context.store, (state) => state.bridge?.state === "starting");
    context.bridge.emitNotification("item/completed", { threadId: THREAD_ID, turnId: "turn", item: {
      type: "dynamicToolCall", id: "todo-1", tool: "todo", namespace: null, arguments: {},
      status: "completed", contentItems: [], success: true, durationMs: 0,
    } });
    context.bridge.emitStatus(bridgeStatus("restarting"));
    pending.resolve({ turns: [], todo: { phases: [] }, tasks: [] });
    await pending.promise;
    expect(context.store.getState().conversations[THREAD_ID]?.live.todo).toBeNull();
    disconnect();
  });
  it("restores projected history without attaching live state", async () => {
    const context = setup();
    await listThread(context);
    context.bridge.history = async () => ({ turns: [], todo: { phases: [] }, tasks: [{ task_id: "old", status: "running", source: "history" }] });
    await context.actions.openThread(THREAD_ID);
    expect(context.store.getState().conversations[THREAD_ID]?.live).toMatchObject({
      freshness: "unattached", todo: { source: "history", phases: [] }, historicalTasks: [{ task_id: "old", source: "history" }], runs: {}, tasks: {},
    });
    expect(context.bridge.methods()).not.toContain("thread/goal/get");
  });
  const providerError = { message: "402: Insufficient Balance" };
  const failedHistory = (completedAt: number | null = 5_000): HistoryTurn => ({
    id: "history-1", status: "failed", error: providerError, items: [], startedAt: 4_000, completedAt,
  });

  async function reconcileContext() {
    const context = setup();
    await listThread(context);
    const disconnect = context.actions.connect();
    context.bridge.emitNotification("turn/started", { threadId: THREAD_ID, turn: runningTurn });
    const complete = (items: Turn["items"] = [], error: Turn["error"] = null) =>
      context.bridge.emitNotification("turn/completed", {
        threadId: THREAD_ID, turn: { ...runningTurn, status: "completed", error, items },
      });
    return { ...context, disconnect, complete };
  }

  it("reconciles an empty completed turn once using the latest failed history error", async () => {
    const context = await reconcileContext();
    const history = Promise.resolve(historyOf([
      failedHistory(4_000),
      { ...failedHistory(), id: "latest", error: { message: "latest failure" } },
      { ...failedHistory(), id: "success", status: "completed" as const, error: null },
    ]));
    context.bridge.history = () => history;
    context.complete([{ type: "userMessage", id: "u1", clientId: null, content: [] }]);
    await history;
    expect(context.store.getState().conversations[THREAD_ID]?.turns[0]).toMatchObject({
      status: "completed", error: { message: "latest failure" },
    });
    context.complete();
    expect(context.bridge.historyLoads).toEqual([SESSION_PATH]);
    context.disconnect();
  });

  it.each(["agentMessage", "reasoning", "dynamicToolCall", "commandExecution", "fileChange"] as const)(
    "never reads history when the turn produced %s",
    async (type) => {
      const context = await reconcileContext();
      const items: Turn["items"] = type === "agentMessage"
        ? [{ type, id: "a", text: "answer", phase: null }]
        : type === "reasoning"
          ? [{ type, id: "a", summary: [], content: ["thinking"] }]
          : type === "dynamicToolCall"
            ? [{ type, id: "a", namespace: null, tool: "eval", arguments: {}, status: "completed", contentItems: [], success: true, durationMs: 1 }]
            : type === "commandExecution"
              ? [{ type, id: "a", command: "pwd", cwd: "/tmp", status: "completed", aggregatedOutput: "/tmp", exitCode: 0, durationMs: 1 }]
              : [{ type, id: "a", changes: [], status: "completed" }];
      context.bridge.emitNotification("item/completed", { threadId: THREAD_ID, turnId: runningTurn.id, item: items[0] });
      context.complete();
      expect(context.bridge.historyLoads).toEqual([]);
      context.disconnect();
    },
  );

  it.each([3_000, 2_999, null])("allows only two seconds of skew (completion %s)", async (completedAt) => {
    const context = await reconcileContext();
    const history = Promise.resolve(historyOf([failedHistory(completedAt)]));
    context.bridge.history = () => history;
    context.complete();
    await history;
    expect(context.store.getState().conversations[THREAD_ID]?.turns[0]?.error)
      .toEqual(completedAt === 3_000 ? providerError : null);
    context.disconnect();
  });

  it("does not read history for an agent message present only in the completion", async () => {
    const context = await reconcileContext();
    context.complete([{ type: "agentMessage", id: "a", text: "answer", phase: null }]);
    expect(context.bridge.historyLoads).toEqual([]);
    context.disconnect();
  });

  it("does not read history when the turn already reports an error", async () => {
    const context = await reconcileContext();
    context.complete([], providerError);
    expect(context.bridge.historyLoads).toEqual([]);
    context.disconnect();
  });

  it("does not read history when the session path is unknown", async () => {
    const context = await reconcileContext();
    context.store.dispatch({ type: "thread/opened", thread: makeThread(THREAD_ID, { path: null }), resumed: true });
    context.complete();
    expect(context.bridge.historyLoads).toEqual([]);
    context.disconnect();
  });

  it("leaves the turn unchanged when history has no failed error", async () => {
    const context = await reconcileContext();
    const history = Promise.resolve(historyOf([
      { ...failedHistory(), error: null },
      { ...failedHistory(), id: "success", status: "completed" as const },
    ]));
    context.bridge.history = () => history;
    context.complete();
    const before = context.store.getState().conversations[THREAD_ID]?.turns[0];
    await history;
    expect(context.store.getState().conversations[THREAD_ID]?.turns[0]).toBe(before);
    context.disconnect();
  });

  it.each(["deleted", "replaced", "disconnected"] as const)("ignores history after the turn is %s", async (stale) => {
    const context = await reconcileContext();
    let resolveHistory: (history: HistoryResult) => void = () => { throw new Error("not initialized"); };
    const history = new Promise<HistoryResult>((resolve) => { resolveHistory = resolve; });
    context.bridge.history = () => history;
    context.complete();
    if (stale === "deleted") context.bridge.emitNotification("thread/deleted", { threadId: THREAD_ID });
    else if (stale === "replaced") context.store.dispatch({ type: "history/loaded", threadId: THREAD_ID, turns: [
      { ...failedHistory(), id: runningTurn.id, error: null },
    ] });
    else context.disconnect();
    const before = context.store.getState().conversations[THREAD_ID]?.turns;
    resolveHistory(historyOf([failedHistory()]));
    await history;
    expect(context.store.getState().conversations[THREAD_ID]?.turns).toBe(before);
    context.disconnect();
  });

  it("logs read failures without pushing a notice", async () => {
    const context = await reconcileContext();
    const error = new Error("history unavailable");
    const history = Promise.reject<HistoryResult>(error);
    context.bridge.history = () => history;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      context.complete();
      await history.catch(() => undefined);
      expect(warn).toHaveBeenCalledWith("Could not reconcile provider error from session history", error);
      expect(context.store.getState().notices).toEqual([]);
    } finally {
      warn.mockRestore();
      context.disconnect();
    }
  });

  it("resumes a non-resumed thread before starting the turn with the client message id", async () => {
    const context = setup();
    await listThread(context);
    await context.actions.openThread(THREAD_ID);
    expect(await context.actions.sendMessage("hello")).toBe(true);
    expect(context.bridge.methods()).toEqual(["thread/resume", "thread/goal/get", "skills/list", "turn/start"]);
    expect(context.bridge.calls[3]?.params).toEqual({
      threadId: THREAD_ID,
      input: [{ type: "text", text: "hello", text_elements: [] }],
      clientUserMessageId: "id-1",
    });
    const conversation = context.store.getState().conversations[THREAD_ID];
    expect(conversation?.resumed).toBe(true);
    expect(conversation?.session).toEqual({ modelProvider: "anthropic", model: "claude-fable-5", reasoningEffort: null });
    expect(conversation?.pendingUserMessages).toEqual([{ clientId: "id-1", text: "hello", sentAtMs: 5_000 }]);
  });

  it("steers the running turn instead of starting a new one", async () => {
    const context = setup();
    await listThread(context);
    await context.actions.openThread(THREAD_ID);
    context.store.dispatch(notification("turn/started", { threadId: THREAD_ID, turn: runningTurn }));
    expect(await context.actions.sendMessage("also this")).toBe(true);
    expect(context.bridge.calls).toEqual([
      {
        method: "turn/steer",
        params: { threadId: THREAD_ID, expectedTurnId: "turn-9", input: [{ type: "text", text: "also this", text_elements: [] }] },
      },
    ]);
    expect(context.store.getState().notices).toMatchObject([{ level: "info", threadId: THREAD_ID, code: "steered" }]);
  });

  it("resolves false and drops the pending message when turn/start fails", async () => {
    const context = setup();
    await listThread(context);
    await context.actions.openThread(THREAD_ID);
    context.bridge.failing.add("turn/start");
    expect(await context.actions.sendMessage("hello")).toBe(false);
    const state = context.store.getState();
    expect(state.conversations[THREAD_ID]?.pendingUserMessages).toEqual([]);
    expect(state.notices).toMatchObject([{ level: "error", message: "-32000: turn/start failed", threadId: THREAD_ID }]);
  });

  it("answers a user-input request with the wire answer map", async () => {
    const context = setup();
    context.store.dispatch({
      type: "rpc/serverRequest",
      request: {
        id: 11,
        method: "item/tool/requestUserInput",
        params: { threadId: THREAD_ID, turnId: "t", itemId: "i", questions: [{ id: "q1", header: "H", question: "?", options: null }] },
      },
      receivedAtMs: 1,
    });
    await context.actions.answerUserInput(11, { q1: ["B"] });
    expect(context.bridge.responses).toEqual([{ id: 11, result: { answers: { q1: { answers: ["B"] } } } }]);
    expect(context.store.getState().pendingRequests).toEqual([]);
  });

  it("loads history from the session path without resuming the thread", async () => {
    const context = setup();
    await listThread(context);
    await context.actions.openThread(THREAD_ID);
    expect(context.bridge.historyLoads).toEqual([SESSION_PATH]);
    expect(context.bridge.methods()).not.toContain("thread/resume");
    expect(context.store.getState().conversations[THREAD_ID]?.historyState).toBe("loaded");
    expect(context.store.getState().activeThreadId).toBe(THREAD_ID);
  });

  it("refreshes models and threads when the bridge becomes connected", async () => {
    const context = setup();
    const disconnect = context.actions.connect();
    await waitForState(context.store, (state) => state.bridge?.state === "starting");
    context.bridge.emitStatus(bridgeStatus("connected"));
    const state = await waitForState(context.store, (next) => next.threadsLoaded && next.models.length > 0);
    disconnect();
    expect(context.bridge.methods().sort()).toEqual(["model/list", "thread/list"]);
    expect(context.bridge.calls.find((call) => call.method === "thread/list")?.params).toEqual({ limit: 50 });
    expect(state.threadOrder).toEqual([THREAD_ID]);
  });
});

describe("skill catalog actions", () => {
  const cwd = "/tmp/work/project";

  it("never requests a fallback catalog before a thread is loaded", async () => {
    const context = setup();
    await listThread(context);
    await context.actions.openThread(THREAD_ID);
    await context.actions.ensureSkills(cwd);
    await context.actions.loadSkills(cwd, { force: true });
    expect(context.bridge.methods()).not.toContain("skills/list");
    expect(selectSkillCatalog(context.store.getState(), cwd).status).toBe("idle");
  });

  it("loads once after thread start and keeps subsequent ensures idempotent", async () => {
    const context = setup();
    expect(await context.actions.newThread(cwd)).toBe(THREAD_ID);
    await context.actions.ensureSkills(cwd);
    await context.actions.openThread(THREAD_ID);
    expect(context.bridge.methods()).toEqual(["thread/start", "thread/goal/get", "skills/list"]);
    expect(context.bridge.calls[2]?.params).toEqual({ cwds: [cwd] });
    expect(selectSkillCatalog(context.store.getState(), cwd)).toMatchObject({ status: "ready", skills: [{ name: "ulw-loop" }] });
  });

  it("loads after lazy resume before sending canonical text", async () => {
    const context = setup();
    await listThread(context);
    await context.actions.openThread(THREAD_ID);
    expect(await context.actions.sendMessage("/skill:ulw-loop /skill:plan do work")).toBe(true);
    expect(context.bridge.methods()).toEqual(["thread/resume", "thread/goal/get", "skills/list", "turn/start"]);
    expect(context.bridge.calls[3]?.params).toMatchObject({
      input: [{ type: "text", text: "/skill:ulw-loop /skill:plan do work", text_elements: [] }],
    });
  });

  it("does not request again while an ensure is loading", async () => {
    const context = setup();
    context.store.dispatch({ type: "thread/opened", thread: makeThread(THREAD_ID), resumed: true });
    const pending = deferred<SkillsListResponse>();
    context.bridge.skills = () => pending.promise;
    const first = context.actions.ensureSkills(cwd);
    await context.actions.ensureSkills(cwd);
    expect(context.bridge.methods()).toEqual(["skills/list"]);
    pending.resolve({ data: [{ cwd, skills: [], errors: [] }] });
    await first;
    expect(selectSkillCatalog(context.store.getState(), cwd).status).toBe("ready");
  });

  it("fences a stale result after an explicit forced reload", async () => {
    const context = setup();
    context.store.dispatch({ type: "thread/opened", thread: makeThread(THREAD_ID), resumed: true });
    const pending = deferred<SkillsListResponse>();
    context.bridge.skills = () => pending.promise;
    const old = context.actions.loadSkills(cwd);
    context.bridge.skills = async () => ({ data: [{ cwd, skills: [], errors: [] }] });
    await context.actions.loadSkills(cwd, { force: true });
    pending.resolve({ data: [{ cwd, skills: [], errors: [{ path: cwd, message: "stale" }] }] });
    await old;
    expect(context.bridge.calls[1]?.params).toEqual({ cwds: [cwd], forceReload: true });
    expect(selectSkillCatalog(context.store.getState(), cwd)).toMatchObject({ status: "ready", errors: [] });
  });

  it("records a request failure and permits explicit retry", async () => {
    const context = setup();
    context.store.dispatch({ type: "thread/opened", thread: makeThread(THREAD_ID), resumed: true });
    context.bridge.failing.add("skills/list");
    await context.actions.loadSkills(cwd);
    expect(selectSkillCatalog(context.store.getState(), cwd)).toMatchObject({
      status: "error", errors: [{ path: cwd, message: "-32000: skills/list failed" }],
    });
    context.bridge.failing.delete("skills/list");
    await context.actions.loadSkills(cwd);
    expect(selectSkillCatalog(context.store.getState(), cwd).status).toBe("ready");
  });

  it("records a missing cwd response rather than showing an empty success", async () => {
    const context = setup();
    context.store.dispatch({ type: "thread/opened", thread: makeThread(THREAD_ID), resumed: true });
    context.bridge.skills = async () => ({ data: [] });
    await context.actions.ensureSkills(cwd);
    expect(selectSkillCatalog(context.store.getState(), cwd)).toMatchObject({
      status: "error", errors: [{ path: cwd, message: `skills/list returned no entry for ${cwd}` }],
    });
  });

  it("invalidates every cwd and force reloads only the active loaded cwd", async () => {
    const context = setup();
    const disconnect = context.actions.connect();
    await waitForState(context.store, (state) => state.bridge?.state === "starting");
    await context.actions.newThread("/tmp/other");
    context.store.dispatch({ type: "thread/opened", thread: makeThread(THREAD_ID), resumed: true });
    context.store.dispatch({ type: "thread/activated", threadId: THREAD_ID });
    await context.actions.ensureSkills(cwd);
    context.bridge.calls.length = 0;
    const ready = waitForState(context.store, (state) => selectSkillCatalog(state, cwd).status === "ready" &&
      selectSkillCatalog(state, "/tmp/other").stale);
    context.bridge.emitNotification("skills/changed", {});
    await ready;
    expect(context.bridge.calls).toEqual([{ method: "skills/list", params: { cwds: [cwd], forceReload: true } }]);
    expect(selectSkillCatalog(context.store.getState(), "/tmp/other").status).toBe("idle");
    disconnect();
  });

  it("refreshes an invalidated catalog when its loaded thread is reopened", async () => {
    const context = setup();
    await context.actions.newThread(cwd);
    context.store.dispatch(notification("skills/changed", {}));
    const ready = waitForState(context.store, (state) => selectSkillCatalog(state, cwd).status === "ready");
    await context.actions.openThread(THREAD_ID);
    await ready;
    expect(context.bridge.calls.at(-1)).toEqual({ method: "skills/list", params: { cwds: [cwd], forceReload: true } });
  });

  it("clears loaded cwds on reconnect and ignores the previous process response", async () => {
    const context = setup();
    const disconnect = context.actions.connect();
    await waitForState(context.store, (state) => state.bridge?.state === "starting");
    await context.actions.newThread(cwd);
    const pending = deferred<SkillsListResponse>();
    context.bridge.skills = () => pending.promise;
    const old = context.actions.loadSkills(cwd);
    context.bridge.emitStatus(bridgeStatus("exited"));
    context.bridge.emitStatus(bridgeStatus("connected"));
    pending.resolve({ data: [{ cwd, skills: [], errors: [] }] });
    await old;
    await context.actions.ensureSkills(cwd);
    expect(context.store.getState().skillCatalogs).toEqual({});
    expect(context.store.getState().loadedSkillCwds).toEqual({});
    expect(context.store.getState().conversations[THREAD_ID]?.resumed).toBe(false);
    expect(context.bridge.methods().filter((method) => method === "skills/list")).toHaveLength(2);
    disconnect();
  });
});

describe("side chats", () => {
  const SIDE_ID = "side-1";
  const CWD = "/tmp/work/project";
  const request = {
    question: "what changed?",
    prompt: `${SIDE_BACKGROUND_MARKER}\nMain thread: x\n[end of background]\n\nSide question: what changed?`,
    context: true,
  };

  function sideSetup(sideStorage: SideStorage = memorySideStorage()) {
    const store = createAppStore();
    const bridge = new FakeBridge();
    let counter = 0;
    const actions = createActions(store, bridge, { now: () => 5_000, newId: () => `id-${++counter}`, sideStorage });
    return { store, bridge, actions, sideStorage };
  }

  async function openMain(context: ReturnType<typeof sideSetup>): Promise<void> {
    await context.actions.newThread(CWD);
    context.bridge.started = (cwd) => ({
      thread: makeThread(SIDE_ID, { cwd }), model: "claude-fable-5", modelProvider: "anthropic", cwd, reasoningEffort: null,
    });
    context.bridge.calls.length = 0;
  }

  it("starts a side thread in the main thread's cwd and sends the prompt only there", async () => {
    const context = sideSetup();
    await openMain(context);
    expect(await context.actions.askNewSide(request)).toBe(true);
    const state = context.store.getState();
    expect(state.btw.open).toBe(true);
    expect(state.btw.sides[SIDE_ID]).toEqual({ id: SIDE_ID, parentId: THREAD_ID, question: "what changed?", createdAtMs: 5_000, context: true });
    expect(state.btw.selected[THREAD_ID]).toBe(SIDE_ID);
    expect(context.bridge.calls.find((call) => call.method === "thread/start")?.params).toEqual({ cwd: CWD });
    const turnStarts = context.bridge.calls.filter((call) => call.method === "turn/start");
    expect(turnStarts).toHaveLength(1);
    expect(turnStarts[0]?.params).toMatchObject({ threadId: SIDE_ID, input: [{ type: "text", text: request.prompt, text_elements: [] }] });
    expect(context.bridge.calls.filter((call) => JSON.stringify(call.params).includes(THREAD_ID))).toEqual([]);
    expect(context.bridge.calls.find((call) => call.method === "thread/name/set")?.params).toEqual({ threadId: SIDE_ID, name: "BTW: what changed?" });
    expect(selectThreadsByWorkspace(state).flatMap((group) => group.threads.map((thread) => thread.id))).toEqual([THREAD_ID]);
  });

  it("asks on the side while the main turn runs without steering or interrupting it", async () => {
    const context = sideSetup();
    await openMain(context);
    context.store.dispatch(notification("turn/started", { threadId: THREAD_ID, turn: runningTurn }));
    expect(await context.actions.askNewSide(request)).toBe(true);
    expect(context.bridge.methods()).not.toContain("turn/steer");
    expect(context.bridge.methods()).not.toContain("turn/interrupt");
    expect(context.store.getState().conversations[THREAD_ID]?.activeTurnId).toBe(runningTurn.id);
  });

  it("keeps the question as the new-side draft and reports inside the panel when thread/start fails", async () => {
    const context = sideSetup();
    await openMain(context);
    context.bridge.failing.add("thread/start");
    expect(await context.actions.askNewSide(request)).toBe(false);
    const state = context.store.getState();
    expect(state.btw.sides).toEqual({});
    expect(state.btw.pending).toEqual({});
    expect(state.btw.drafts[sideDraftKey(THREAD_ID, null)]).toBe("what changed?");
    expect(selectPanelNotices(state, THREAD_ID, null).map((notice) => notice.message)).toEqual(["-32000: thread/start failed"]);
    expect(selectToastNotice(state)).toBeNull();
  });

  it("reports a failed side turn on the side thread instead of the toast queue", async () => {
    const context = sideSetup();
    await openMain(context);
    context.bridge.failing.add("turn/start");
    expect(await context.actions.askNewSide(request)).toBe(false);
    const state = context.store.getState();
    expect(selectPanelNotices(state, THREAD_ID, SIDE_ID).map((notice) => notice.message)).toEqual(["-32000: turn/start failed"]);
    expect(selectToastNotice(state)).toBeNull();
  });

  it("steers a running side turn with a follow-up and pushes no steer toast", async () => {
    const context = sideSetup();
    await openMain(context);
    await context.actions.askNewSide(request);
    context.store.dispatch(notification("turn/started", { threadId: SIDE_ID, turn: { ...runningTurn, id: "side-turn" } }));
    context.bridge.calls.length = 0;
    expect(await context.actions.sendToSide(SIDE_ID, "and then?")).toBe(true);
    expect(context.bridge.calls).toEqual([
      { method: "turn/steer", params: { threadId: SIDE_ID, expectedTurnId: "side-turn", input: [{ type: "text", text: "and then?", text_elements: [] }] } },
    ]);
    expect(context.store.getState().notices).toEqual([]);
    await context.actions.interruptSide(SIDE_ID);
    expect(context.bridge.calls.at(-1)).toEqual({ method: "turn/interrupt", params: { threadId: SIDE_ID, turnId: "side-turn" } });
  });

  it("deletes a main thread's side chats before the main thread", async () => {
    const context = sideSetup();
    await openMain(context);
    await context.actions.askNewSide(request);
    context.bridge.calls.length = 0;
    await context.actions.deleteThread(THREAD_ID);
    expect(context.bridge.calls.filter((call) => call.method === "thread/delete").map((call) => call.params)).toEqual([
      { threadId: SIDE_ID },
      { threadId: THREAD_ID },
    ]);
    expect(context.store.getState().btw.sides).toEqual({});
  });

  it("restores stored side chats on connect and stores registry changes", async () => {
    const stored = { id: "side-0", parentId: THREAD_ID, question: "old", createdAtMs: 1, context: true };
    const context = sideSetup(memorySideStorage([stored, { id: 5 }]));
    const disconnect = context.actions.connect();
    expect(Object.values(context.store.getState().btw.sides)).toEqual([stored]);
    await openMain(context);
    await context.actions.askNewSide(request);
    expect(parseStoredSides(context.sideStorage.load()).map((chat) => chat.id).sort()).toEqual(["side-0", SIDE_ID]);
    disconnect();
  });

  it("deletes a side thread whose main thread was deleted while its thread/start was pending", async () => {
    const context = sideSetup();
    await openMain(context);
    const start = deferred<unknown>();
    context.bridge.started = () => start.promise;
    const asking = context.actions.askNewSide(request);
    context.store.dispatch(notification("thread/started", { thread: makeThread(SIDE_ID, { cwd: CWD }) }));
    await context.actions.deleteThread(THREAD_ID);
    start.resolve({ thread: makeThread(SIDE_ID, { cwd: CWD }), model: "claude-fable-5", modelProvider: "anthropic", cwd: CWD, reasoningEffort: null });
    expect(await asking).toBe(false);
    expect(context.bridge.calls.filter((call) => call.method === "thread/delete").map((call) => call.params)).toEqual([
      { threadId: THREAD_ID },
      { threadId: SIDE_ID },
    ]);
    expect(context.bridge.methods()).not.toContain("turn/start");
    expect(context.bridge.methods()).not.toContain("thread/name/set");
    const { btw, threads } = context.store.getState();
    expect(btw.sides).toEqual({});
    expect(btw.pending).toEqual({});
    expect(btw.unclaimed).toEqual({});
    expect(threads[SIDE_ID]).toBeUndefined();
  });

  it("loads a retained side chat's history through thread/read without activating it", async () => {
    const stored = { id: "side-0", parentId: THREAD_ID, question: "old", createdAtMs: 1, context: true };
    const context = sideSetup(memorySideStorage([stored]));
    const disconnect = context.actions.connect();
    await context.actions.selectSide(THREAD_ID, "side-0");
    expect(context.bridge.methods()).toContain("thread/read");
    expect(context.bridge.historyLoads).toEqual(["/Users/me/.omo/agent/sessions/side-0.jsonl"]);
    const state = context.store.getState();
    expect(state.activeThreadId).toBeNull();
    expect(state.conversations["side-0"]?.historyState).toBe("loaded");
    expect(state.btw.selected[THREAD_ID]).toBe("side-0");
    disconnect();
  });
});

describe("MCP inventory actions", () => {
  it("follows pages using the active thread and records loading, timestamp and errors", async () => {
    const store = createAppStore();
    const bridge = new FakeBridge();
    const actions = createActions(store, bridge, { now: () => 123 });
    const server = { name: "one", serverInfo: null, tools: {}, resources: [], resourceTemplates: [], authStatus: "notLoggedIn" };
    bridge.mcp = ({ cursor }) => ({ data: [{ ...server, name: cursor === undefined ? "one" : "two" }], nextCursor: cursor === undefined ? "next" : null });
    store.dispatch({ type: "thread/activated", threadId: THREAD_ID });
    const loading = actions.loadMcpServers();
    expect(store.getState().mcp.loading).toBe(true);
    await loading;
    expect(store.getState().mcp).toMatchObject({ loading: false, error: null, loadedAt: 123 });
    expect(store.getState().mcp.servers.map((entry) => entry.name)).toEqual(["one", "two"]);
    expect(bridge.calls.filter((call) => call.method === "mcpServerStatus/list").map((call) => call.params)).toEqual([
      { threadId: THREAD_ID, detail: "full" }, { threadId: THREAD_ID, detail: "full", cursor: "next" },
    ]);
    bridge.failing.add("mcpServerStatus/list");
    await actions.loadMcpServers();
    expect(store.getState().mcp.loading).toBe(false);
    expect(store.getState().mcp.error).toContain("mcpServerStatus/list failed");
  });

  it("uses no thread when inactive and fences overlapping responses", async () => {
    const store = createAppStore();
    const bridge = new FakeBridge();
    const actions = createActions(store, bridge);
    let finish!: (value: unknown) => void;
    bridge.mcp = () => new Promise((resolve) => { finish = resolve; });
    const first = actions.loadMcpServers();
    bridge.mcp = () => ({ data: [], nextCursor: null });
    await actions.loadMcpServers();
    finish({ data: null });
    await first;
    expect(store.getState().mcp.error).toBeNull();
    expect(bridge.calls[0]?.params).toEqual({ detail: "full" });
  });

  it("refetches on any startup payload and reconnect only while open", async () => {
    const store = createAppStore();
    const bridge = new FakeBridge();
    let reads = 0;
    bridge.mcp = () => ({ data: [{ name: String(++reads), serverInfo: null, tools: {}, resources: [], resourceTemplates: [], authStatus: "unsupported" }], nextCursor: null });
    const actions = createActions(store, bridge);
    const disconnect = actions.connect();
    actions.setMcpSectionOpen(true);
    const notificationLoaded = waitForState(store, (state) => state.mcp.servers[0]?.name === "1");
    bridge.emitNotification("mcpServer/startupStatus/updated", null);
    await notificationLoaded;
    const reconnectLoaded = waitForState(store, (state) => state.mcp.servers[0]?.name === "2");
    bridge.emitStatus(bridgeStatus("connected"));
    await reconnectLoaded;
    actions.setMcpSectionOpen(false);
    bridge.emitNotification("mcpServer/startupStatus/updated", {});
    bridge.emitStatus(bridgeStatus("restarting"));
    bridge.emitStatus(bridgeStatus("connected"));
    expect(reads).toBe(2);
    disconnect();
  });
});

describe("branching from a user message", () => {
  const user = (id: string, text: string) => ({ type: "userMessage" as const, id, clientId: null, content: [{ type: "text" as const, text, text_elements: [] }] });
  const answer = (id: string) => ({ type: "agentMessage" as const, id, text: "ok", phase: null });
  // Like omo's live items, item ids repeat across turns; only the turn id tells the messages apart.
  const turnOf = (id: string, text: string): HistoryTurn => ({
    id, status: "completed", error: null, items: [user("u", text), answer("a")], startedAt: 1_000, completedAt: 2_000,
  });

  async function opened() {
    const context = setup();
    await listThread(context);
    context.bridge.history = async () => historyOf([turnOf("1", "first"), turnOf("2", "again"), turnOf("3", "again")]);
    await context.actions.openThread(THREAD_ID);
    context.bridge.calls.length = 0;
    return context;
  }

  it("branches before the chosen repeat of a message and sends the edited text to the branch", async () => {
    const context = await opened();
    await expect(context.actions.branchFrom(THREAD_ID, "3", "u", "edited", "first (edited)")).resolves.toBe(true);
    expect(context.bridge.branches).toEqual([{ sessionPath: SESSION_PATH, point: { text: "again", occurrence: 1 } }]);
    expect(context.bridge.methods()).toEqual(["thread/resume", "thread/name/set", "thread/list", "turn/start"]);
    expect(context.bridge.calls[0]?.params).toEqual({ threadId: BRANCH_ID });
    expect(context.bridge.calls[1]?.params).toEqual({ threadId: BRANCH_ID, name: "first (edited)" });
    expect(context.bridge.calls[3]?.params).toMatchObject({ threadId: BRANCH_ID, input: [{ type: "text", text: "edited" }] });
    expect(context.store.getState().activeThreadId).toBe(BRANCH_ID);
    expect(context.bridge.historyLoads.at(-1)).toBe(BRANCH_PATH);
    expect(context.store.getState().conversations[BRANCH_ID]?.turns.map((turn) => turn.id)).toEqual(["1", "2", "3"]);
  });

  it("refuses while a turn of the thread is running and leaves the session alone", async () => {
    const context = await opened();
    const disconnect = context.actions.connect();
    context.bridge.emitNotification("turn/started", { threadId: THREAD_ID, turn: runningTurn });
    await expect(context.actions.branchFrom(THREAD_ID, "1", "u", "edited", "x")).resolves.toBe(false);
    expect(context.bridge.branches).toEqual([]);
    expect(selectToastNotice(context.store.getState())).toMatchObject({ code: "branchBusy" });
    disconnect();
  });

  it("reports a message that the saved session does not hold instead of branching", async () => {
    const context = await opened();
    context.bridge.history = async () => historyOf([turnOf("1", "first")]);
    await expect(context.actions.branchFrom(THREAD_ID, "3", "u", "edited", "x")).resolves.toBe(false);
    expect(context.bridge.branches).toEqual([]);
    expect(context.store.getState().activeThreadId).toBe(THREAD_ID);
  });
});

describe("account actions", () => {
  const usage: AccountUsage = {
    provider: "anthropic-subscription", account: "work", email: null, plan: null, state: "ok", message: null,
    windows: [{ label: "5h", percent: 42, resetsAt: null, limited: false }],
  };

  it("reads every provider's accounts and the usage rows in one snapshot", async () => {
    const context = setup();
    context.bridge.usageRows = async () => [usage];
    const snapshot = await context.actions.loadAccounts();
    expect(snapshot.providers.find((entry) => entry.provider === "anthropic-subscription")?.accounts).toEqual([
      { name: "work", source: "login", blocked: false, pinned: true },
    ]);
    expect(snapshot.usage).toEqual([usage]);
    expect(snapshot.usageError).toBeNull();
  });

  it("keeps a failing provider and a failing usage read as per-row errors", async () => {
    const context = setup();
    context.bridge.failing.add("account/providerAccounts/read");
    context.bridge.usageRows = async () => { throw new Error("auth.json is unreadable"); };
    const snapshot = await context.actions.loadAccounts();
    expect(snapshot.providers.every((entry) => entry.error?.includes("failed") === true)).toBe(true);
    expect(snapshot.usageError).toBe("auth.json is unreadable");
  });

  it("pins, unpins and removes through omo and opens omo's sign-in", async () => {
    const context = setup();
    await expect(context.actions.pinAccount("anthropic-subscription", "work")).resolves.toBe(true);
    await expect(context.actions.pinAccount("anthropic-subscription", null)).resolves.toBe(true);
    await expect(context.actions.removeAccount("anthropic-subscription", "work")).resolves.toBe(true);
    expect(context.bridge.calls.map((call) => [call.method, call.params])).toEqual([
      ["account/providerAccounts/pin", { provider: "anthropic-subscription", name: "work" }],
      ["account/providerAccounts/pin", { provider: "anthropic-subscription", name: null }],
      ["account/providerAccounts/remove", { provider: "anthropic-subscription", name: "work" }],
    ]);
    await expect(context.actions.openAccountLogin("chatgpt-subscription")).resolves.toBe(true);
    expect(context.bridge.logins).toEqual(["chatgpt-subscription"]);
  });

  it("reports a rejected removal as an error notice and resolves false", async () => {
    const context = setup();
    context.bridge.failing.add("account/providerAccounts/remove");
    await expect(context.actions.removeAccount("anthropic-subscription", "work")).resolves.toBe(false);
    expect(selectToastNotice(context.store.getState())).toMatchObject({ level: "error" });
  });
});
