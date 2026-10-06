import type { Thread, ThreadItem, Turn, TurnStatus, UserMessageItem } from "../../shared/protocol";
import type { AppState, Conversation, ConversationItem, ConversationTurn, ThreadSummary } from "./types";
import { parseItem } from "./wire";
import { emptyLiveState } from "./live";

export function emptyConversation(threadId: string): Conversation {
  return {
    threadId,
    historyState: "idle",
    historyError: null,
    turns: [],
    activeTurnId: null,
    resumed: false,
    pendingUserMessages: [],
    live: emptyLiveState(),
    annotations: { notices: [], memoryWrites: {} },
  };
}

export function toMs(seconds: number | null | undefined): number | null {
  return typeof seconds === "number" ? Math.round(seconds * 1000) : null;
}

export function toSummary(thread: Thread): ThreadSummary {
  return {
    id: thread.id,
    cwd: thread.cwd,
    name: thread.name ?? null,
    preview: thread.preview,
    updatedAt: Math.round(thread.updatedAt * 1000),
    status: thread.status,
    path: thread.path ?? null,
    source: thread.source ?? null,
  };
}

/** Applies `update` to a thread's conversation; a missing conversation is created only when `update` changes it. */
export function updateConversation(
  state: AppState,
  threadId: string,
  update: (conversation: Conversation) => Conversation,
): AppState {
  const current = state.conversations[threadId] ?? emptyConversation(threadId);
  const next = update(current);
  if (next === current) return state;
  return { ...state, conversations: { ...state.conversations, [threadId]: next } };
}

export function updateExistingConversation(
  state: AppState,
  threadId: string,
  update: (conversation: Conversation) => Conversation,
): AppState {
  return state.conversations[threadId] === undefined ? state : updateConversation(state, threadId, update);
}

function replaceAt<T>(list: T[], index: number, value: T): T[] {
  const copy = list.slice();
  copy[index] = value;
  return copy;
}

export function updateTurn(
  conversation: Conversation,
  turnId: string,
  update: (turn: ConversationTurn) => ConversationTurn,
): Conversation {
  const index = conversation.turns.findIndex((turn) => turn.id === turnId);
  const turn = conversation.turns[index];
  if (turn === undefined) return conversation;
  const next = update(turn);
  return next === turn ? conversation : { ...conversation, turns: replaceAt(conversation.turns, index, next) };
}

export function wireItems(items: ThreadItem[], streaming: boolean): ConversationItem[] {
  return items.flatMap((raw) => {
    const item = parseItem(raw);
    return item === null ? [] : [{ item, streaming, startedAtMs: null, completedAtMs: null }];
  });
}

export function fromWireTurn(turn: Turn, receivedAtMs: number): ConversationTurn {
  return {
    id: turn.id,
    status: turn.status,
    error: turn.error ?? null,
    items: wireItems(turn.items, false),
    startedAtMs: toMs(turn.startedAt) ?? receivedAtMs,
    completedAtMs: toMs(turn.completedAt),
    origin: "live",
  };
}

export function ensureTurn(conversation: Conversation, turnId: string, startedAtMs: number): Conversation {
  if (conversation.turns.some((turn) => turn.id === turnId)) return conversation;
  const turn: ConversationTurn = {
    id: turnId,
    status: "inProgress",
    error: null,
    items: [],
    startedAtMs,
    completedAtMs: null,
    origin: "live",
  };
  return { ...conversation, turns: [...conversation.turns, turn], activeTurnId: conversation.activeTurnId ?? turnId };
}

export function findItem(turn: ConversationTurn, itemId: string): ConversationItem | undefined {
  return turn.items.find((entry) => entry.item.id === itemId);
}

export function upsertItem(turn: ConversationTurn, entry: ConversationItem): ConversationTurn {
  const index = turn.items.findIndex((existing) => existing.item.id === entry.item.id);
  const items = index < 0 ? [...turn.items, entry] : replaceAt(turn.items, index, entry);
  return { ...turn, items };
}

export function updateItem(
  turn: ConversationTurn,
  itemId: string,
  update: (entry: ConversationItem) => ConversationItem,
): ConversationTurn {
  const index = turn.items.findIndex((entry) => entry.item.id === itemId);
  const entry = turn.items[index];
  if (entry === undefined) return turn;
  const next = update(entry);
  return next === entry ? turn : { ...turn, items: replaceAt(turn.items, index, next) };
}

export function appendAt(parts: string[], index: number, delta: string): string[] {
  const copy = parts.slice();
  while (copy.length <= index) copy.push("");
  copy[index] = (copy[index] ?? "") + delta;
  return copy;
}

/**
 * Ends every turn still marked inProgress with `status` and clears `activeTurnId`. Used when omo reports the thread is no
 * longer active but this client never received the turn's turn/completed (omo sends that only to subscribed connections,
 * while thread/status/changed is broadcast). A later turn/completed still overwrites the status it reports.
 */
export function settleActiveTurn(conversation: Conversation, status: Exclude<TurnStatus, "inProgress">, completedAtMs: number): Conversation {
  if (conversation.activeTurnId === null && !conversation.turns.some((turn) => turn.status === "inProgress")) return conversation;
  const turns = conversation.turns.map((turn): ConversationTurn =>
    turn.status === "inProgress" ? { ...turn, status, completedAtMs: turn.completedAtMs ?? completedAtMs, items: stopStreaming(turn.items) } : turn,
  );
  return { ...conversation, turns, activeTurnId: null };
}

export function stopStreaming(items: ConversationItem[]): ConversationItem[] {
  return items.some((entry) => entry.streaming)
    ? items.map((entry) => (entry.streaming ? { ...entry, streaming: false } : entry))
    : items;
}

/** Drops the pending message echoed by `item`: by clientId, or the oldest identical text when clientId is null. */
export function settlePendingMessage(conversation: Conversation, item: UserMessageItem): Conversation {
  const pending = conversation.pendingUserMessages;
  if (pending.length === 0) return conversation;
  const clientId = item.clientId ?? null;
  const text = item.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  const index =
    clientId === null
      ? pending.findIndex((message) => message.text === text)
      : pending.findIndex((message) => message.clientId === clientId);
  if (index < 0) return conversation;
  return { ...conversation, pendingUserMessages: pending.filter((_, position) => position !== index) };
}
