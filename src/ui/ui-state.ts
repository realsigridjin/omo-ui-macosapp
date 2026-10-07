import { useSyncExternalStore } from "react";
import type { Preferences } from "../../shared/ipc";

export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_DEFAULT_WIDTH = 280;

export interface UiState {
  workspacePanelOpen: boolean;
  settingsOpen: boolean;
  sidebarVisible: boolean;
  sidebarWidth: number;
  /** Last preferences read from or written through the bridge; null until the first load. */
  preferences: Preferences | null;
}

let state: UiState = {
  workspacePanelOpen: false,
  settingsOpen: false,
  sidebarVisible: true,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  preferences: null,
};
const listeners = new Set<() => void>();

function update(patch: Partial<UiState>): void {
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export const uiState = {
  setWorkspacePanelOpen: (workspacePanelOpen: boolean): void => update({ workspacePanelOpen }),
  get: (): UiState => state,
  subscribe,
  setSettingsOpen: (settingsOpen: boolean): void => update({ settingsOpen }),
  setSidebarVisible: (sidebarVisible: boolean): void => update({ sidebarVisible }),
  toggleSidebar: (): void => update({ sidebarVisible: !state.sidebarVisible }),
  setSidebarWidth: (width: number): void => update({ sidebarWidth: clampSidebarWidth(width) }),
  /** Records preferences loaded from the bridge or returned by `setPreferences`; App.tsx re-applies theme and locale from it. */
  setPreferences: (preferences: Preferences): void => update({ preferences }),
};

export function useUiState(): UiState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Writes a preferences patch through the bridge and records the stored result. */
export async function updatePreferences(patch: Partial<Preferences>): Promise<Preferences> {
  const next = await window.omo.setPreferences(patch);
  uiState.setPreferences(next);
  return next;
}
