import type { AccountUsage, BridgeStatus, OmoBridgeApi } from "../../shared/ipc";
import type { ApprovalDecision, ProviderAccount, ReasoningEffort, RequestId, RpcNotification, ThreadSessionResult } from "../../shared/protocol";
import { messageInput, type ImageInput } from "../ui/composer/attachments";
import { resendOf, storedText } from "../ui/conversation/resend";
import type { AppStore } from "./store";
import type { AppState, NoticeCode, SessionModel, SideChat } from "./types";
import { parseStoredSides, selectSidesOf, sideDraftKey, sideName } from "./btw";
import { isModel, isSkill, isSkillError, isThread, parseNotification } from "./wire";
import { selectSkillCatalog } from "./selectors";
import { object, parseGoal } from "./live-wire";

import { normalizeMcpPage, type McpServer } from "./mcp";

const THREAD_PAGE_SIZE = 50;
const RECENT_WORKSPACE_LIMIT = 10;

export interface ActionOptions {
  now?: () => number;
  newId?: () => string;
  /** Where side chats persist; defaults to memory, and App.tsx passes `localSideStorage()`. */
  sideStorage?: SideStorage;
}

/** Where side chats persist across launches; `load` returns stored JSON that the caller validates. */
export interface SideStorage {
  load(): unknown;
  save(sides: SideChat[]): void;
}

const SIDE_STORAGE_KEY = "omo-ui.side-chats.v1";

/** Side chats in the renderer's localStorage under `omo-ui.side-chats.v1`. */
export function localSideStorage(storage: Storage = window.localStorage): SideStorage {
  return {
    load: (): unknown => {
      const raw = storage.getItem(SIDE_STORAGE_KEY);
      return raw === null ? [] : JSON.parse(raw);
    },
    save: (sides) => storage.setItem(SIDE_STORAGE_KEY, JSON.stringify(sides)),
  };
}

/** Side chats kept only for the lifetime of the returned object. */
export function memorySideStorage(initial: unknown = []): SideStorage {
  let value = initial;
  return {
    load: () => value,
    save: (sides) => {
      value = sides.map((side) => ({ ...side }));
    },
  };
}

/** A new side chat; the UI builds `prompt` (the main thread's background, then the question). */
export interface NewSideRequest {
  question: string;
  /** The first side message as sent to omo. */
  prompt: string;
  /** Whether `prompt` carries the main thread's background. */
  context: boolean;
}

/** Providers whose accounts the Accounts settings list; subscription providers always show, others only with accounts. */
export const ACCOUNT_PROVIDERS = ["anthropic-subscription", "chatgpt-subscription", "kimi-coding", "deepseek", "zai", "google", "openai"] as const;

/** One read of every provider's accounts and every subscription account's usage; failures stay per row. */
export interface AccountsSnapshot {
  providers: Array<{ provider: string; accounts: ProviderAccount[]; error: string | null }>;
  usage: AccountUsage[];
  usageError: string | null;
}

