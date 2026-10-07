import type { LiveTask } from "../../../shared/protocol";
import type { ConversationItem, ConversationTurn } from "../../state";
import { isHistoricalTask, type ActivityTask } from "./activity-model";

/** The item range a completed turn folds into its "Worked for …" summary; `end` is exclusive. */
export interface TurnFold {
  start: number;
  end: number;
  durationMs: number | null;
}

/** Index of the last agent message, or -1 when the turn has none. */
export function lastAgentMessageIndex(items: readonly ConversationItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]?.item.type === "agentMessage") return index;
  }
  return -1;
}

function itemSpanMs(items: readonly ConversationItem[], from: number, to: number): number | null {
  let first: number | null = null;
  let last: number | null = null;
  for (let index = from; index < to; index += 1) {
    for (const at of [items[index]?.startedAtMs, items[index]?.completedAtMs]) {
      if (at === null || at === undefined) continue;
      if (first === null || at < first) first = at;
      if (last === null || at > last) last = at;
    }
  }
  return first === null || last === null ? null : Math.max(0, last - first);
}

/**
 * A completed turn folds every item between its first user message and its last agent message into one
 * "Worked for <turn duration>" row: the prompt and the final answer stay visible. Turns still running, turns
 * without a final answer, and turns with nothing between the two keep their items expanded.
 */
export function turnFold(turn: ConversationTurn): TurnFold | null {
  if (turn.status !== "completed") return null;
  const firstUser = turn.items.findIndex((entry) => entry.item.type === "userMessage");
  const lastAgent = lastAgentMessageIndex(turn.items);
  if (firstUser < 0 || lastAgent < firstUser + 2) return null;
  const span =
    turn.startedAtMs !== null && turn.completedAtMs !== null
      ? Math.max(0, turn.completedAtMs - turn.startedAtMs)
      : itemSpanMs(turn.items, firstUser, lastAgent + 1);
  return { start: firstUser + 1, end: lastAgent, durationMs: span };
}

/** What the transcript's muted waiting line says: omo has not begun this turn's work yet. */
export type WaitingPhase = "startingSession" | "waitingModel";

function hasAgentWork(turn: ConversationTurn): boolean {
  return turn.items.some((entry) => entry.item.type !== "userMessage");
}

/**
 * The waiting line's phase as of the caller's state: "startingSession" while a sent message has no turn on omo
 * yet, "waitingModel" once the turn started but no item beyond its prompt has arrived, null once work shows.
 */
export function waitingPhase(turn: ConversationTurn | null, hasPendingUserMessage: boolean): WaitingPhase | null {
  if (turn !== null) return turn.status === "inProgress" && !hasAgentWork(turn) ? "waitingModel" : null;
  return hasPendingUserMessage ? "startingSession" : null;
}

/**
 * `created_at` is second-truncated while `startedAtMs` is millisecond precise, so containment allows two
 * seconds of slack on both ends. Restored tasks carry no timestamps and stay in the activity panel.
 */
export function tasksInTurn(tasks: readonly ActivityTask[], turn: ConversationTurn): LiveTask[] {
  const start = turn.startedAtMs;
  if (start === null) return [];
  const from = start - 2_000;
  const to = (turn.completedAtMs ?? Number.POSITIVE_INFINITY) + 2_000;
  return tasks.filter((task): task is LiveTask => {
    if (isHistoricalTask(task)) return false;
    const at = Date.parse(task.created_at);
    return !Number.isNaN(at) && at >= from && at <= to;
  });
}
