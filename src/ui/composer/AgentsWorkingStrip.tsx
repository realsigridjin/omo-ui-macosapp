import { StateDot } from "@deepseek-ai/dsh-client-ui-primitives";
import { selectDagRuns, selectTasks, selectThreadLiveState } from "../../state";
import { useT } from "../../i18n";
import { useActions, useAppSelector } from "../app-context";
import { workSummary } from "../conversation/activity-model";
import { TESTID } from "../testids";
import css from "./AgentsWorkingStrip.module.css";

function Strip({ threadId }: { threadId: string }) {
  const t = useT();
  const actions = useActions();
  const runs = useAppSelector((state) => selectDagRuns(state, threadId));
  const tasks = useAppSelector((state) => selectTasks(state, threadId));
  const live = useAppSelector((state) => selectThreadLiveState(state, threadId)?.freshness === "live");
  const { running } = workSummary(runs, tasks, live);
  if (running === 0) return null;
  return (
    <div className={css.strip} data-testid={TESTID.agentsWorkingStrip} role="status">
      <StateDot state="ongoing" size={8} />
      <span className={css.label}>{t(running === 1 ? "composer.agentWorking" : "composer.agentsWorking", { count: running })}</span>
      <button type="button" className={css.stop} data-testid={TESTID.agentsWorkingStop} onClick={() => void actions.interrupt()}>
        {t("composer.stop")}
      </button>
    </div>
  );
}

/** A thin bar over the composer while the active session's agents or child tasks run; Stop interrupts the turn. */
export function AgentsWorkingStrip() {
  const threadId = useAppSelector((state) => state.activeThreadId);
  return threadId === null ? null : <Strip threadId={threadId} />;
}