/** Async operations over the bridge. Every promise resolves; bridge failures become error notices. */
export interface AppActions {
  loadAccounts(): Promise<AccountsSnapshot>;
  /** `name: null` clears the provider's pin. */
  pinAccount(provider: string, name: string | null): Promise<boolean>;
  removeAccount(provider: string, name: string): Promise<boolean>;
  openAccountLogin(provider: string): Promise<boolean>;
  loadMcpServers(): Promise<void>;
  /** Section visibility scopes automatic reconnect/notification refreshes. */
  setMcpSectionOpen(open: boolean): void;
  /** Forwards bridge events into the store and refreshes models and threads on each transition into "connected"; returns the unsubscriber. */
  connect(): () => void;
  refreshModels(): Promise<void>;
  refreshThreads(append?: boolean): Promise<void>;
  /** Requests a cwd catalog only after a thread for that cwd is loaded; force reloads the server's session loader. */
  loadSkills(cwd: string, options?: { force?: boolean }): Promise<void>;
  /** Loads an idle or invalidated catalog, never creating/resuming a thread or requesting a pre-thread fallback catalog. */
  ensureSkills(cwd: string): Promise<void>;
  /** Activates the thread and loads its session history when not yet loaded; never resumes it. */
  openThread(threadId: string): Promise<void>;
  /** Starts and activates a thread in `cwd`; resolves its id, or null on failure. */
  newThread(cwd: string): Promise<string | null>;
  /** Sends to the active thread: steers the running turn, otherwise resumes the thread if needed and starts a turn; resolves true when omo accepted the message. */
  sendMessage(text: string, images?: readonly ImageInput[]): Promise<boolean>;
  interrupt(): Promise<void>;
  /**
   * Edits or rerolls from a user message: writes a new session holding `threadId`'s history before the message
   * `itemId`, resumes and activates it under `name`, and sends `text` with the message's images as its next turn.
   * The original thread is left unchanged. Resolves true when omo accepted the turn.
   */
  branchFrom(threadId: string, turnId: string, itemId: string, text: string, name: string): Promise<boolean>;
  renameThread(threadId: string, name: string): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
  answerApproval(id: RequestId, decision: ApprovalDecision, reason?: string): Promise<void>;
  answerUserInput(id: RequestId, answers: Record<string, string[]>, comment?: string): Promise<void>;
  selectModel(modelId: string | null, effort: ReasoningEffort | null, profile?: import("../../shared/ipc").ModelProfile): Promise<void>;
  dismissNotice(id: string): void;
  /** Shows or hides the side chat panel. */
  setSidePanel(open: boolean): void;
  /** Shows or hides the Agents DAG panel; opening it closes the side chat panel. */
  setAgentsPanel(open: boolean): void;
  /** Shows `sideId` (null: the new-side composer) for `parentId`, loading a retained side chat's history first. */
  selectSide(parentId: string, sideId: string | null): Promise<void>;
  /** Attaches or detaches the main thread's background for the next new side chat of `parentId`. */
  setSideContext(parentId: string, attached: boolean): void;
  setSideDraft(key: string, text: string): void;
  /**
   * Starts a side chat of the active thread: thread/start in its cwd with the composer's model, then `prompt` as the
   * first turn. Opens the panel and sends nothing to the main thread; resolves true when omo accepted the turn.
   */
  askNewSide(request: NewSideRequest): Promise<boolean>;
  /** Sends a follow-up to a side chat: steers its running turn, otherwise starts a turn; resolves true when omo accepted it. */
  sendToSide(sideId: string, text: string): Promise<boolean>;
  interruptSide(sideId: string): Promise<void>;
}

