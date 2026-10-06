import type { DagRun, LiveTask, Model, WireGoal } from "../../shared/protocol";
import type { HistoricalTask } from "../../shared/ipc";
import type { AppState, Conversation, PendingRequest, SessionModel, SkillCatalog, ThreadSummary, ThreadLiveState } from "./types";
import { EMPTY_SKILL_CATALOG } from "./skills";
import { isSideThread } from "./btw";

/** Returns a stable idle catalog when this cwd has not been requested. */
export function selectSkillCatalog(state: AppState, cwd: string): SkillCatalog {
  return state.skillCatalogs[cwd] ?? EMPTY_SKILL_CATALOG;
}

export interface WorkspaceGroup {
  cwd: string;
  label: string;
  threads: ThreadSummary[];
}

export function selectActiveConversation(state: AppState): Conversation | null {
  return state.activeThreadId === null ? null : (state.conversations[state.activeThreadId] ?? null);
}

/** The active thread's workspace directory, or null with no active thread or an unknown cwd. */
export function selectActiveCwd(state: AppState): string | null {
  return state.activeThreadId === null ? null : (state.threads[state.activeThreadId]?.cwd ?? null);
}

export function selectThreadLiveState(state: AppState, threadId: string): ThreadLiveState | null {
  return state.conversations[threadId]?.live ?? null;
}
const EMPTY_RUNS: DagRun[] = [];
const EMPTY_TASKS: (LiveTask | HistoricalTask)[] = [];
const runSelections = new WeakMap<ThreadLiveState, DagRun[]>();
const taskSelections = new WeakMap<ThreadLiveState, (LiveTask | HistoricalTask)[]>();
export function selectDagRuns(state: AppState, threadId: string): DagRun[] {
  const live = selectThreadLiveState(state, threadId);
  if (live === null) return EMPTY_RUNS;
  const cached = runSelections.get(live);
  if (cached !== undefined) return cached;
  const result = live.runOrder.flatMap((id) => live.runs[id] === undefined ? [] : [live.runs[id]]);
  runSelections.set(live, result);
  return result;
}
/**
 * Unattached threads show history. Attached threads show the live roster in roster order, then history-only tasks:
 * omo expires old task records, so a resumed session's roster can omit tasks its session file still lists.
 * A live record replaces the history entry with the same task_id.
 */
export function selectTasks(state: AppState, threadId: string): (LiveTask | HistoricalTask)[] {
  const live = selectThreadLiveState(state, threadId);
  if (live === null) return EMPTY_TASKS;
  if (live.freshness === "unattached") return live.historicalTasks;
  const cached = taskSelections.get(live);
  if (cached !== undefined) return cached;
  const roster = live.taskOrder.flatMap((id) => live.tasks[id] === undefined ? [] : [live.tasks[id]]);
  const result = [...roster, ...live.historicalTasks.filter((task) => live.tasks[task.task_id] === undefined)];
  taskSelections.set(live, result);
  return result;
}
export function selectTodo(state: AppState, threadId: string): ThreadLiveState["todo"] {
  return selectThreadLiveState(state, threadId)?.todo ?? null;
}
export function selectGoal(state: AppState, threadId: string): WireGoal | null | undefined {
  return selectThreadLiveState(state, threadId)?.goal;
}
export function selectDagActivity(state: AppState, threadId: string, runId: string, nodeId: string) {
  return selectThreadLiveState(state, threadId)?.dagActivity[runId]?.[nodeId] ?? null;
}

function workspaceLabel(cwd: string): string {
  const segments = cwd.split("/").filter((segment) => segment.length > 0);
  return segments.at(-1) ?? cwd;
}

interface GroupCache {
  threads: AppState["threads"];
  order: string[];
  sides: AppState["btw"]["sides"];
  unclaimed: AppState["btw"]["unclaimed"];
  groups: WorkspaceGroup[];
}

let groupCache: GroupCache | null = null;

/**
 * Groups main threads by cwd, groups ordered by their newest thread; side chat threads are left out. Memoized so the
 * result is stable for unchanged threads and side chats.
 */
export function selectThreadsByWorkspace(state: AppState): WorkspaceGroup[] {
  const { sides, unclaimed } = state.btw;
  if (
    groupCache !== null && groupCache.threads === state.threads && groupCache.order === state.threadOrder &&
    groupCache.sides === sides && groupCache.unclaimed === unclaimed
  ) {
    return groupCache.groups;
  }
  const groups = new Map<string, WorkspaceGroup>();
  for (const id of state.threadOrder) {
    const summary = state.threads[id];
    if (summary === undefined || isSideThread(state, summary)) continue;
    const group = groups.get(summary.cwd);
    if (group === undefined) groups.set(summary.cwd, { cwd: summary.cwd, label: workspaceLabel(summary.cwd), threads: [summary] });
    else group.threads.push(summary);
  }
  groupCache = { threads: state.threads, order: state.threadOrder, sides, unclaimed, groups: [...groups.values()] };
  return groupCache.groups;
}

const pendingCache = new Map<string, { source: PendingRequest[]; result: PendingRequest[] }>();

/** Pending requests for one thread, oldest first; memoized per thread so the result is stable while requests are unchanged. */
export function selectPendingRequestsForThread(state: AppState, threadId: string): PendingRequest[] {
  const cached = pendingCache.get(threadId);
  if (cached !== undefined && cached.source === state.pendingRequests) return cached.result;
  const result = state.pendingRequests.filter((request) => request.threadId === threadId);
  pendingCache.set(threadId, { source: state.pendingRequests, result });
  return result;
}

export function selectActiveSessionModel(state: AppState): SessionModel | null {
  return selectActiveConversation(state)?.session ?? null;
}

/**
 * The model the composer targets: the user's pick when it is in the catalog, else the active thread's model as omo
 * reported it (matched by provider/model id, then by model name), else null so the UI names omo's own default.
 * model/list marks one default per provider, so its isDefault flags cannot identify the model omo will run.
 */
export function resolveComposerModel(models: readonly Model[], modelId: string | null, session: SessionModel | null): Model | null {
  if (modelId !== null) {
    const selected = models.find((model) => model.id === modelId);
    if (selected !== undefined) return selected;
  }
  if (session === null) return null;
  return (
    models.find((model) => model.id === `${session.modelProvider}/${session.model}`) ??
    models.find((model) => model.model === session.model) ??
    null
  );
}

export function selectIsTurnActive(state: AppState, threadId: string | null = state.activeThreadId): boolean {
  return threadId !== null && (state.conversations[threadId]?.activeTurnId ?? null) !== null;
}
