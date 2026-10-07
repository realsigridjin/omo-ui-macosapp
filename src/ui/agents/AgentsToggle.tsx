import { useEffect } from "react";
import { IconAgentPresetOutlineRegular, Tooltip } from "@deepseek-ai/dsh-client-ui-primitives";
import { useT } from "../../i18n";
import { selectDagRuns, selectTasks, selectThreadLiveState, useAppStore } from "../../state";
import { workSummary } from "../conversation/activity-model";
import { useActions, useAppSelector } from "../app-context";
import { TESTID } from "../testids";
import css from "./AgentsPanel.module.css";

/** ⇧⌘A toggles the Agents panel from anywhere in the window. */
export function useAgentsPanelShortcut(): void {
  const actions = useActions();
  const store = useAppStore();
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (!event.metaKey || !event.shiftKey || event.ctrlKey || event.altKey || event.isComposing) return;
      if (event.key.toLowerCase() !== "a") return;
      event.preventDefault();
      actions.setAgentsPanel(!store.getState().agents.open);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [actions, store]);
}

/**
 * The Agents panel toggle at the end of the conversation header; the blue badge counts this conversation's
 * running agents (DAG nodes plus unlinked tasks while the bridge is live).
 */
export function AgentsToggle() {
  const t = useT();
  const actions = useActions();
  const open = useAppSelector((state) => state.agents.open);
  const runs = useAppSelector((state) => (state.activeThreadId === null ? [] : selectDagRuns(state, state.activeThreadId)));
  const tasks = useAppSelector((state) => (state.activeThreadId === null ? [] : selectTasks(state, state.activeThreadId)));
  const live = useAppSelector((state) =>
    state.activeThreadId === null ? "unattached" : (selectThreadLiveState(state, state.activeThreadId)?.freshness ?? "unattached"),
  );
  const running = workSummary(runs, tasks, live === "live").running;
  return (
    <Tooltip label={t("agents.toggleHint")} side="bottom" delayMs={500}>
      <button
        type="button"
        className={css.toggle}
        data-testid={TESTID.agentsToggle}
        aria-pressed={open}
        aria-label={running > 0 ? t("agents.toggleAria", { running }) : t("agents.toggle")}
        onClick={() => actions.setAgentsPanel(!open)}
      >
        <IconAgentPresetOutlineRegular size={16} />
        {running > 0 && (
          <span className={css.badge} data-testid={TESTID.agentsBadge}>
            {running}
          </span>
        )}
      </button>
    </Tooltip>
  );
}
