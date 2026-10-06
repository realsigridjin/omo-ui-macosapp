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
import { ThreadNotifications } from "./ui/notices/ThreadNotifications";
import { ConnectionBanner } from "./ui/onboarding/ConnectionBanner";
import { Onboarding } from "./ui/onboarding/Onboarding";
import { SettingsPage } from "./ui/settings/SettingsPage";
import { AppFrame } from "./ui/shell/AppFrame";
import { Sidebar } from "./ui/sidebar/Sidebar";
import { applyColorTheme, applyThemePreference } from "./ui/theme";
import { uiState, useUiState } from "./ui/ui-state";
import { SetupWizard } from "./ui/wizard/SetupWizard";

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

function Shell() {
  const bridgeState = useAppSelector((state) => state.bridge?.state ?? null);
  const sidePanelOpen = useAppSelector((state) => state.btw.open);
  useSidePanelShortcut();
  const { sidebarVisible, sidebarWidth, onboardingOpen } = useUiState();
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
        rightPanel={sidePanelOpen ? renderSidePanel : null}
        rightPanelWidth={SIDE_PANEL_WIDTH}
      />
      <SettingsPage />
      {onboardingOpen && <SetupWizard />}
      <ThreadNotifications />
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
        if (!loaded.onboardingCompleted) uiState.setOnboardingOpen(true);
        store.dispatch({ type: "composer/modelSelected", modelId: loaded.modelId, effort: null, profile: loaded.modelProfile });
      }
    });
    return () => {
      current = false;
    };
  }, []);

  const models = useSyncExternalStore(store.subscribe, () => store.getState().models);
  useEffect(() => {
    const profile = store.getState().composer.profile;
    if (!profile || models.length === 0) return;
    const resolved = resolveProfile(models, profile);
    store.dispatch({ type: "composer/modelSelected", modelId: resolved.model?.id ?? null, effort: resolved.effort, profile });
  }, [models, store, preferences?.modelProfile]);

  const theme = preferences?.theme ?? "system";
  useEffect(() => applyThemePreference(theme), [theme]);

  const colorTheme = preferences?.colorTheme ?? "omo";
  useEffect(() => applyColorTheme(colorTheme), [colorTheme]);

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
