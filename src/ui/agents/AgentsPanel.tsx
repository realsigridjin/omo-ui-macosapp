import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  IconAgentPresetOutlineRegular,
  IconBranchOutlineRegular,
  IconChevronDownOutlineRegular,
  IconChevronLeftOutlineRegular,
  IconCompareSplitOutlineRegular,
  IconFlatListOutlineRegular,
  IconFullscreenOutlineRegular,
  IconGoalOutlineRegular,
  IconPlusOutlineRegular,
  StateDot,
  Tooltip,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { DagNode, DagRun } from "../../../shared/protocol";
import { useT, type MessageKey, type Translate } from "../../i18n";
import { selectDagRuns, selectThreadLiveState } from "../../state";
import type { ThreadSummary } from "../../state";
import { useActions, useAppSelector } from "../app-context";
import { ActivityPanel } from "../conversation/ActivityPanel";
import { knownNodeState, knownRunStatus, nodeDot, nodeElapsedMs, runDot, type NodeState } from "../conversation/activity-model";
import { formatDuration, threadTitle } from "../conversation/format";
import { TESTID } from "../testids";
import type { AgentsPanelSize } from "../ui-state";
import { uiState, useUiState } from "../ui-state";
import { NODE_CARD_WIDTH, WAVE_LABEL_HEIGHT, edgeGeometry, fitScale, layoutWaveGraph, runProgress } from "./graph-layout";
import css from "./AgentsPanel.module.css";

/** Docked widths of the agents panel; AppFrame clamps them to the window. */
export const AGENTS_PANEL_WIDTHS: Record<AgentsPanelSize, number> = { normal: 480, wide: 640, maximized: 840 };
/** Node transitions kept in the Activity log, newest first. */
const ACTIVITY_LIMIT = 50;

const RUN_STATUS_LABELS = {
  pending: "activity.runStatus.pending", running: "activity.runStatus.running", paused: "activity.runStatus.paused",
  completed: "activity.runStatus.completed", failed: "activity.runStatus.failed", cancelled: "activity.runStatus.cancelled",
} as const satisfies Record<string, MessageKey>;

const NODE_STATUS_LABELS = {
  pending: "agents.node.pending", scheduled: "agents.node.pending", blocked: "agents.node.blocked",
  failed: "agents.node.failed", cancelled: "agents.node.cancelled", skipped: "agents.node.skipped",
} as const satisfies Record<Exclude<NodeState, "running" | "completed">, MessageKey>;

function runStatusLabel(status: string, t: Translate): string {
  const known = knownRunStatus(status);
  return known === null ? status : t(RUN_STATUS_LABELS[known]);
}

/** Card status line: a live elapsed timer for running nodes, else the localized state name. */
function nodeStatusLabel(node: DagNode, live: boolean, now: number, t: Translate): string {
  const known = knownNodeState(node.state);
  if (known === "running") {
    const elapsed = nodeElapsedMs(node, now, live);
    return elapsed === null ? t("agents.node.working") : t("agents.node.workingFor", { duration: formatDuration(elapsed, t) });
  }
  if (known === "completed") return t("agents.node.done");
  if (known === null) return t("agents.node.unknown", { state: node.state });
  return t(NODE_STATUS_LABELS[known]);
}

interface ActivityEntry {
  id: number;
  nodeId: string;
  label: string;
  state: string;
  atMs: number;
}

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** The run the panel headlines: the running one, else the newest snapshot. */
function headlineRun(runs: readonly DagRun[]): DagRun | null {
  return runs.find((run) => run.status === "running") ?? runs.at(-1) ?? null;
}

function relativeActivityTime(atMs: number, now: number, t: Translate): string {
  const elapsed = Math.max(0, now - atMs);
  if (elapsed < 60_000) return t("agents.time.now");
  if (elapsed < 3_600_000) return t("agents.time.minutes", { n: Math.floor(elapsed / 60_000) });
  return t("agents.time.hours", { n: Math.floor(elapsed / 3_600_000) });
}

function nodeLabel(node: DagNode): string {
  return node.label?.trim() || node.id;
}

