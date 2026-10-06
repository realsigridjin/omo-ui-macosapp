import { useEffect, useState } from "react";
import type { GitInfo } from "../../../shared/ipc";
import { useAppSelector } from "../app-context";
import type { AppState } from "../../state";

/** Window event dispatched after UI-side git writes so every mounted git view re-reads its facts. */
export const GIT_REFRESH_EVENT = "omo:git-refresh";

/** Bumps whenever any thread's turn finishes; git facts refresh after each completed turn. */
function selectCompletedTurnCount(state: AppState): number {
  let count = 0;
  for (const conversation of Object.values(state.conversations)) {
    for (const turn of conversation.turns) if (turn.status === "completed") count += 1;
  }
  return count;
}

/**
 * Git facts of `cwd`, refreshed when the thread changes, after each completed turn, and on every
 * `GIT_REFRESH_EVENT`. Resolves null while loading or when the directory is not a git work tree;
 * stale facts from a previous cwd are never shown.
 */
export function useGitInfo(cwd: string | null): GitInfo | null {
  const [entry, setEntry] = useState<{ cwd: string; info: GitInfo | null } | null>(null);
  const completedTurns = useAppSelector(selectCompletedTurnCount);

  useEffect(() => {
    if (cwd === null) return;
    let current = true;
    const read = (): void => {
      window.omo
        .gitInfo(cwd)
        .then((info) => {
          if (current) setEntry({ cwd, info });
        })
        .catch((error: unknown) => {
          if (current) {
            console.warn("Could not read git facts", error);
            setEntry({ cwd, info: null });
          }
        });
    };
    read();
    window.addEventListener(GIT_REFRESH_EVENT, read);
    return () => {
      current = false;
      window.removeEventListener(GIT_REFRESH_EVENT, read);
    };
  }, [cwd, completedTurns]);

  return entry !== null && entry.cwd === cwd ? entry.info : null;
}
