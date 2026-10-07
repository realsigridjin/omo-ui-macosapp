import { describe, expect, it } from "vitest";
import type { DagNode, DagRun } from "../../shared/protocol";
import {
  EDGE_OVERLAP,
  NODE_CARD_HEIGHT,
  NODE_CARD_WIDTH,
  NODE_GAP_Y,
  WAVE_GAP_X,
  WAVE_LABEL_HEIGHT,
  bezierPath,
  edgeGeometry,
  fitScale,
  graphWaveColumns,
  layoutWaveGraph,
  runProgress,
} from "../../src/ui/agents/graph-layout";

const AT = "2026-10-07T00:00:00.000Z";

function node(id: string, state: string, dependsOn: string[] = []): DagNode {
  return { id, label: id, prompt: `Execute ${id}`, depends_on: dependsOn, state, attempt: 1, created_at: AT };
}

/** The reference run shape: plan -> survey-server, survey-web -> merge across three waves. */
function wavesRun(states: Record<string, string>, withWaves = true): DagRun {
  const nodes = [
    node("plan", states["plan"] ?? "pending"),
    node("survey-server", states["survey-server"] ?? "pending", ["plan"]),
    node("survey-web", states["survey-web"] ?? "pending", ["plan"]),
    node("merge", states["merge"] ?? "pending", ["survey-server", "survey-web"]),
  ];
  return {
    run_id: "r", run_key: "k", name: "mass ulw", status: "running", created_at: AT, updated_at: AT,
    counts: {}, nodes,
    edges: nodes.flatMap((item) => item.depends_on.map((from) => ({ from, to: item.id }))),
    waves: withWaves
      ? [{ index: 0, node_ids: ["plan"] }, { index: 1, node_ids: ["survey-server", "survey-web"] }, { index: 2, node_ids: ["merge"] }]
      : [],
  };
}

describe("graph layout", () => {
  it("uses scheduler waves when they place every node, counting settled and running per column", () => {
    const columns = graphWaveColumns(wavesRun({ plan: "completed", "survey-server": "running", "survey-web": "running", merge: "blocked" }));
    expect(columns.map((column) => column.nodes.map((item) => item.id))).toEqual([["plan"], ["survey-server", "survey-web"], ["merge"]]);
    expect(columns.map((column) => [column.settled, column.running])).toEqual([[1, 0], [0, 2], [0, 0]]);
  });

  it("derives wave columns from dependencies when the snapshot has no waves or leaves nodes out", () => {
    expect(graphWaveColumns(wavesRun({}, false)).map((column) => column.nodes.map((item) => item.id)))
      .toEqual([["plan"], ["survey-server", "survey-web"], ["merge"]]);
    const partial = wavesRun({}, true);
    expect(graphWaveColumns({ ...partial, waves: [{ index: 0, node_ids: ["plan"] }] })[2]?.nodes.map((item) => item.id)).toEqual(["merge"]);
  });

  it("stacks each column centered on the tallest one and spaces columns a gap apart", () => {
    const graph = layoutWaveGraph(wavesRun({}, false));
    const box = (id: string) => graph.boxes.find((entry) => entry.id === id);
    expect(graph.columnX).toEqual([0, NODE_CARD_WIDTH + WAVE_GAP_X, 2 * (NODE_CARD_WIDTH + WAVE_GAP_X)]);
    expect(graph.width).toBe(3 * NODE_CARD_WIDTH + 2 * WAVE_GAP_X);
    const fan = box("survey-server");
    const merge = box("merge");
    const single = box("plan");
    expect(fan?.y).toBe(0);
    expect(merge?.y).toBe(NODE_CARD_HEIGHT / 2 + NODE_GAP_Y / 2);
    expect(single?.y).toBe(NODE_CARD_HEIGHT / 2 + NODE_GAP_Y / 2);
    expect(box("survey-web")?.y).toBe(NODE_CARD_HEIGHT + NODE_GAP_Y);
    expect(graph.height).toBe(WAVE_LABEL_HEIGHT + 2 * NODE_CARD_HEIGHT + NODE_GAP_Y);
  });

  it("bezier edges leave the source right edge, enter the target left edge, and clamp their control offset", () => {
    const half = NODE_CARD_WIDTH / 2;
    const dx = Math.min(120, Math.max(24, (208 - NODE_CARD_WIDTH - 2 * EDGE_OVERLAP) / 2));
    expect(bezierPath({ x: 0, y: 10 }, { x: 208, y: 30 })).toBe(
      `M ${half + EDGE_OVERLAP} 10 C ${half + EDGE_OVERLAP + dx} 10, ${208 - half - EDGE_OVERLAP - dx} 30, ${208 - half - EDGE_OVERLAP} 30`,
    );
    const distant = bezierPath({ x: 0, y: 0 }, { x: 500, y: 0 });
    expect(distant).toContain(`C ${half + EDGE_OVERLAP + 120} 0, ${500 - half - EDGE_OVERLAP - 120} 0,`);
    const backward = bezierPath({ x: 400, y: 5 }, { x: 0, y: 6 });
    expect(backward.startsWith(`M ${400 - half - EDGE_OVERLAP} 5`)).toBe(true);
    expect(backward).toContain(`${0 + half + EDGE_OVERLAP} 6`);
  });

  it("builds edge geometry from depends_on and edges once, styled by the source state", () => {
    const run = wavesRun({ plan: "completed", "survey-server": "running" });
    const graph = layoutWaveGraph(run);
    const edges = edgeGeometry(run, graph);
    expect(edges.map((edge) => [edge.from, edge.to, edge.kind])).toEqual([
      ["plan", "survey-server", "satisfied"],
      ["plan", "survey-web", "satisfied"],
      ["survey-server", "merge", "active"],
      ["survey-web", "merge", "pending"],
    ]);
    const doubled = edgeGeometry({ ...run, edges: [...run.edges, { from: "plan", to: "survey-server" }] }, graph);
    expect(doubled).toHaveLength(edges.length);
    expect(edgeGeometry({ ...run, edges: [...run.edges, { from: "ghost", to: "merge" }] }, graph)).toHaveLength(edges.length);
  });

  it("fits the graph inside the viewport without enlarging or losing readability", () => {
    expect(fitScale(600, 400, 400, 300)).toBeCloseTo((400 - 48) / 600);
    expect(fitScale(100, 50, 400, 300)).toBe(1);
    expect(fitScale(600, 400, 40, 30)).toBe(0.2);
    expect(fitScale(0, 0, 400, 300)).toBe(1);
  });

  it("summarizes run progress with the wave being worked on", () => {
    const running = runProgress(wavesRun({ plan: "completed", "survey-server": "running", "survey-web": "running", merge: "blocked" }));
    expect(running).toEqual({ settled: 1, total: 4, wave: 2, waves: 3 });
    expect(runProgress(wavesRun({}))).toEqual({ settled: 0, total: 4, wave: 1, waves: 3 });
    expect(runProgress(wavesRun({ plan: "completed", "survey-server": "completed", "survey-web": "completed", merge: "completed" })))
      .toEqual({ settled: 4, total: 4, wave: 3, waves: 3 });
  });
});
