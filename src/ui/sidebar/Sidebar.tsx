import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import clsx from "clsx";
import {
  IconChevronDownOutlineRegular,
  IconDataOutlineMedium,
  IconCloseCircleFillRegular,
  IconPanelLeftOutlineRegular,
  IconQueueOutlineRegular,
  IconSearchOutlineRegular,
  IconSettingsOutlineMedium,
  Pill,
  StateDot,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { StateDotState } from "@deepseek-ai/dsh-client-ui-primitives";
import type { BridgeState, BridgeStatus } from "../../../shared/ipc";
import { selectThreadsByWorkspace } from "../../state";
import type { ThreadSummary, WorkspaceGroup } from "../../state";
import { useT } from "../../i18n";
import { StoreContext, useActions, useAppSelector } from "../app-context";
import { APP_VERSION, isPreRelease } from "../app-version";
import { threadTitle } from "../conversation/format";
import { BrandMark, PlusCircleGlyph } from "../glyphs";
import { useNewSessionFlow } from "../new-session";
import { TESTID } from "../testids";
import { uiState, updatePreferences, useUiState } from "../ui-state";
import { DeleteThreadDialog } from "./DeleteThreadDialog";
import type { DeleteTarget } from "./DeleteThreadDialog";
import { ThreadRow, WorkspaceRow } from "./Rows";
import { filterGroups, isRunning } from "./thread-filter";
import type { ThreadPeriod } from "./thread-filter";
import { partitionSettled, type SettleConfig } from "./settle";
import css from "./Sidebar.module.css";

const DOT_STATE: Record<BridgeState, StateDotState> = {
  locating: "ongoing",
  starting: "ongoing",
  restarting: "ongoing",
  connected: "done",
  exited: "error",
  "not-found": "error",
  stopped: "idle",
};

const CLOCK_TICK_MS = 30_000;

const PERIODS: readonly Exclude<ThreadPeriod, "any">[] = ["today", "week", "month"];

function useNowMs(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** Drops threads whose last activity moved forward out of the settled and unsettled preference lists. */
function useUnsettleOnActivity(): void {
  const store = useContext(StoreContext);
  useEffect(() => {
    if (store === null) return;
    const seen = new Map<string, number>();
    const check = (): void => {
      const preferences = uiState.get().preferences;
      const changed: string[] = [];
      for (const [id, summary] of Object.entries(store.getState().threads)) {
        const previous = seen.get(id);
        if (previous === summary.updatedAt) continue;
        seen.set(id, summary.updatedAt);
        if (previous !== undefined && summary.updatedAt > previous) changed.push(id);
      }
      if (changed.length === 0 || preferences === null) return;
      const drop = (ids: readonly string[]): string[] => ids.filter((id) => !changed.includes(id));
      const settledThreads = drop(preferences.settledThreads);
      const unsettledThreads = drop(preferences.unsettledThreads);
      if (
        settledThreads.length === preferences.settledThreads.length &&
        unsettledThreads.length === preferences.unsettledThreads.length
      ) return;
      updatePreferences({ settledThreads, unsettledThreads }).catch((error: unknown) => {
        console.warn("Could not un-settle threads after new activity", error);
      });
    };
    check();
    return store.subscribe(check);
  }, [store]);
}

function ConnectionDot({ bridge }: { bridge: BridgeStatus | null }) {
  const t = useT();
  const state = bridge?.state ?? "locating";
  const stateLabel = t(`connection.${state}`);
  const version = bridge?.omo?.version;
  const label = version === undefined ? stateLabel : t("shell.connection.version", { state: stateLabel, version });
  return (
    <Tooltip label={label} side="top" align="end" delayMs={300}>
      <span
        className={css.connection}
        role="img"
        tabIndex={0}
        aria-label={label}
        data-testid={TESTID.connectionDot}
        data-state={state}
      >
        <StateDot state={DOT_STATE[state]} />
      </span>
    </Tooltip>
  );
}

export function Sidebar() {
  const t = useT();
  const actions = useActions();
  const store = useContext(StoreContext);
  const newSession = useNewSessionFlow();
  const groups = useAppSelector(selectThreadsByWorkspace);
  const activeThreadId = useAppSelector((state) => state.activeThreadId);
  const threadsLoaded = useAppSelector((state) => state.threadsLoaded);
  const hasMore = useAppSelector((state) => state.threadsCursor !== null);
  const bridge = useAppSelector((state) => state.bridge);
  const { preferences } = useUiState();
  const connected = bridge?.state === "connected";
  const disconnectedHint = connected ? undefined : t("shell.newSessionDisconnected");
  const nowMs = useNowMs();
  useUnsettleOnActivity();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [settledOpen, setSettledOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [runningOnly, setRunningOnly] = useState(false);
  const [period, setPeriod] = useState<ThreadPeriod>("any");
  const [loadingMore, setLoadingMore] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const searchRef = useRef<HTMLInputElement | null>(null);

  const settleConfig = useMemo<SettleConfig>(
    () => ({
      autoSettle: preferences?.autoSettle ?? true,
      autoSettleDays: preferences?.autoSettleDays ?? 3,
      settledThreads: preferences?.settledThreads ?? [],
      unsettledThreads: preferences?.unsettledThreads ?? [],
    }),
    [preferences?.autoSettle, preferences?.autoSettleDays, preferences?.settledThreads, preferences?.unsettledThreads, preferences],
  );
  const split = useMemo(() => partitionSettled(groups, settleConfig, nowMs), [groups, settleConfig, nowMs]);
  const settledRef = useRef(split.settled);
  settledRef.current = split.settled;
  const settledGroup = useMemo<WorkspaceGroup>(() => ({ cwd: "settled", label: "", threads: split.settled }), [split]);

  const fallbackTitle = t("shell.newSession");
  const visibleGroups = useMemo(
    () => filterGroups(split.groups, { query, runningOnly, period }, nowMs, (thread: ThreadSummary) => threadTitle(thread, fallbackTitle)),
    [split, query, runningOnly, period, nowMs, fallbackTitle],
  );
  const visibleSettled = useMemo(
    () => filterGroups([settledGroup], { query, runningOnly, period }, nowMs, (thread: ThreadSummary) => threadTitle(thread, fallbackTitle))[0]?.threads ?? [],
    [settledGroup, query, runningOnly, period, nowMs, fallbackTitle],
  );
  const runningCount = useMemo(() => split.groups.reduce((count, group) => count + group.threads.filter(isRunning).length, 0), [split]);
  const searching = query.trim() !== "";
  const filtering = runningOnly || period !== "any";
  const settledExpanded = settledOpen || searching;

  const expand = (cwd: string): void => {
    setCollapsed((current) => {
      if (!current.has(cwd)) return current;
      const next = new Set(current);
      next.delete(cwd);
      return next;
    });
  };

  const toggle = (cwd: string): void => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(cwd)) next.add(cwd);
      return next;
    });
  };

  useEffect(() => {
    if (activeThreadId === null) return;
    const owner = groupsRef.current.find((group) => group.threads.some((thread) => thread.id === activeThreadId));
    if (owner !== undefined) expand(owner.cwd);
    if (settledRef.current.some((thread) => thread.id === activeThreadId)) setSettledOpen(true);
  }, [activeThreadId]);

  const setSettled = (threadId: string, settled: boolean): void => {
    const preferences = uiState.get().preferences;
    if (preferences === null) return;
    const settledThreads = settled
      ? [...preferences.settledThreads.filter((id) => id !== threadId), threadId]
      : preferences.settledThreads.filter((id) => id !== threadId);
    const unsettledThreads = settled
      ? preferences.unsettledThreads.filter((id) => id !== threadId)
      : [...preferences.unsettledThreads.filter((id) => id !== threadId), threadId];
    updatePreferences({ settledThreads, unsettledThreads }).catch((error: unknown) => {
      store?.dispatch({
        type: "notice/pushed",
        notice: {
          id: crypto.randomUUID(),
          level: "error",
          message: error instanceof Error ? error.message : String(error),
          threadId: null,
        },
      });
    });
  };

  const loadMore = async (): Promise<void> => {
    setLoadingMore(true);
    await actions.refreshThreads(true);
    setLoadingMore(false);
  };

  const reveal = (cwd: string): void => {
    window.omo.revealPath(cwd).catch((error: unknown) => {
      store?.dispatch({
        type: "notice/pushed",
        notice: {
          id: crypto.randomUUID(),
          level: "error",
          message: error instanceof Error ? error.message : String(error),
          threadId: null,
        },
      });
    });
  };

  const clearSearch = (): void => {
    setQuery("");
    searchRef.current?.focus();
  };

  const clearFilters = (): void => {
    setRunningOnly(false);
    setPeriod("any");
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      clearSearch();
    }
  };

  return (
    <nav className={css.root} data-testid={TESTID.sidebar} aria-label={t("shell.sessions")}>
      <div className={css.header} data-window-drag>
        <span className={css.brand}>
          <BrandMark size={22} className={css.brandMark} />
          <span className={css.brandName}>{t("app.brand")}</span>
          {isPreRelease(APP_VERSION) && (
            <span className={css.devBadge} title={APP_VERSION}>
              {t("shell.devBadge")}
            </span>
          )}
        </span>
        <Tooltip label={t("shell.hideSidebar")} side="bottom" align="end" delayMs={500}>
          <button
            type="button"
            className={css.headerButton}
            data-testid={TESTID.sidebarToggle}
            aria-label={t("shell.hideSidebar")}
            onClick={() => uiState.toggleSidebar()}
          >
            <IconPanelLeftOutlineRegular size={16} />
          </button>
        </Tooltip>
      </div>
      <div className={css.search} role="search">
        <IconSearchOutlineRegular size={14} className={css.searchIcon} />
        <input
          ref={searchRef}
          type="text"
          className={css.searchInput}
          data-testid={TESTID.sidebarSearch}
          aria-label={t("shell.search.label")}
          placeholder={t("shell.search.placeholder")}
          value={query}
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
        />
        {query !== "" && (
          <button
            type="button"
            className={css.searchClear}
            data-testid={TESTID.sidebarSearchClear}
            aria-label={t("shell.search.clear")}
            onClick={clearSearch}
          >
            <IconCloseCircleFillRegular size={14} />
          </button>
        )}
      </div>
      <div className={css.filters} role="group" aria-label={t("shell.filter.label")} data-testid={TESTID.sidebarFilters}>
        <Pill
          active={runningOnly}
          aria-pressed={runningOnly}
          title={t("shell.filter.runningHint")}
          data-testid={TESTID.sidebarFilterRunning}
          onClick={() => setRunningOnly((on) => !on)}
        >
          {t("shell.filter.running")}
          {runningCount > 0 && <span className={css.filterCount}>{runningCount}</span>}
        </Pill>
        {PERIODS.map((option) => (
          <Pill
            key={option}
            active={period === option}
            aria-pressed={period === option}
            title={t(`shell.filter.${option}Hint`)}
            data-testid={TESTID.sidebarFilterPeriod}
            data-period={option}
            onClick={() => setPeriod((current) => (current === option ? "any" : option))}
          >
            {t(`shell.filter.${option}`)}
          </Pill>
        ))}
      </div>
      <div className={css.region}>
        <div className={css.list}>
          {threadsLoaded && groups.length === 0 && (
            <div className={css.emptyState}>
              <IconQueueOutlineRegular size={24} />
              <div>{t("shell.noSessions")}</div>
            </div>
          )}
          {(searching || filtering) && groups.length > 0 && visibleGroups.length === 0 && visibleSettled.length === 0 && (
            <div className={css.emptyState} data-testid={TESTID.sidebarNoMatch} role="status">
              <div>{searching ? t("shell.search.noMatch", { query: query.trim() }) : t("shell.filter.noMatch")}</div>
              {filtering && (
                <Pill data-testid={TESTID.sidebarFilterClear} onClick={clearFilters}>
                  {t("shell.filter.clear")}
                </Pill>
              )}
            </div>
          )}
          {visibleGroups.map((group) => {
            const expanded = searching || filtering || !collapsed.has(group.cwd);
            const holdsActive = group.threads.some((thread) => thread.id === activeThreadId);
            return (
              <div
                key={group.cwd}
                className={css.group}
                role="group"
                data-testid={TESTID.workspaceGroup}
                data-cwd={group.cwd}
                aria-label={group.label}
              >
                <WorkspaceRow
                  group={group}
                  expanded={expanded}
                  hidesActiveThread={!expanded && holdsActive}
                  onToggle={() => toggle(group.cwd)}
                  onCreate={() => {
                    expand(group.cwd);
                    void actions.newThread(group.cwd);
                  }}
                />
                {expanded &&
                  group.threads.map((thread) => (
                    <ThreadRow
                      key={thread.id}
                      thread={thread}
                      active={thread.id === activeThreadId}
                      nowMs={nowMs}
                      onOpen={(threadId) => void actions.openThread(threadId)}
                      onRename={(threadId, name) => void actions.renameThread(threadId, name)}
                      onRequestDelete={(threadId, title) => setDeleteTarget({ threadId, title })}
                      onReveal={reveal}
                      onSettle={setSettled}
                    />
                  ))}
              </div>
            );
          })}
          {hasMore && !searching && (
            <button type="button" className={css.loadMore} disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? t("shell.sidebar.loadingMore") : t("shell.sidebar.loadMore")}
            </button>
          )}
          <button
            type="button"
            className={css.newProject}
            data-testid={TESTID.newSession}
            disabled={!connected}
            title={disconnectedHint}
            onClick={() => void newSession()}
          >
            <span className={css.newProjectLabel}>{t("shell.newProject")}</span>
            <PlusCircleGlyph size={16} className={css.newProjectIcon} />
          </button>
          <div className={css.settledBlock} data-testid={TESTID.sidebarSettled}>
            <div className={css.settledDivider} role="separator" />
            <button
              type="button"
              className={css.settledToggle}
              data-testid={TESTID.sidebarSettledToggle}
              aria-expanded={settledExpanded}
              aria-label={t(settledExpanded ? "shell.sidebar.collapseSettled" : "shell.sidebar.expandSettled")}
              onClick={() => setSettledOpen((open) => !open)}
            >
              <IconChevronDownOutlineRegular size={12} className={clsx(css.settledChevron, !settledExpanded && css.settledChevronClosed)} />
              <span className={css.settledTitle}>{t("shell.sidebar.settled")}</span>
              <span className={css.settledCount} aria-label={t("shell.sidebar.settledThreads", { count: visibleSettled.length })}>
                {visibleSettled.length}
              </span>
            </button>
            {settledExpanded &&
              visibleSettled.map((thread) => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  active={thread.id === activeThreadId}
                  nowMs={nowMs}
                  settled
                  onOpen={(threadId) => void actions.openThread(threadId)}
                  onRename={(threadId, name) => void actions.renameThread(threadId, name)}
                  onRequestDelete={(threadId, title) => setDeleteTarget({ threadId, title })}
                  onReveal={reveal}
                  onSettle={setSettled}
                />
              ))}
          </div>
        </div>
      </div>
      <div className={css.foot}>
        <button
          type="button"
          className={css.settingsTrigger}
          data-testid={TESTID.openSettings}
          aria-haspopup="dialog"
          onClick={() => uiState.setSettingsOpen(true)}
        >
          <IconSettingsOutlineMedium size={16} />
          <span className={css.settingsLabel}>{t("shell.openSettings")}</span>
        </button>
        <Tooltip label={t("shell.openAccounts")} side="top" align="end" delayMs={300}>
          <button
            type="button"
            className={css.headerButton}
            data-testid={TESTID.openAccounts}
            aria-label={t("shell.openAccounts")}
            onClick={() => uiState.setSettingsOpen(true)}
          >
            <IconDataOutlineMedium size={16} />
          </button>
        </Tooltip>
        <ConnectionDot bridge={bridge} />
      </div>
      <DeleteThreadDialog target={deleteTarget} onClose={() => setDeleteTarget(null)} />
    </nav>
  );
}
