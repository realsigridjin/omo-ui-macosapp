// Native-shaped files and RPC snapshots. Stages advance by event, never by test timing luck.
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function runDagScenario(record, turn, { home, notify, guard }) {
  const threadId = record.thread.id;
  const cwd = realpathSync(record.thread.cwd);
  // Use the native legacy workspace store instead of duplicating platform-specific project hashing.
  const store = join(cwd, ".omo", "senpi-task");
  const started = Date.now() - 73_000;
  const createdAt = new Date(started).toISOString();
  const childIds = new Map();
  const childId = (id) => {
    if (!childIds.has(id)) childIds.set(id, randomUUID());
    return childIds.get(id);
  };
  let stage = 1;
  function emit() {
    const updatedAt = new Date().toISOString();
    const rows = [
      ["research", "Read protocol", "completed", "explore"],
      ["wire", "Validate events", "completed", "deep-low"],
      ["layout", "Build compact panel", stage === 3 ? "completed" : "running", "visual-engineering"],
      ["fixtures", "Add live fixtures", "completed", "quick"],
      ["coverage", "Check coverage", stage === 3 ? "completed" : "error", "deep-low"],
      ["review", "Review UI", stage === 3 ? "completed" : "pending", "unspecified-low"],
      ["ship", "Verify release", stage === 3 ? "completed" : "pending", "deep-low"],
    ];
    const tasks = [];
    const all = [];
    function save(id, label, status, category, parent, depth, done = 0, total = 3, current = "Inspect source") {
      const sessionId = childId(id);
      const task = {
        task_id: `st_dag_${id}`, task_summary: label, description: label, name: id, status,
        execution_mode: "in-process", model: "chatgpt-subscription/gpt-6.1-sol", category,
        residency_state: status === "running" ? "resident" : "persisted_only",
        depth, created_at: createdAt, updated_at: updatedAt, child_session_id: sessionId,
        ...(status === "running" ? { live_progress: { activity: "tool", current_tool: "bash",
          last_assistant_line: current, started_at: started, turns: 4, tool_calls: 9 } } :
          { run_stats: { runtime_ms: 63_000, turns: 3, tool_calls: 8 } }),
        ...(status === "error" ? { error_message: "Coverage gate: uncovered error branch", failure_kind: "tool_error" } : {}),
      };
      const disk = { ...task, parent_session_id: parent, root_session_id: threadId, started_at: createdAt,
        ...(status === "completed" || status === "error" ? { terminal_at: updatedAt } : {}) };
      const file = join(store, "tasks", `${task.task_id}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(disk));
      const steps = Array.from({ length: total }, (_, i) => ({
        content: i < done ? ["Inspect source", "Trace callers", "Implement parser", "Add regression tests"][i % 4] :
          i === done ? current : ["Check edge cases", "Review screenshot", "Report results"][i % 3],
        status: status === "completed" || i < done ? "completed" : i === done ? "in_progress" : "pending",
      }));
      const sessionFile = join(store, "children", task.task_id, "sessions", task.task_id, `${createdAt.replaceAll(":", "-")}_${sessionId}.jsonl`);
      mkdirSync(dirname(sessionFile), { recursive: true });
      const timestamp = updatedAt;
      writeFileSync(sessionFile, [
        { type: "session", version: 3, id: sessionId, timestamp, cwd },
        { type: "message", id: "user", parentId: null, timestamp, message: { role: "user", content: [{ type: "text", text: label }] } },
        { type: "custom", id: "todo", parentId: "user", timestamp, customType: "senpi.todo-state",
          data: { schema: "v2", phases: [{ name: "Work", tasks: steps }] } },
        { type: "message", id: "assistant", parentId: "todo", timestamp,
          message: { role: "assistant", content: [{ type: "text", text: current }], stopReason: status === "completed" ? "stop" : "toolUse" } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      all.push(task);
      if (parent === threadId) tasks.push(task);
      return task;
    }
    for (const [id, label, status, category] of rows.slice(0, 5)) {
      save(id, label, status, category, threadId, 1, id === "layout" ? stage === 1 ? 4 : 6 : 2,
        id === "layout" ? 9 : 3, id === "layout" ? stage === 1 ? "Run tests" : "Inspect screenshots" : label);
    }
    save("audit", "Audit accessibility", stage === 3 ? "completed" : "running", "unspecified-low", threadId, 1, 1, 4, "Check keyboard navigation");
    save("browser", "Exercise Electron UI", stage === 3 ? "completed" : "running", "deep-low", childId("layout"), 2, 2, 5, "Capture expanded panel");
    save("visual", "Inspect visual density", stage === 3 ? "completed" : "running", "visual-engineering", childId("browser"), 3, 1, 3, "Check row alignment");
    save("contrast", "Measure text contrast", stage === 3 ? "completed" : "running", "quick", childId("visual"), 4, 1, 2, "Check label contrast");
    const depends = { research: [], wire: ["research"], layout: ["wire"], fixtures: ["wire"], coverage: ["fixtures"],
      review: ["layout", "coverage"], ship: ["review"] };
    const nodes = rows.map(([id, label, status]) => ({
      id, label, prompt: label, depends_on: depends[id], state: id === "ship" && stage !== 3 ? "blocked" : status === "error" ? "failed" : status,
      attempt: 1, created_at: createdAt,
      ...(id === "review" || id === "ship" ? {} : { task_id: `st_dag_${id}`, started_at: createdAt }),
      ...(status === "completed" || status === "error" ? { completed_at: updatedAt } : {}),
      ...(status === "error" ? { last_error: { code: "coverage", message: "Coverage gate: uncovered error branch" } } : {}),
    }));
    const counts = { total: nodes.length };
    for (const node of nodes) counts[node.state] = (counts[node.state] ?? 0) + 1;
    const extension = (name, data, owner = threadId) => notify("extension_event", { type: "extension_event", threadId: owner, name, data });
    extension("omo.dag.updated", { parent_session_id: threadId, runs: [{
      run_id: "dag-live-ui", run_key: "ui", name: "Ship live task view", status: stage === 3 ? "completed" : "running",
      created_at: createdAt, updated_at: updatedAt, ...(stage === 3 ? { completed_at: updatedAt } : {}),
      counts, nodes, edges: nodes.flatMap((node) => node.depends_on.map((from) => ({ from, to: node.id }))),
      waves: [
        { index: 0, node_ids: ["research"] }, { index: 1, node_ids: ["wire"] },
        { index: 2, node_ids: ["layout", "fixtures"] }, { index: 3, node_ids: ["coverage"] },
        { index: 4, node_ids: ["review"] }, { index: 5, node_ids: ["ship"] },
      ],
    }] });
    extension("omo.task.updated", { parent_session_id: threadId, tasks });
    for (const parent of ["layout", "browser", "visual"]) {
      extension("omo.task.updated", { parent_session_id: childId(parent), tasks: all.filter((task) =>
        (parent === "layout" && task.task_id === "st_dag_browser") ||
        (parent === "browser" && task.task_id === "st_dag_visual") ||
        (parent === "visual" && task.task_id === "st_dag_contrast")) }, childId(parent));
    }
    extension("omo.dag.activity", { schemaVersion: 1, runId: "dag-live-ui", nodeId: "layout", taskId: "st_dag_layout",
      at: updatedAt, activity: stage === 1 ? "testing" : "reviewing", currentTool: "bash",
      lastAssistantLine: stage === 1 ? "Run tests" : "Inspect screenshots", turns: 4, toolCalls: 9 });
  }
  emit();
  return guard(turn, new Promise((resolve) => {
    record.advanceLive = () => {
      stage++;
      emit();
      if (stage === 3) {
        record.advanceLive = null;
        resolve();
      }
    };
  }));
}
