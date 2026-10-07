import { resolveProfile } from "./ui/composer/model-profiles";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createActions, createAppStore, localSideStorage } from "./state";
import { I18nProvider, resolveLocale } from "./i18n";
import { ActionsContext, StoreContext, useAppSelector } from "./ui/app-context";
import { SIDE_PANEL_WIDTH, SidePanel } from "./ui/btw/SidePanel";
import { useSidePanelShortcut } from "./ui/btw/SideToggle";
import { Composer } from "./ui/composer/Composer";
import { ConversationPane } from "./ui/conversation/ConversationPane";
import { useNewSessionFlow } from "./ui/new-session";
import { NoticeToasts } from "./ui/notices/NoticeToasts";
import { ConnectionBanner } from "./ui/onboarding/ConnectionBanner";
import { Onboarding } from "./ui/onboarding/Onboarding";
import { SettingsDialog } from "./ui/settings/SettingsDialog";
import { AppFrame } from "./ui/shell/AppFrame";
import { Sidebar } from "./ui/sidebar/Sidebar";
import { applyThemePreference } from "./ui/theme";
import { uiState, useUiState } from "./ui/ui-state";
import { WorkspacePanel } from "./ui/workspace/WorkspacePanel";
import { ProjectPickerHost } from "./ui/projects/ProjectPickerHost";

function MainPane() {
  return (
    <>
      <ConnectionBanner />
      <ConversationPane />
      <Composer />
    </>
  );
}

const renderSidePanel = (placement: "docked" | "overlay") => <SidePanel placement={placement} />;
const renderWorkspacePanel = (placement: "docked" | "overlay") => <WorkspacePanel placement={placement} onClose={() => uiState.setWorkspacePanelOpen(false)} />;

function Shell() {
  const bridgeState = useAppSelector((state) => state.bridge?.state ?? null);
  const sidePanelOpen = useAppSelector((state) => state.btw.open);
  useSidePanelShortcut();
  const { sidebarVisible, sidebarWidth, workspacePanelOpen } = useUiState();
  const newSession = useNewSessionFlow();

  useEffect(() => {
    const root = document.documentElement;
    if (bridgeState === null) delete root.dataset["bridgeState"];
    else root.dataset["bridgeState"] = bridgeState;
  }, [bridgeState]);

  useEffect(
    () =>
      window.omo.onMenuCommand((command) => {
        switch (command) {
          case "settings":
            uiState.setSettingsOpen(true);
            break;
          case "new-session":
            void newSession();
            break;
          case "toggle-sidebar":
            uiState.toggleSidebar();
            break;
        }
      }),
    [newSession],
  );

  if (bridgeState === "not-found") {
    return (
      <>
        <Onboarding />
        <NoticeToasts />
      </>
    );
  }
  return (
    <>
      <AppFrame
        sidebar={<Sidebar />}
        main={<MainPane />}
        sidebarVisible={sidebarVisible}
        sidebarWidth={sidebarWidth}
        onSidebarWidthChange={uiState.setSidebarWidth}
        rightPanel={workspacePanelOpen ? renderWorkspacePanel : sidePanelOpen ? renderSidePanel : null}
        rightPanelWidth={workspacePanelOpen ? 440 : SIDE_PANEL_WIDTH}
      />
      <SettingsDialog />
      <ProjectPickerHost />
      <NoticeToasts />
    </>
  );
}

export function App() {
  const store = useMemo(() => createAppStore(), []);
  const actions = useMemo(() => createActions(store, window.omo, { sideStorage: localSideStorage() }), [store]);
  const { preferences } = useUiState();

  useEffect(() => actions.connect(), [actions]);

  useEffect(() => {
    let current = true;
    void window.omo.getPreferences().then((loaded) => {
      if (current) {
        uiState.setPreferences(loaded);
        store.dispatch({ type: "composer/modelSelected", modelId: loaded.modelId, effort: null, profile: loaded.modelProfile });
      }
    });
    return () => {
      current = false;
    };
  }, []);

  const models = useSyncExternalStore(store.subscribe, () => store.getState().models);
  const profile = useSyncExternalStore(store.subscribe, () => store.getState().composer.profile);
  useEffect(() => {
    if (!profile || models.length === 0) return;
    const resolved = resolveProfile(models, profile, preferences?.profileModels);
    store.dispatch({ type: "composer/modelSelected", modelId: resolved.model?.id ?? null, effort: resolved.effort, profile });
  }, [models, store, profile, preferences?.profileModels]);

  const theme = preferences?.theme ?? "system";
  useEffect(() => applyThemePreference(theme), [theme]);

  const locale = resolveLocale(preferences?.locale ?? "system", navigator.language);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <StoreContext.Provider value={store}>
      <ActionsContext.Provider value={actions}>
        <I18nProvider locale={locale}>
          <Shell />
        </I18nProvider>
      </ActionsContext.Provider>
    </StoreContext.Provider>
  );
}
