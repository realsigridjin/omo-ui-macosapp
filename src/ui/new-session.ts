import { useCallback, useContext } from "react";
import { useT } from "../i18n";
import { selectThreadsByWorkspace } from "../state";
import { StoreContext, useActions } from "./app-context";
import { projectPicker } from "./projects/picker-store";
import { listProjects } from "./projects/project-list";
import { uiState } from "./ui-state";

/**
 * The new-session flow. While a `<ProjectPickerHost/>` is mounted and a project is known (a workspace with
 * threads, or a recent workspace), the project picker opens: the user continues in a listed project or picks a
 * folder for a new one. Otherwise the native folder picker opens directly, defaulting to the last workspace.
 * Either way a thread is started and activated in the chosen directory. Resolves the new thread id, or null
 * when the choice was cancelled or the start failed (the failure is already a notice).
 */
export function useNewSessionFlow(): () => Promise<string | null> {
  const actions = useActions();
  const store = useContext(StoreContext);
  const t = useT();
  return useCallback(async () => {
    if (store !== null && store.getState().bridge?.state !== "connected") {
      store.dispatch({
        type: "notice/pushed",
        notice: { id: crypto.randomUUID(), level: "error", message: t("shell.newSessionDisconnected"), threadId: null },
      });
      return null;
    }
    // actions.newThread records the workspace through the bridge alone, so the copy in uiState can be behind.
    const preferences = await window.omo.getPreferences();
    uiState.setPreferences(preferences);
    if (store !== null && projectPicker.hasHost()) {
      const groups = selectThreadsByWorkspace(store.getState());
      if (listProjects(groups, preferences.recentWorkspaces).length > 0) return projectPicker.request();
    }
    const cwd = await window.omo.pickDirectory(preferences.lastWorkspace);
    if (cwd === null) return null;
    return actions.newThread(cwd);
  }, [actions, store, t]);
}
