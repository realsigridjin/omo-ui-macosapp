import type { DagNode, DagRun } from "../../../shared/protocol";
import { groupNodesByDependency, groupNodesByWave } from "../conversation/activity-model";

/** Card metrics of the graph view; wave columns are one card wide with a gap for the bezier edges. */
export const NODE_CARD_WIDTH = 124;
export const NODE_CARD_HEIGHT = 44;
export const WAVE_GAP_X = 28;
export const NODE_GAP_Y = 16;
/** Top strip of the graph holding the wave labels. */
export const WAVE_LABEL_HEIGHT = 24;
/** How far each bezier end reaches under its card, so edges visually meet the border. */
export const EDGE_OVERLAP = 6;
export const FIT_PADDING = 24;

const SETTLED_STATES = new Set(["completed", "failed", "cancelled", "skipped"]);

export interface WaveColumn {
  /** 0-based column position, also the wave number the label shows. */
  index: number;
  nodes: DagNode[];
  settled: number;
  running: number;
}

/**
 * Wave columns for the graph: the scheduler's waves when they place every node, else dependency layers derived
 * from `depends_on` and `run.edges` (cyclic or unknown dependencies fall out in a final unresolved column).
 */
export function graphWaveColumns(run: DagRun): WaveColumn[] {
  const scheduled = groupNodesByWave(run);
  const groups = scheduled.some((group) => group.index === null) ? groupNodesByDependency(run) : scheduled;
  return groups.map((group, index) => {
    const nodes = group.nodes;
    return {
      index,
      nodes,
      settled: nodes.filter((node) => SETTLED_STATES.has(node.state)).length,
      running: nodes.filter((node) => node.state === "running").length,
    };
  });
}

export interface NodeBox {
  id: string;
  node: DagNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WaveGraph {
  columns: WaveColumn[];
  /** Column left edge x positions, parallel to `columns`. */
  columnX: number[];
  boxes: NodeBox[];
  width: number;
  height: number;
}

/**
 * Lays a run out as wave columns left to right, nodes stacked top to bottom; each column is vertically centered
 * on the tallest one so fan-in and fan-out edges read symmetrically.
 */
export function layoutWaveGraph(run: DagRun): WaveGraph {
  const columns = graphWaveColumns(run);
  const columnX: number[] = [];
  const boxes: NodeBox[] = [];
  let x = 0;
  let tallest = 0;
  const heights = columns.map((column) => {
    const height = column.nodes.length * NODE_CARD_HEIGHT + Math.max(0, column.nodes.length - 1) * NODE_GAP_Y;
    tallest = Math.max(tallest, height);
    return height;
  });
  const contentHeight = Math.max(tallest, NODE_CARD_HEIGHT);
  columns.forEach((column, index) => {
    columnX.push(x);
    const height = heights[index] ?? 0;
    const top = (contentHeight - height) / 2;
    column.nodes.forEach((node, row) => {
      boxes.push({
        id: node.id,
        node,
        x,
        y: top + row * (NODE_CARD_HEIGHT + NODE_GAP_Y),
        width: NODE_CARD_WIDTH,
        height: NODE_CARD_HEIGHT,
      });
    });
    x += NODE_CARD_WIDTH + WAVE_GAP_X;
  });
  return {
    columns,
    columnX,
    boxes,
    width: Math.max(0, x - (columns.length > 0 ? WAVE_GAP_X : 0)),
    height: WAVE_LABEL_HEIGHT + contentHeight,
  };
}

export type EdgeKind = "satisfied" | "active" | "pending";

/** An edge reads by its source: satisfied once the dependency completed, in-flight while it runs. */
export function edgeKind(sourceState: string): EdgeKind {
  if (sourceState === "completed") return "satisfied";
  if (sourceState === "running") return "active";
  return "pending";
}

export interface Point {
  x: number;
  y: number;
}

/**
 * Horizontal cubic bezier between two card center points: leaves `from` rightward and enters `to` leftward when
 * `to` is to the right (the wave order), and the mirrored sides otherwise, with the control offset clamped so
 * adjacent columns curve gently and distant ones steepen.
 */
export function bezierPath(from: Point, to: Point, cardWidth = NODE_CARD_WIDTH): string {
  const half = cardWidth / 2;
  const forward = to.x >= from.x;
  const x1 = forward ? from.x + half + EDGE_OVERLAP : from.x - half - EDGE_OVERLAP;
  const x2 = forward ? to.x - half - EDGE_OVERLAP : to.x + half + EDGE_OVERLAP;
  const dx = Math.min(120, Math.max(24, Math.abs(x2 - x1) / 2));
  return `M ${x1} ${from.y} C ${x1 + (forward ? dx : -dx)} ${from.y}, ${x2 + (forward ? -dx : dx)} ${to.y}, ${x2} ${to.y}`;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  d: string;
}

function center(box: NodeBox): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Bezier geometry for the run's dependency edges (`run.edges` plus each node's `depends_on`, de-duplicated);
 * edges naming a node the run no longer lists are dropped.
 */
export function edgeGeometry(run: DagRun, graph: WaveGraph): GraphEdge[] {
  const byId = new Map(graph.boxes.map((box) => [box.id, box]));
  const states = new Map(run.nodes.map((node) => [node.id, node.state]));
  const seen = new Set<string>();
  const pairs = [
    ...run.nodes.flatMap((node) => node.depends_on.map((from) => ({ from, to: node.id }))),
    ...run.edges,
  ];
  const edges: GraphEdge[] = [];
  for (const { from, to } of pairs) {
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const source = byId.get(from);
    const target = byId.get(to);
    if (source === undefined || target === undefined) continue;
    edges.push({ from, to, kind: edgeKind(states.get(from) ?? "pending"), d: bezierPath(center(source), center(target)) });
  }
  return edges;
}

/**
 * Uniform scale that fits the whole graph in a viewport with `FIT_PADDING` on every side, never enlarging
 * beyond 1 and never shrinking below 0.2 so labels stay readable.
 */
export function fitScale(graphWidth: number, graphHeight: number, viewportWidth: number, viewportHeight: number): number {
  if (graphWidth <= 0 || graphHeight <= 0) return 1;
  const roomW = viewportWidth - 2 * FIT_PADDING;
  const roomH = viewportHeight - 2 * FIT_PADDING;
  if (roomW <= 0 || roomH <= 0) return 0.2;
  return Math.max(0.2, Math.min(1, roomW / graphWidth, roomH / graphHeight));
}

export interface RunProgress {
  settled: number;
  total: number;
  /** 1-based wave the run is working on: the last wave with a running node, else the first unsettled one. */
  wave: number;
  waves: number;
}

/** Subtitle progress of a run: settled nodes out of the total and the wave it is working on. */
export function runProgress(run: DagRun, columns: WaveColumn[] = graphWaveColumns(run)): RunProgress {
  const total = run.nodes.length;
  const settled = run.nodes.filter((node) => SETTLED_STATES.has(node.state)).length;
  const running = columns.findIndex((column) => column.running > 0);
  const open = columns.findIndex((column) => column.settled < column.nodes.length);
  const wave = running >= 0 ? running + 1 : open >= 0 ? open + 1 : columns.length;
  return { settled, total, wave, waves: columns.length };
}
