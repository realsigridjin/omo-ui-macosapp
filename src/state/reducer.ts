import type { BridgeStatus, HistoryTurn } from "../../shared/ipc";
import {
  emptyConversation,
  settleActiveTurn,
  stopStreaming,
  toSummary,
  updateConversation,
  updateExistingConversation,
  updateTurn,
  wireItems,
} from "./conversation";
import { emptyBtwState, reduceBtw, releaseHeldThread } from "./btw";
import { applyNotification } from "./notifications";
import { reduceSkillCatalog } from "./skills";
import { dropRequest, fillEmptyPreview, pushNotice, upsertThread, withThreads } from "./threads";
import type { AppEvent, AppState, Conversation, ConversationTurn, ThreadSummary } from "./types";
import { parseNotification, parseServerRequest } from "./wire";

export function createInitialState(): AppState {
  return {
    mcp: { servers: [], loading: false, error: null, loadedAt: null },
    bridge: null,
    models: [],
    threads: {},
    threadOrder: [],
    threadsCursor: null,
    threadsLoaded: false,
    activeThreadId: null,
    conversations: {},
    pendingRequests: [],
    notices: [],
    composer: { modelId: null, effort: null },
    skillCatalogs: {},
    loadedSkillCwds: {},
    skillGeneration: 0,
    btw: emptyBtwState(),
    agents: { open: false },
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled app event: ${JSON.stringify(value)}`);
}

function settleAfterDisconnect(conversation: Conversation): Conversation {
  const live = conversation.turns.some((turn) => turn.status === "inProgress" || turn.items.some((entry) => entry.streaming));
  if (!live && !conversation.resumed && conversation.activeTurnId === null && conversation.live.freshness === "unattached") return conversation;
  const turns = live
    ? conversation.turns.map((turn): ConversationTurn => {
        const items = stopStreaming(turn.items);
        if (turn.status !== "inProgress" && items === turn.items) return turn;
        return { ...turn, items, status: turn.status === "inProgress" ? "interrupted" : turn.status };
      })
    : conversation.turns;
  return { ...conversation, turns, resumed: false, activeTurnId: null,
    live: { ...conversation.live, freshness: "stale", generation: conversation.live.generation + 1 } };
}

function applyBridgeStatus(state: AppState, status: BridgeStatus): AppState {
  if (status.state === "connected") {
    return state.bridge?.state === "connected"
      ? { ...state, bridge: status }
      : { ...state, bridge: status, skillCatalogs: {}, loadedSkillCwds: {} };
  }
  let changed = false;
  const conversations: Record<string, Conversation> = {};
  for (const [threadId, conversation] of Object.entries(state.conversations)) {
    const settled = settleAfterDisconnect(conversation);
    changed ||= settled !== conversation;
    conversations[threadId] = settled;
  }
  return {
    ...state,
    bridge: status,
    conversations: changed ? conversations : state.conversations,
    pendingRequests: state.pendingRequests.length === 0 ? state.pendingRequests : [],
    skillCatalogs: {},
    loadedSkillCwds: {},
  };
}

function fromHistoryTurn(turn: HistoryTurn): ConversationTurn {
  return {
    id: turn.id,
    status: turn.status,
    error: turn.error,
    items: wireItems(turn.items, false),
    startedAtMs: turn.startedAt,
    completedAtMs: turn.completedAt,
    origin: "history",
  };
}

function mergeHistory(conversation: Conversation, history: HistoryTurn[]): Conversation {
  const historyTurns = history.map(fromHistoryTurn);
  const historyIds = new Set(historyTurns.map((turn) => turn.id));
  const liveTurns = conversation.turns.filter((turn) => turn.origin === "live" && !historyIds.has(turn.id));
  return { ...conversation, turns: [...historyTurns, ...liveTurns], historyState: "loaded", historyError: null };
}

function applyThreadsListed(state: AppState, event: Extract<AppEvent, { type: "threads/listed" }>): AppState {
  const base: Record<string, ThreadSummary> = event.append
    ? { ...state.threads }
    : Object.fromEntries(Object.entries(state.threads).filter(([id]) => state.conversations[id] !== undefined));
  for (const thread of event.threads) base[thread.id] = toSummary(thread);
  return { ...withThreads(state, base), threadsCursor: event.nextCursor, threadsLoaded: true };
}

export function reduce(state: AppState, event: AppEvent): AppState {
  switch (event.type) {
    case "taskWork/loaded":
      return updateExistingConversation(state, event.threadId, (conversation) =>
        conversation.live.generation !== event.generation ? conversation :
          { ...conversation, live: { ...conversation.live, taskWork: event.work } });
    case "mcp/updated":
      return { ...state, mcp: event.mcp };
    case "bridge/status":
      return applyBridgeStatus(state, event.status);
    case "rpc/notification": {
      const notification = parseNotification(event.notification);
      return notification === null ? state : applyNotification(state, notification, event.receivedAtMs);
    }
    case "rpc/serverRequest": {
      const pending = parseServerRequest(event.request, event.receivedAtMs);
      if (pending === null) {
        return pushNotice(state, {
          id: `server-request:${String(event.request.id)}`,
          level: "error",
          message: `omo sent an unsupported request: ${event.request.method}`,
          threadId: null,
        });
      }
      return { ...state, pendingRequests: [...dropRequest(state, pending.id).pendingRequests, pending] };
    }
    case "rpc/serverRequestAnswered":
      return dropRequest(state, event.id);
    case "models/loaded":
      return { ...state, models: event.models };
    case "skills/loading":
    case "skills/loaded":
    case "skills/failed":
      return reduceSkillCatalog(state, event);
    case "threads/listed":
      return applyThreadsListed(state, event);
    case "thread/opened": {
      const opened = upsertThread(
        event.resumed ? { ...state, loadedSkillCwds: { ...state.loadedSkillCwds, [event.thread.cwd]: true } } : state,
        toSummary(event.thread),
      );
      return updateConversation(releaseHeldThread(opened, event.thread.id), event.thread.id, (conversation) => ({
        ...conversation,
        resumed: event.resumed,
        live: { ...conversation.live, freshness: event.resumed ? "live" : conversation.live.freshness },
        ...(event.session === undefined ? {} : { session: event.session }),
      }));
    }
    case "thread/activated": {
      const { threadId } = event;
      const activated = { ...state, activeThreadId: threadId };
      if (threadId === null || state.conversations[threadId] !== undefined) return activated;
      return { ...activated, conversations: { ...state.conversations, [threadId]: emptyConversation(threadId) } };
    }
    case "history/loading":
      return updateConversation(state, event.threadId, (conversation) => ({
        ...conversation,
        historyState: "loading",
        historyError: null,
      }));
    case "history/annotated":
      return updateExistingConversation(state, event.threadId, (conversation) => ({
        ...conversation,
        annotations: { notices: event.notices, memoryWrites: event.memoryWrites },
      }));
    case "history/loaded":
      return updateExistingConversation(state, event.threadId, (conversation) => ({
        ...mergeHistory(conversation, event.turns),
        annotations: event.notices === undefined && event.memoryWrites === undefined ? conversation.annotations
          : { notices: event.notices ?? [], memoryWrites: event.memoryWrites ?? {} },
        live: { ...conversation.live,
          historicalTasks: event.tasks ?? conversation.live.historicalTasks,
          todo: conversation.live.todo?.source === "live" || event.todo === undefined ? conversation.live.todo :
            event.todo === null ? null : { ...event.todo, source: "history" },
        },
      }));
    case "goal/loaded":
    case "todo/loaded":
      return updateExistingConversation(state, event.threadId, (conversation) => {
        const live = conversation.live;
        if (event.generation !== live.generation ||
          event.revision !== (event.type === "goal/loaded" ? live.goalRevision : live.todoRevision)) return conversation;
        return { ...conversation, live: event.type === "goal/loaded"
          ? { ...live, goal: event.goal, goalRevision: live.goalRevision + 1 }
          : { ...live, todo: event.todo === null ? null : { ...event.todo, source: "live" }, todoRevision: live.todoRevision + 1 } };
      });
    case "history/failed":
      return updateExistingConversation(state, event.threadId, (conversation) => ({
        ...conversation,
        historyState: "error",
        historyError: event.message,
      }));
    case "turn/errorReconciled":
      return updateExistingConversation(state, event.threadId, (conversation) =>
        updateTurn(conversation, event.turn.id, (turn) =>
          turn === event.turn ? { ...turn, error: event.error } : turn,
        ),
      );
    case "turn/settled":
      return updateExistingConversation(state, event.threadId, (conversation) =>
        settleActiveTurn(conversation, event.status, event.settledAtMs),
      );
    case "user/messageSent": {
      const { clientId, text, images, sentAtMs } = event;
      const queued = updateConversation(state, event.threadId, (conversation) => ({
        ...conversation,
        pendingUserMessages: [...conversation.pendingUserMessages, { clientId, text, ...(images === undefined ? {} : { images }), sentAtMs }],
      }));
      return fillEmptyPreview(queued, event.threadId, text);
    }
    case "user/messageFailed": {
      const withoutPending = updateExistingConversation(state, event.threadId, (conversation) => ({
        ...conversation,
        pendingUserMessages: conversation.pendingUserMessages.filter((message) => message.clientId !== event.clientId),
      }));
      return pushNotice(withoutPending, {
        id: `send-failed:${event.clientId}`,
        level: "error",
        message: event.message,
        threadId: event.threadId,
      });
    }
    case "composer/modelSelected":
      return { ...state, composer: { modelId: event.modelId, effort: event.effort, profile: event.profile ?? null } };
    case "notice/pushed":
      return pushNotice(state, event.notice);
    case "notice/dismissed": {
      const notices = state.notices.filter((notice) => notice.id !== event.id);
      return notices.length === state.notices.length ? state : { ...state, notices };
    }
    case "btw/restored":
    case "btw/toggled":
    case "btw/selected":
    case "btw/contextSet":
    case "btw/draftSet":
    case "btw/starting":
    case "btw/started": {
      const reduced = reduceBtw(state, event);
      if (event.type !== "btw/toggled" || !event.open || !state.agents.open) return reduced;
      return { ...reduced, agents: { ...reduced.agents, open: false } };
    }
    case "agents/toggled": {
      if (state.agents.open === event.open) return state;
      const agents = { ...state.agents, open: event.open };
      if (!event.open || !state.btw.open) return { ...state, agents };
      return { ...state, agents, btw: { ...state.btw, open: false } };
    }
    default:
      return assertNever(event);
  }
}
