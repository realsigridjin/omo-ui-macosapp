// A three-wave DAG run (plan -> survey-server, survey-web -> merge) that advances on its own timers so the
// Agents panel can show live transitions: plan works alone, both surveys fan out, merge settles the run.
const NODES = ["plan", "survey-server", "survey-web", "merge"];
const DEPENDS = { plan: [], "survey-server": ["plan"], "survey-web": ["plan"], merge: ["survey-server", "survey-web"] };
/** Node state per stage: 1 plan running, 2 surveys running, 3 merge running, 4 everything completed. */
const STAGE_STATES = {
  1: { plan: "running", "survey-server": "pending", "survey-web": "pending", merge: "pending" },
  2: { plan: "completed", "survey-server": "running", "survey-web": "running", merge: "pending" },
  3: { plan: "completed", "survey-server": "completed", "survey-web": "completed", merge: "running" },
  4: { plan: "completed", "survey-server": "completed", "survey-web": "completed", merge: "completed" },
};
/** How long each stage holds before the next omo.dag.updated snapshot, in ms. */
const STAGE_MS = { 1: 4500, 2: 4500, 3: 3500 };
/** Backdate a node's start when it begins running, so the demo shows a lived-in elapsed time. */
const START_BACKDATE_MS = 41_000;

export function runDagWavesScenario(record, turn, { notify, guard, sleep }) {
  const threadId = record.thread.id;
  const startedMs = Date.now();
  const createdAt = new Date(startedMs).toISOString();
  /** Wall-clock start of each node's current run, so elapsed times grow live. */
  const nodeStarted = new Map();
  const nodeFinished = new Map();

  function emit(stage) {
    const at = new Date().toISOString();
    const states = STAGE_STATES[stage];
    const nodes = NODES.map((id) => {
      const state = states[id];
      if (state === "running" && !nodeStarted.has(id)) nodeStarted.set(id, Date.now() - START_BACKDATE_MS);
      if ((state === "completed" || state === "failed") && !nodeFinished.has(id)) nodeFinished.set(id, Date.now());
      return {
        id, label: id, prompt: `Execute ${id}`, depends_on: DEPENDS[id], state, attempt: 1, created_at: createdAt,
        task_id: `st_waves_${id}`,
        ...(state === "pending" || state === "blocked" ? {} : { started_at: new Date(nodeStarted.get(id) ?? startedMs).toISOString() }),
        ...(nodeFinished.has(id) ? { completed_at: new Date(nodeFinished.get(id)).toISOString() } : {}),
      };
    });
    const counts = { total: nodes.length };
    for (const node of nodes) counts[node.state] = (counts[node.state] ?? 0) + 1;
    const extension = (name, data) => notify("extension_event", { type: "extension_event", threadId, name, data });
    extension("omo.dag.updated", { parent_session_id: threadId, runs: [{
      run_id: "dag-waves-1", run_key: "waves", name: "mass ulw: survey and fix",
      status: stage === 4 ? "completed" : "running", created_at: createdAt, updated_at: at,
      ...(stage === 4 ? { completed_at: at } : {}), counts, nodes,
      edges: nodes.flatMap((node) => node.depends_on.map((from) => ({ from, to: node.id }))),
      waves: [{ index: 0, node_ids: ["plan"] }, { index: 1, node_ids: ["survey-server", "survey-web"] }, { index: 2, node_ids: ["merge"] }],
    }] });
    const tasks = nodes.map((node) => ({
      task_id: node.task_id, name: node.id, task_summary: `Execute ${node.id}`, description: `Execute ${node.id}`,
      status: node.state === "completed" ? "completed" : node.state === "running" ? "running" : "pending",
      execution_mode: "in-process", model: "chatgpt-subscription/gpt-6.1-sol", category: "deep-low",
      residency_state: node.state === "running" ? "resident" : "disposed",
      depth: 1, created_at: createdAt, updated_at: at,
      ...(node.state === "running" ? { live_progress: { activity: "working", started_at: nodeStarted.get(node.id) ?? startedMs, current_tool: "read", turns: 2, tool_calls: 5 } } : {}),
      ...(node.state === "completed" ? { final_response: `${node.id} finished`, run_stats: { runtime_ms: 3500, turns: 3, tool_calls: 7 } } : {}),
    }));
    extension("omo.task.updated", { parent_session_id: threadId, tasks });
  }

  emit(1);
  return guard(turn, (async () => {
    for (const stage of [2, 3, 4]) {
      await sleep(STAGE_MS[stage - 1]);
      emit(stage);
    }
  })());
}