function sessionOf(result: ThreadSessionResult): SessionModel {
  return { modelProvider: result.modelProvider, model: result.model, reasoningEffort: result.reasoningEffort };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createActions(store: AppStore, bridge: OmoBridgeApi, options: ActionOptions = {}): AppActions {
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const sideStorage = options.sideStorage ?? memorySideStorage();

  const notify = (level: "info" | "error", message: string, threadId: string | null = null, code?: NoticeCode): void => {
    store.dispatch({ type: "notice/pushed", notice: { id: newId(), level, message, threadId, ...(code === undefined ? {} : { code }) } });
  };
  const fail = (error: unknown, threadId: string | null = null): void => notify("error", errorMessage(error), threadId);
  const guarded = async (work: () => Promise<void>, threadId: string | null = null): Promise<void> => {
    try {
      await work();
    } catch (error) {
      fail(error, threadId);
    }
  };
  const goalReads = new Map<string, number>();
  const todoReads = new Map<string, number>();
  let connectionRevision = 0;
  const readGoal = async (threadId: string): Promise<void> => {
    const live = store.getState().conversations[threadId]?.live;
    if (live === undefined) return;
    const request = (goalReads.get(threadId) ?? 0) + 1;
    const connection = connectionRevision;
    goalReads.set(threadId, request);
    try {
      const result: unknown = await bridge.request("thread/goal/get", { threadId });
      if (!object(result) || goalReads.get(threadId) !== request || connection !== connectionRevision) return;
      const goal = result["goal"] === null ? null : parseGoal(result["goal"]);
      if (result["goal"] !== null && (goal === null || goal.threadId !== threadId)) return;
      store.dispatch({ type: "goal/loaded", threadId, goal, generation: live.generation, revision: live.goalRevision });
    } catch (error) {
      if (connection === connectionRevision && store.getState().conversations[threadId]?.live.generation === live.generation) fail(error, threadId);
    }
  };
  const refreshTodo = async (threadId: string): Promise<void> => {
    const state = store.getState();
    const live = state.conversations[threadId]?.live;
    const path = state.threads[threadId]?.path;
    if (live === undefined || path == null) return;
    const request = (todoReads.get(threadId) ?? 0) + 1;
    const connection = connectionRevision;
    todoReads.set(threadId, request);
    try {
      const history = await bridge.loadHistory(path);
      if (todoReads.get(threadId) !== request || connection !== connectionRevision) return;
      store.dispatch({ type: "todo/loaded", threadId, todo: history.todo, generation: live.generation, revision: live.todoRevision });
    } catch (error) {
      if (connection === connectionRevision && store.getState().conversations[threadId]?.live.generation === live.generation) fail(error, threadId);
    }
  };

  let mcpSectionOpen = false;
  let mcpRead = 0;
  const loadAccounts = async (): Promise<AccountsSnapshot> => {
    const [providers, usage] = await Promise.all([
      Promise.all(ACCOUNT_PROVIDERS.map(async (provider) => {
        try {
          const result = await bridge.request("account/providerAccounts/read", { provider });
          return { provider, accounts: Array.isArray(result.accounts) ? result.accounts : [], error: null };
        } catch (error) {
          return { provider, accounts: [], error: errorMessage(error) };
        }
      })),
      bridge.readAccountUsage().then((rows) => ({ rows, error: null }), (error: unknown) => ({ rows: [], error: errorMessage(error) })),
    ]);
    return { providers, usage: usage.rows, usageError: usage.error };
  };

  const accountAction = async (run: () => Promise<unknown>): Promise<boolean> => {
    try {
      await run();
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };

  // Memory writes and omo's special messages exist only in the session file. Reading it is costly for long sessions,
  // so only a turn that called the memory tool re-reads it; opening a thread reads everything anyway.
  const refreshAnnotations = async (threadId: string): Promise<void> => {
    const state = store.getState();
    const path = state.threads[threadId]?.path ?? null;
    if (path === null || state.conversations[threadId] === undefined) return;
    try {
      const history = await bridge.loadHistory(path);
      store.dispatch({ type: "history/annotated", threadId, notices: history.notices ?? [], memoryWrites: history.memoryWrites ?? {} });
    } catch (error) {
      // The transcript stays usable without annotations; the next completed turn retries.
      console.warn("Could not refresh session annotations", error);
    }
  };

  const loadMcpServers = async (): Promise<void> => {
    const request = ++mcpRead;
    const threadId = store.getState().activeThreadId;
    store.dispatch({ type: "mcp/updated", mcp: { ...store.getState().mcp, loading: true, error: null } });
    try {
      const servers: McpServer[] = [];
      let cursor: string | null = null;
      const cursors = new Set<string>();
      do {
        const result: unknown = await bridge.request("mcpServerStatus/list", {
          ...(threadId === null ? {} : { threadId }), ...(cursor === null ? {} : { cursor }), detail: "full",
        });
        if (request !== mcpRead) return;
        const page = normalizeMcpPage(result);
        servers.push(...page.servers);
        cursor = page.nextCursor;
        if (cursor !== null) {
          if (cursors.has(cursor)) throw new Error("omo returned a repeated MCP page cursor");
          cursors.add(cursor);
        }
      } while (cursor !== null);
      store.dispatch({ type: "mcp/updated", mcp: { servers, loading: false, error: null, loadedAt: now() } });
    } catch (error) {
      if (request === mcpRead) store.dispatch({ type: "mcp/updated", mcp: { ...store.getState().mcp, loading: false, error: errorMessage(error) } });
    }
  };

  const refreshModels = (): Promise<void> =>
    guarded(async () => {
      const result = await bridge.request("model/list", { includeHidden: false });
      if (!Array.isArray(result.data)) throw new Error("omo returned a malformed model/list result");
      store.dispatch({ type: "models/loaded", models: result.data.filter(isModel) });
    });

  const refreshThreads = (append = false): Promise<void> =>
    guarded(async () => {
      const cursor = store.getState().threadsCursor;
      if (append && cursor === null) return;
      const result = await bridge.request(
        "thread/list",
        append ? { limit: THREAD_PAGE_SIZE, cursor } : { limit: THREAD_PAGE_SIZE },
      );
      if (!Array.isArray(result.data)) throw new Error("omo returned a malformed thread/list result");
      const nextCursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
      store.dispatch({ type: "threads/listed", threads: result.data.filter(isThread), nextCursor, append });
    });

  const loadSkills = async (cwd: string, { force = false }: { force?: boolean } = {}): Promise<void> => {
    if (store.getState().loadedSkillCwds[cwd] !== true) return;
    store.dispatch({ type: "skills/loading", cwd });
    const generation = selectSkillCatalog(store.getState(), cwd).generation;
    try {
      const result = await bridge.request("skills/list", { cwds: [cwd], ...(force ? { forceReload: true } : {}) });
      if (!Array.isArray(result.data)) throw new Error("omo returned a malformed skills/list result");
      const entry = result.data.find((candidate) => object(candidate) && candidate.cwd === cwd);
      if (entry === undefined) throw new Error(`skills/list returned no entry for ${cwd}`);
      if (!Array.isArray(entry.skills) || !Array.isArray(entry.errors)) throw new Error(`skills/list returned a malformed entry for ${cwd}`);
      store.dispatch({ type: "skills/loaded", cwd, generation, skills: entry.skills.filter(isSkill), errors: entry.errors.filter(isSkillError) });
    } catch (error) {
      store.dispatch({ type: "skills/failed", cwd, generation, message: errorMessage(error) });
    }
  };

  const ensureSkills = (cwd: string): Promise<void> => {
    const catalog = selectSkillCatalog(store.getState(), cwd);
    return catalog.status === "idle" ? loadSkills(cwd, { force: catalog.stale }) : Promise.resolve();
  };

  const loadStoredSides = (): SideChat[] => {
    try {
      return parseStoredSides(sideStorage.load());
    } catch (error) {
      console.warn("Ignoring unreadable stored side chats", error);
      return [];
    }
  };
  const saveSides = (sides: AppState["btw"]["sides"]): void => {
    try {
      sideStorage.save(Object.values(sides));
    } catch (error) {
      fail(error);
    }
  };

  /** Sends to a thread: steers its running turn, otherwise resumes the thread when needed and starts a turn. */
  const deliver = async (threadId: string, text: string, announceSteer: boolean, images: readonly ImageInput[] = []): Promise<boolean> => {
    let imagePaths: string[];
    try {
      imagePaths = await Promise.all(images.map((image) => (image.type === "localImage" ? image.path : bridge.saveImage(image.url))));
    } catch (error) {
      fail(error, threadId);
      return false;
    }
    const conversation = store.getState().conversations[threadId];
    const activeTurnId = conversation?.activeTurnId ?? null;
    if (activeTurnId !== null) {
      try {
        await bridge.request("turn/steer", { threadId, expectedTurnId: activeTurnId, input: messageInput(text, imagePaths) });
        if (announceSteer) notify("info", "Message sent to the running turn.", threadId, "steered");
        return true;
      } catch (error) {
        // omo rejects a steer when the turn it names is no longer running there; the turn ended without this client
        // seeing turn/completed. Settle it locally and send the message as a new turn instead.
        console.warn("turn/steer rejected; starting a new turn", error);
        store.dispatch({ type: "turn/settled", threadId, status: "completed", settledAtMs: now() });
      }
    }
    const clientId = newId();
    try {
      if (conversation?.resumed !== true) {
        const resumed = await bridge.request("thread/resume", { threadId });
        if (!isThread(resumed.thread)) throw new Error("omo returned a malformed thread/resume result");
        store.dispatch({ type: "thread/opened", thread: resumed.thread, resumed: true, session: sessionOf(resumed) });
        await readGoal(threadId);
        await ensureSkills(resumed.thread.cwd);
      }
      store.dispatch({ type: "user/messageSent", threadId, clientId, text, ...(images.length === 0 ? {} : { images }), sentAtMs: now() });
      const { modelId, effort } = store.getState().composer;
      await bridge.request("turn/start", {
        threadId,
        input: messageInput(text, imagePaths),
        clientUserMessageId: clientId,
        ...(modelId === null ? {} : { model: modelId }),
        ...(effort === null ? {} : { effort }),
      });
      return true;
    } catch (error) {
      store.dispatch({ type: "user/messageFailed", threadId, clientId, message: errorMessage(error) });
      return false;
    }
  };

  /** Deletes a side thread whose main thread was deleted or archived while its thread/start was pending; it is never registered or sent a turn. */
  const discardOrphanSide = async (sideId: string, cwd: string): Promise<void> => {
    try {
      await bridge.request("thread/delete", { threadId: sideId });
      store.dispatch({ type: "rpc/notification", notification: { method: "thread/deleted", params: { threadId: sideId } }, receivedAtMs: now() });
    } catch (error) {
      fail(error);
    } finally {
      store.dispatch({ type: "btw/started", cwd, side: null });
    }
  };

  /**
   * Starts and registers a side thread. When the main thread disappeared while thread/start was pending, the new side
   * thread is deleted instead. On failure restores the question as the new-side draft and reports in the panel.
   */
  const startSideThread = async (parentId: string, cwd: string, question: string, context: boolean): Promise<SideChat | null> => {
    const { modelId } = store.getState().composer;
    store.dispatch({ type: "btw/starting", cwd });
    try {
      const result = await bridge.request("thread/start", modelId === null ? { cwd } : { cwd, model: modelId });
      if (!isThread(result.thread)) throw new Error("omo returned a malformed thread/start result");
      if (store.getState().threads[parentId] === undefined) {
        await discardOrphanSide(result.thread.id, cwd);
        return null;
      }
      const side: SideChat = { id: result.thread.id, parentId, question, createdAtMs: now(), context };
      store.dispatch({ type: "btw/started", cwd, side });
      store.dispatch({ type: "thread/opened", thread: result.thread, resumed: true, session: sessionOf(result) });
      store.dispatch({ type: "history/loaded", threadId: side.id, turns: [] });
      return side;
    } catch (error) {
      store.dispatch({ type: "btw/started", cwd, side: null });
      store.dispatch({ type: "btw/draftSet", key: sideDraftKey(parentId, null), text: question });
      store.dispatch({
        type: "notice/pushed",
        notice: { id: newId(), level: "error", message: errorMessage(error), threadId: parentId, scope: "side" },
      });
      return null;
    }
  };

  const rememberWorkspace = (cwd: string): Promise<void> =>
    guarded(async () => {
      const preferences = await bridge.getPreferences();
      const recentWorkspaces = [cwd, ...preferences.recentWorkspaces.filter((path) => path !== cwd)];
      await bridge.setPreferences({ lastWorkspace: cwd, recentWorkspaces: recentWorkspaces.slice(0, RECENT_WORKSPACE_LIMIT) });
    });

  return {
    connect() {
      let active = true;
      let statusPushed = false;
      if (!store.getState().btw.restored) store.dispatch({ type: "btw/restored", sides: loadStoredSides() });
      let savedSides = store.getState().btw.sides;
      const persistSides = (): void => {
        const { sides } = store.getState().btw;
        if (sides === savedSides) return;
        savedSides = sides;
        saveSides(sides);
      };
      const reconciled = new Set<string>();
      const todoCompletions = new Set<string>();
      const reconcile = async (notification: RpcNotification): Promise<void> => {
        const parsed = parseNotification(notification);
        if (parsed?.method !== "turn/completed") return;
        const { threadId, turn: reported } = parsed.params;
        const state = store.getState();
        const turn = state.conversations[threadId]?.turns.find((entry) => entry.id === reported.id);
        const path = state.threads[threadId]?.path;
        if (
          turn === undefined || turn.origin !== "live" || turn.error !== null ||
          turn.startedAtMs === null || path == null ||
          reported.items.some((item) => item.type !== "userMessage") ||
          turn.items.some((entry) => entry.item.type !== "userMessage")
        ) return;
        const key = JSON.stringify([threadId, turn.id, turn.startedAtMs]);
        const startedAtMs = turn.startedAtMs;
        if (reconciled.has(key)) return;
        reconciled.add(key);
        try {
          const history = await bridge.loadHistory(path);
          if (!active) return;
          const failed = history.turns.findLast((entry) =>
            entry.status === "failed" && entry.error !== null &&
            entry.completedAt !== null && entry.completedAt >= startedAtMs - 2000,
          );
          if (failed?.error != null) {
            store.dispatch({ type: "turn/errorReconciled", threadId, turn, error: failed.error });
          }
        } catch (error) {
          console.warn("Could not reconcile provider error from session history", error);
        }
      };
      const applyStatus = (status: BridgeStatus): void => {
        if (!active) return;
        const wasConnected = store.getState().bridge?.state === "connected";
        store.dispatch({ type: "bridge/status", status });
        if (status.state === "connected" && !wasConnected) {
          void refreshModels();
          void refreshThreads();
          if (mcpSectionOpen) void loadMcpServers();
        }
      };
      const unsubscribers = [
        store.subscribe(persistSides),
        bridge.onStatus((status) => {
          statusPushed = true;
          applyStatus(status);
        }),
        bridge.onNotification((notification) => {
          if (!active) return;
          store.dispatch({ type: "rpc/notification", notification, receivedAtMs: now() });
          const parsed = parseNotification(notification);
          if (parsed?.method === "mcpServer/startupStatus/updated" && mcpSectionOpen) void loadMcpServers();
          if (parsed?.method === "turn/completed") {
            void readGoal(parsed.params.threadId);
            if (parsed.params.turn.items.some((item) => item.type === "dynamicToolCall" && item.tool === "memory")) {
              void refreshAnnotations(parsed.params.threadId);
            }
          }
          if (parsed?.method === "item/completed" && parsed.params.item.type === "dynamicToolCall") {
            const item = parsed.params.item;
            if (item.tool === "todo" || (item.tool === "eval" && evalIncludesTodo(item.arguments, item.contentItems))) {
              const { threadId, turnId } = parsed.params;
              const generation = store.getState().conversations[threadId]?.live.generation;
              const key = JSON.stringify([threadId, turnId, item.id, generation]);
              if (!todoCompletions.has(key)) {
                todoCompletions.add(key);
                void refreshTodo(threadId);
              }
            }
          }
          if (parseNotification(notification)?.method === "skills/changed") {
            const state = store.getState();
            const cwd = state.activeThreadId === null ? undefined : state.threads[state.activeThreadId]?.cwd;
            if (cwd !== undefined) void ensureSkills(cwd);
          }
          void reconcile(notification);
        }),
        bridge.onServerRequest((request) => {
          if (active) store.dispatch({ type: "rpc/serverRequest", request, receivedAtMs: now() });
        }),
      ];
      bridge.getStatus().then(
        (status) => {
          if (!statusPushed) applyStatus(status);
        },
        (error: unknown) => {
          if (active) fail(error);
        },
      );
      return () => {
        active = false;
        connectionRevision += 1;
        for (const unsubscribe of unsubscribers) unsubscribe();
      };
    },

    loadAccounts,
    pinAccount: (provider, name) => accountAction(() => bridge.request("account/providerAccounts/pin", { provider, name })),
    removeAccount: (provider, name) => accountAction(() => bridge.request("account/providerAccounts/remove", { provider, name })),
    openAccountLogin: (provider) => accountAction(() => bridge.openAccountLogin(provider)),
    loadMcpServers,
    setMcpSectionOpen(open) { mcpSectionOpen = open; },
    refreshModels,
    refreshThreads,
    loadSkills,
    ensureSkills,

    async openThread(threadId) {
      store.dispatch({ type: "thread/activated", threadId });
      const state = store.getState();
      const historyState = state.conversations[threadId]?.historyState ?? "idle";
      const cwd = state.threads[threadId]?.cwd;
      if (cwd !== undefined) void ensureSkills(cwd);
      if (historyState !== "idle" && historyState !== "error") return;
      store.dispatch({ type: "history/loading", threadId });
      const path = state.threads[threadId]?.path ?? null;
      try {
        const history = path === null ? { turns: [], todo: null, tasks: [] } : await bridge.loadHistory(path);
        store.dispatch({ type: "history/loaded", threadId, ...history });
      } catch (error) {
        store.dispatch({ type: "history/failed", threadId, message: errorMessage(error) });
        fail(error, threadId);
      }
    },

    async newThread(cwd) {
      const { modelId } = store.getState().composer;
      try {
        const result = await bridge.request("thread/start", modelId === null ? { cwd } : { cwd, model: modelId });
        if (!isThread(result.thread)) throw new Error("omo returned a malformed thread/start result");
        const threadId = result.thread.id;
        store.dispatch({ type: "thread/opened", thread: result.thread, resumed: true, session: sessionOf(result) });
        store.dispatch({ type: "thread/activated", threadId });
        store.dispatch({ type: "history/loaded", threadId, turns: [] });
        await readGoal(threadId);
        await ensureSkills(result.thread.cwd);
        await rememberWorkspace(cwd);
        return threadId;
      } catch (error) {
        fail(error);
        return null;
      }
    },

    async sendMessage(text, images = []) {
      const threadId = store.getState().activeThreadId;
      if (threadId === null) {
        notify("error", "Open or start a session before sending a message.", null, "noActiveThread");
        return false;
      }
      return deliver(threadId, text, true, images);
    },

    async interrupt() {
      const state = store.getState();
      const threadId = state.activeThreadId;
      const turnId = threadId === null ? null : (state.conversations[threadId]?.activeTurnId ?? null);
      if (threadId === null || turnId === null) return;
      try {
        await bridge.request("turn/interrupt", { threadId, turnId });
      } catch (error) {
        console.warn("turn/interrupt rejected; ending the turn locally", error);
        store.dispatch({ type: "turn/settled", threadId, status: "interrupted", settledAtMs: now() });
      }
    },

    async branchFrom(threadId, turnId, itemId, text, name) {
      const state = store.getState();
      const conversation = state.conversations[threadId];
      const path = state.threads[threadId]?.path ?? null;
      if (conversation === undefined || path === null) return false;
      if (conversation.activeTurnId !== null) {
        notify("error", "Wait for the running turn to finish, or stop it, before editing or regenerating.", threadId, "branchBusy");
        return false;
      }
      // Item ids are only unique within a turn, so the clicked message is found by its turn and item id together.
      const shown = conversation.turns.flatMap((turn) =>
        turn.items.flatMap((entry) => (entry.item.type === "userMessage" ? [{ turnId: turn.id, item: entry.item }] : [])));
      const index = shown.findIndex((entry) => entry.turnId === turnId && entry.item.id === itemId);
      const clicked = shown[index]?.item;
      if (clicked === undefined) return false;
      const key = resendOf(clicked.content).text;
      const repeat = shown.slice(0, index).filter((entry) => resendOf(entry.item.content).text === key).length;
      let branchId: string;
      try {
        const history = await bridge.loadHistory(path);
        const stored = history.turns.flatMap((turn) => turn.items.flatMap((item) => (item.type === "userMessage" ? [item] : [])));
        const target = stored.filter((item) => resendOf(item.content).text === key)[repeat];
        if (target === undefined) throw new Error("This message is not in the saved session yet; reopen the thread and try again.");
        const raw = storedText(target.content);
        const occurrence = stored.slice(0, stored.indexOf(target)).filter((item) => storedText(item.content) === raw).length;
        const branch = await bridge.branchSession(path, { text: raw, occurrence });
        branchId = branch.threadId;
        const resumed = await bridge.request("thread/resume", { threadId: branchId });
        if (!isThread(resumed.thread)) throw new Error("omo returned a malformed thread/resume result");
        store.dispatch({ type: "thread/opened", thread: resumed.thread, resumed: true, session: sessionOf(resumed) });
        store.dispatch({ type: "thread/activated", threadId: branchId });
        store.dispatch({ type: "history/loaded", threadId: branchId, ...(await bridge.loadHistory(branch.path)) });
        await bridge.request("thread/name/set", { threadId: branchId, name });
        store.dispatch({ type: "rpc/notification", notification: { method: "thread/name/updated", params: { threadId: branchId, threadName: name } }, receivedAtMs: now() });
      } catch (error) {
        fail(error, threadId);
        return false;
      }
      void refreshThreads();
      return deliver(branchId, text, false, resendOf(clicked.content).images);
    },

    renameThread: (threadId, name) =>
      guarded(async () => {
        await bridge.request("thread/name/set", { threadId, name });
        store.dispatch({
          type: "rpc/notification",
          notification: { method: "thread/name/updated", params: { threadId, threadName: name } },
          receivedAtMs: now(),
        });
      }, threadId),

    deleteThread: (threadId) =>
      guarded(async () => {
        for (const side of selectSidesOf(store.getState(), threadId)) {
          try {
            await bridge.request("thread/delete", { threadId: side.id });
            store.dispatch({
              type: "rpc/notification",
              notification: { method: "thread/deleted", params: { threadId: side.id } },
              receivedAtMs: now(),
            });
          } catch (error) {
            fail(error);
          }
        }
        await bridge.request("thread/delete", { threadId });
        store.dispatch({
          type: "rpc/notification",
          notification: { method: "thread/deleted", params: { threadId } },
          receivedAtMs: now(),
        });
      }, threadId),

    answerApproval: (id, decision, reason) =>
      guarded(async () => {
        await bridge.respond(id, reason === undefined ? { decision } : { decision, reason });
        store.dispatch({ type: "rpc/serverRequestAnswered", id });
      }),

    answerUserInput: (id, answers, comment) =>
      guarded(async () => {
        const wireAnswers = Object.fromEntries(
          Object.entries(answers).map(([questionId, values]) => [questionId, { answers: values }]),
        );
        await bridge.respond(id, comment === undefined ? { answers: wireAnswers } : { answers: wireAnswers, comment });
        store.dispatch({ type: "rpc/serverRequestAnswered", id });
      }),

    selectModel: (modelId, effort, profile) =>
      guarded(async () => {
        store.dispatch({ type: "composer/modelSelected", modelId, effort, profile });
        await bridge.setPreferences({ modelId, modelProfile: profile ?? null });
      }),

    dismissNotice(id) {
      store.dispatch({ type: "notice/dismissed", id });
    },

    setSidePanel(open) {
      store.dispatch({ type: "btw/toggled", open });
    },

    setAgentsPanel(open) {
      store.dispatch({ type: "agents/toggled", open });
    },

    async selectSide(parentId, sideId) {
      store.dispatch({ type: "btw/selected", parentId, sideId });
      if (sideId === null) return;
      const state = store.getState();
      const historyState = state.conversations[sideId]?.historyState ?? "idle";
      if (historyState !== "idle" && historyState !== "error") return;
      store.dispatch({ type: "history/loading", threadId: sideId });
      try {
        let path = state.threads[sideId]?.path ?? null;
        if (state.threads[sideId] === undefined) {
          const read = await bridge.request("thread/read", { threadId: sideId });
          if (!isThread(read.thread)) throw new Error("omo returned a malformed thread/read result");
          store.dispatch({ type: "thread/opened", thread: read.thread, resumed: false });
          path = read.thread.path ?? null;
        }
        const history = path === null ? { turns: [], todo: null, tasks: [] } : await bridge.loadHistory(path);
        store.dispatch({ type: "history/loaded", threadId: sideId, ...history });
      } catch (error) {
        store.dispatch({ type: "history/failed", threadId: sideId, message: errorMessage(error) });
        fail(error, sideId);
      }
    },

    setSideContext(parentId, attached) {
      store.dispatch({ type: "btw/contextSet", parentId, attached });
    },

    setSideDraft(key, text) {
      store.dispatch({ type: "btw/draftSet", key, text });
    },

    async askNewSide({ question, prompt, context }) {
      store.dispatch({ type: "btw/toggled", open: true });
      const state = store.getState();
      const parentId = state.activeThreadId;
      const parent = parentId === null ? undefined : state.threads[parentId];
      if (parentId === null || parent === undefined) return false;
      const side = await startSideThread(parentId, parent.cwd, question, context);
      if (side === null) return false;
      void guarded(async () => {
        await bridge.request("thread/name/set", { threadId: side.id, name: sideName(question) });
      }, side.id);
      return deliver(side.id, prompt, false);
    },

    sendToSide: (sideId, text) => deliver(sideId, text, false),

    async interruptSide(sideId) {
      const turnId = store.getState().conversations[sideId]?.activeTurnId ?? null;
      if (turnId === null) return;
      await guarded(async () => {
        await bridge.request("turn/interrupt", { threadId: sideId, turnId });
      }, sideId);
    },
  };
}

function evalIncludesTodo(args: unknown, content: unknown): boolean {
  if (object(args) && typeof args["code"] === "string" && /\b(?:tool\.)?todo\s*\(/u.test(args["code"])) return true;
  if (object(args) && Array.isArray(args["toolCalls"]) && args["toolCalls"].some((call) => object(call) && call["name"] === "todo")) return true;
  return Array.isArray(content) && content.some((part) => object(part) && typeof part["text"] === "string" && /\btool\.todo\s*\(/u.test(part["text"]));
}