function NodeCard({ node, live, now, left, top, width, height }: {
  node: DagNode; live: boolean; now: number; left: number; top: number; width: number; height: number;
}) {
  const t = useT();
  return (
    <div
      className={css.node}
      data-testid={TESTID.agentsNode}
      data-node-id={node.id}
      data-state={node.state}
      style={{ left, top, width, height }}
      title={[nodeLabel(node), nodeStatusLabel(node, live, now, t), node.prompt].filter(Boolean).join("\n")}
    >
      <span className={css.nodeName}>{nodeLabel(node)}</span>
      <span className={css.nodeStatus} data-testid={TESTID.agentsNodeStatus}>
        <StateDot state={nodeDot(node.state, live)} size={8} />
        {nodeStatusLabel(node, live, now, t)}
      </span>
    </div>
  );
}

/** Wave columns with bezier edges; fit scales the whole graph into view, reset returns it to 100% centered. */
function GraphView({ run, live, now }: { run: DagRun; live: boolean; now: number }) {
  const t = useT();
  const areaRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [fitted, setFitted] = useState(true);
  const graph = useMemo(() => layoutWaveGraph(run), [run]);
  const edges = useMemo(() => edgeGeometry(run, graph), [run, graph]);

  useEffect(() => {
    const el = areaRef.current;
    if (el === null) return;
    let raf: number | null = null;
    let disposed = false;
    const measure = (): void => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0) setViewport({ width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(() => {
      if (disposed) return;
      raf ??= requestAnimationFrame(() => {
        raf = null;
        measure();
      });
    });
    observer.observe(el);
    return () => {
      disposed = true;
      observer.disconnect();
      if (raf !== null) cancelAnimationFrame(raf);
    };
  }, []);

  const scale = fitted ? fitScale(graph.width, graph.height, viewport.width, viewport.height) : 1;
  return (
    <div ref={areaRef} className={css.graphArea} data-testid={TESTID.agentsGraph}>
      <div className={css.graphCenter}>
        <div className={css.graphStage} style={{ width: graph.width * scale, height: graph.height * scale }}>
          <div
            className={css.graphContent}
            style={{ width: graph.width, height: graph.height, transform: `scale(${scale})` }}
          >
            {graph.columns.map((column, index) => (
              <div
                key={index}
                className={css.waveLabel}
                data-testid={TESTID.agentsWave}
                data-wave={index + 1}
                style={{ left: graph.columnX[index] ?? 0, width: NODE_CARD_WIDTH, top: 0 }}
              >
                {t("agents.wave", { index: index + 1, settled: column.settled, total: column.nodes.length })}
                {column.running > 0 && ` · ${t("agents.waveRunning", { count: column.running })}`}
              </div>
            ))}
            <svg className={css.edges} width={graph.width} height={graph.height} style={{ top: WAVE_LABEL_HEIGHT }} aria-hidden>
              {edges.map((edge) => (
                <path
                  key={`${edge.from}:${edge.to}`}
                  className={css.edge}
                  data-testid={TESTID.agentsEdge}
                  data-kind={edge.kind}
                  data-from={edge.from}
                  data-to={edge.to}
                  d={edge.d}
                />
              ))}
            </svg>
            {graph.boxes.map((box) => (
              <NodeCard key={box.id} node={box.node} live={live} now={now} left={box.x} top={WAVE_LABEL_HEIGHT + box.y} width={box.width} height={box.height} />
            ))}
          </div>
        </div>
      </div>
      <div className={css.graphTools}>
        <Tooltip label={t("agents.fit")} side="top" delayMs={500}>
          <button
            type="button"
            className={`${css.toolButton} ${css.focusRing}`}
            data-testid={TESTID.agentsFit}
            aria-label={t("agents.fit")}
            onClick={() => setFitted(true)}
          >
            <IconFullscreenOutlineRegular size={14} />
          </button>
        </Tooltip>
        <Tooltip label={t("agents.recenter")} side="top" delayMs={500}>
          <button
            type="button"
            className={`${css.toolButton} ${css.focusRing}`}
            data-testid={TESTID.agentsRecenter}
            aria-label={t("agents.recenter")}
            onClick={() => setFitted(false)}
          >
            <IconGoalOutlineRegular size={14} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

function AgentsTabRow({ onAdd, size }: { onAdd?: () => void; size: AgentsPanelSize }) {
  const t = useT();
  return (
    <div className={css.tabRow}>
      <span className={css.tab}>
        <IconAgentPresetOutlineRegular size={14} />
        {t("agents.title")}
      </span>
      {onAdd !== undefined && (
        <Tooltip label={t("agents.add")} side="bottom" delayMs={500}>
          <button type="button" className={`${css.iconButton} ${css.focusRing}`} data-testid={TESTID.agentsAdd} aria-label={t("agents.add")} onClick={onAdd}>
            <IconPlusOutlineRegular size={14} />
          </button>
        </Tooltip>
      )}
      <span className={css.tabSpacer} />
      <Tooltip label={t("agents.widen")} side="bottom" delayMs={500}>
        <button
          type="button"
          className={`${css.iconButton} ${css.focusRing}`}
          data-testid={TESTID.agentsWiden}
          aria-pressed={size === "wide"}
          aria-label={t("agents.widen")}
          onClick={() => uiState.setAgentsPanelSize(size === "wide" ? "normal" : "wide")}
        >
          <IconCompareSplitOutlineRegular size={14} />
        </button>
      </Tooltip>
      <Tooltip label={t("agents.maximize")} side="bottom" delayMs={500}>
        <button
          type="button"
          className={`${css.iconButton} ${css.focusRing}`}
          data-testid={TESTID.agentsMaximize}
          aria-pressed={size === "maximized"}
          aria-label={t("agents.maximize")}
          onClick={() => uiState.setAgentsPanelSize(size === "maximized" ? "normal" : "maximized")}
        >
          <IconFullscreenOutlineRegular size={14} />
        </button>
      </Tooltip>
    </div>
  );
}

/**
 * The Agents panel: the conversation's DAG runs as a wave-column graph (list view reuses the conversation's
 * ActivityPanel), a summary title row, and an Activity log of node transitions observed while attached.
 */
export function AgentsPanel({ placement }: { placement: "docked" | "overlay" }) {
  const t = useT();
  const actions = useActions();
  const threadId = useAppSelector((state) => state.activeThreadId);
  const thread = useAppSelector((state) =>
    state.activeThreadId === null ? null : (state.threads[state.activeThreadId] ?? null),
  );
  const live = useAppSelector((state) => (state.activeThreadId === null ? null : selectThreadLiveState(state, state.activeThreadId)));
  const runs = useAppSelector((state) => (state.activeThreadId === null ? [] : selectDagRuns(state, state.activeThreadId)));
  const listId = useId();
  const { agentsPanelSize } = useUiState();
  const [view, setView] = useState<"graph" | "list">("graph");
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const entrySeq = useRef(0);
  const seenStates = useRef<Map<string, string>>(new Map());
  const isLive = live?.freshness === "live";
  const run = headlineRun(runs);
  const now = useNow(isLive && (run === null || run.status === "running"));

  useEffect(() => {
    const states = seenStates.current;
    const transitions: ActivityEntry[] = [];
    for (const current of runs) {
      // Newest first: later-listed nodes read as the snapshot's newer entries, so collect back to front.
      for (const node of [...current.nodes].reverse()) {
        const key = `${current.run_id}\u0000${node.id}`;
        const previous = states.get(key);
        if (previous === node.state) continue;
        states.set(key, node.state);
        if (previous !== undefined) {
          entrySeq.current += 1;
          transitions.push({ id: entrySeq.current, nodeId: node.id, label: nodeLabel(node), state: node.state, atMs: Date.now() });
        }
      }
    }
    if (transitions.length === 0) return;
    setEntries((current) => [...transitions.reverse(), ...current].slice(0, ACTIVITY_LIMIT));
  }, [runs]);

  const close = (): void => actions.setAgentsPanel(false);
  const startInComposer = (): void => {
    close();
    (document.querySelector(`[data-testid="${TESTID.composerInput}"]`) as HTMLTextAreaElement | null)?.focus();
  };
  const fallbackTitle = threadTitle(thread, t("conversation.header.newSession"));
  if (threadId === null || run === null) {
    return (
      <aside className={css.panel} data-testid={TESTID.agentsPanel} data-placement={placement} aria-label={t("agents.title")}>
        <AgentsTabRow size={agentsPanelSize} />
        <div className={css.empty}>
          <span className={css.emptyTitle}>{t("agents.empty")}</span>
          <span className={css.emptyHint}>{t("agents.empty.hint")}</span>
        </div>
      </aside>
    );
  }
  const progress = runProgress(run);
  const title = run.name !== "" ? run.name : fallbackTitle;
  return (
    <aside className={css.panel} data-testid={TESTID.agentsPanel} data-placement={placement} aria-label={t("agents.title")}>
      <AgentsTabRow onAdd={startInComposer} size={agentsPanelSize} />
      <div className={css.titleRow}>
        <Tooltip label={t("agents.back")} side="bottom" delayMs={500}>
          <button type="button" className={`${css.backButton} ${css.focusRing}`} data-testid={TESTID.agentsBack} aria-label={t("agents.back")} onClick={close}>
            <IconChevronLeftOutlineRegular size={16} />
          </button>
        </Tooltip>
        <div className={css.titleWrap}>
          <span className={css.title} title={title}>{title}</span>
          <span className={css.subtitle} data-testid={TESTID.agentsSubtitle}>
            {t("agents.subtitle", { settled: progress.settled, total: progress.total, wave: progress.wave, waves: progress.waves })}
          </span>
        </div>
        <div className={css.viewToggle} role="group" aria-label={t("agents.title")}>
          <Tooltip label={t("agents.view.graph")} side="bottom" delayMs={500}>
            <button type="button" className={`${css.viewButton} ${css.focusRing}`} data-testid={TESTID.agentsViewGraph} aria-pressed={view === "graph"} aria-label={t("agents.view.graph")} onClick={() => setView("graph")}>
              <IconBranchOutlineRegular size={14} />
            </button>
          </Tooltip>
          <Tooltip label={t("agents.view.list")} side="bottom" delayMs={500}>
            <button type="button" className={`${css.viewButton} ${css.focusRing}`} data-testid={TESTID.agentsViewList} aria-pressed={view === "list"} aria-label={t("agents.view.list")} onClick={() => setView("list")}>
              <IconFlatListOutlineRegular size={14} />
            </button>
          </Tooltip>
        </div>
        <span className={css.runStatus} data-testid={TESTID.agentsRunStatus} data-status={knownRunStatus(run.status) ?? "pending"}>
          <StateDot state={runDot(run.status, isLive)} size={9} />
          {knownRunStatus(run.status) === "running" ? t("agents.status.working") : runStatusLabel(run.status, t)}
        </span>
      </div>
      {view === "graph" ? (
        <GraphView run={run} live={isLive} now={now} />
      ) : (
        <div className={css.listView}>
          <ActivityPanel threadId={threadId} id={listId} />
        </div>
      )}
      {view === "graph" && (
        <details className={css.activity} open={entries.length > 0}>
          <summary className={`${css.activityHeader} ${css.focusRing}`} data-testid={TESTID.agentsActivityToggle}>
            {t("agents.activity")}
            <IconChevronDownOutlineRegular size={12} className={css.activityChevron} />
          </summary>
          <ul className={css.activityList} data-testid={TESTID.agentsActivity}>
            {entries.map((entry) => (
              <li key={entry.id} className={css.activityEntry} data-testid={TESTID.agentsActivityEntry} data-node-id={entry.nodeId} data-state={entry.state}>
                <StateDot state={nodeDot(entry.state, true)} size={8} />
                <span className={css.activityText}>
                  {entry.label} —{" "}
                  <span>{nodeStatusLabel({ ...STATUS_ONLY_NODE, id: entry.nodeId, label: entry.label, state: entry.state }, true, now, t)}</span>
                </span>
                <span className={css.activityTime}>{relativeActivityTime(entry.atMs, now, t)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </aside>
  );
}

const STATUS_ONLY_NODE: DagNode = {
  id: "", prompt: "", state: "pending", depends_on: [], attempt: 1, created_at: "",
};
