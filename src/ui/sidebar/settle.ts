import type { ThreadSummary, WorkspaceGroup } from "../../state";
import { isRunning } from "./thread-filter";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The settle-related preferences, as the sidebar renders them. */
export interface SettleConfig {
  autoSettle: boolean;
  autoSettleDays: number;
  /** Thread ids the user settled manually. */
  settledThreads: readonly string[];
  /** Thread ids the user unsettled manually, blocking auto-settle until their next activity. */
  unsettledThreads: readonly string[];
}

/**
 * Whether a thread reads as settled: manually settled always wins; otherwise auto-settle settles an idle,
 * non-running thread whose last activity is `autoSettleDays` or more ago, unless the user unsettled it.
 */
export function isThreadSettled(thread: ThreadSummary, config: SettleConfig, nowMs: number): boolean {
  if (config.settledThreads.includes(thread.id)) return true;
  if (!config.autoSettle || config.unsettledThreads.includes(thread.id)) return false;
  if (isRunning(thread)) return false;
  return nowMs - thread.updatedAt >= config.autoSettleDays * DAY_MS;
}

/** Splits workspace groups into the unsettled groups (groups left empty are dropped) and the flat settled list. */
export function partitionSettled(
  groups: readonly WorkspaceGroup[],
  config: SettleConfig,
  nowMs: number,
): { groups: WorkspaceGroup[]; settled: ThreadSummary[] } {
  const active: WorkspaceGroup[] = [];
  const settled: ThreadSummary[] = [];
  for (const group of groups) {
    const remaining: ThreadSummary[] = [];
    for (const thread of group.threads) {
      if (isThreadSettled(thread, config, nowMs)) settled.push(thread);
      else remaining.push(thread);
    }
    if (remaining.length > 0) active.push(remaining.length === group.threads.length ? group : { ...group, threads: remaining });
  }
  return { groups: active, settled };
}
