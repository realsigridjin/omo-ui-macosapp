import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { selectThreadsByWorkspace } from "../../state";
import { useT } from "../../i18n";
import { useActions, useAppSelector } from "../app-context";
import { useUiState } from "../ui-state";
import { ProjectPicker } from "./ProjectPicker";
import type { ProjectPickerBusy } from "./ProjectPicker";
import { projectPicker } from "./picker-store";
import { listProjects } from "./project-list";

/**
 * Renders the project picker while `useNewSessionFlow()` has a request open, and settles that request: with the new
 * thread id once a thread started in the chosen project or in a newly picked folder, or with null when dismissed.
 * A failed start leaves the picker open; the failure is already a notice. Mount once beside `<SettingsDialog/>`.
 */
export function ProjectPickerHost() {
  const open = useSyncExternalStore(projectPicker.subscribe, projectPicker.isOpen);
  useEffect(() => projectPicker.registerHost(), []);
  return open ? <OpenProjectPicker /> : null;
}

function OpenProjectPicker() {
  const t = useT();
  const actions = useActions();
  const groups = useAppSelector(selectThreadsByWorkspace);
  const connected = useAppSelector((state) => state.bridge?.state === "connected");
  const { preferences } = useUiState();
  const lastWorkspace = preferences?.lastWorkspace ?? null;
  const recentWorkspaces = preferences?.recentWorkspaces;
  const projects = useMemo(() => listProjects(groups, recentWorkspaces ?? []), [groups, recentWorkspaces]);
  const [busy, setBusy] = useState<ProjectPickerBusy | null>(null);

  const start = async (cwd: string): Promise<void> => {
    setBusy("starting");
    const threadId = await actions.newThread(cwd);
    if (threadId === null) setBusy(null);
    else projectPicker.settle(threadId);
  };

  const startInNewProject = async (): Promise<void> => {
    setBusy("picking");
    let cwd: string | null;
    try {
      cwd = await window.omo.pickDirectory(lastWorkspace);
    } finally {
      setBusy(null);
    }
    if (cwd !== null) await start(cwd);
  };

  return (
    <ProjectPicker
      open
      projects={projects}
      lastWorkspace={lastWorkspace}
      busy={busy}
      unavailable={connected ? null : t("shell.newSessionDisconnected")}
      onContinue={(cwd) => void start(cwd)}
      onNewProject={() => void startInNewProject()}
      onClose={() => projectPicker.settle(null)}
    />
  );
}
