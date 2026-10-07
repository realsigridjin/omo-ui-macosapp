import { describe, expect, it } from "vitest";
import type { LiveTask } from "../../shared/protocol";
import type { ConversationItem, ConversationTurn } from "../../src/state";
import { lastAgentMessageIndex, tasksInTurn, turnFold, waitingPhase } from "../../src/ui/conversation/work-log";

let seq = 0;
const item = (type: ConversationItem["item"]["type"], id = `i-${++seq}`): ConversationItem => ({
  item: { type, id } as ConversationItem["item"],
  streaming: false,
  startedAtMs: null,
  completedAtMs: null,
});

const turn = (items: ConversationItem[], status: ConversationTurn["status"], startedAtMs: number | null, completedAtMs: number | null): ConversationTurn => ({
  id: "t",
  status,
  error: null,
  items,
  startedAtMs,
  completedAtMs,
  origin: "live",
});

const withTimes = (entries: ConversationItem[], at: number): ConversationItem[] =>
  entries.map((entry) => ({ ...entry, startedAtMs: at, completedAtMs: at }));

describe("turnFold", () => {
  it("folds the items between the first user message and the last agent message", () => {
    const items = [item("userMessage"), item("reasoning"), item("dynamicToolCall"), item("agentMessage"), item("agentMessage")];
    expect(turnFold(turn(items, "completed", 1_000, 2_400))).toEqual({ start: 1, end: 4, durationMs: 1_400 });
  });

  it("keeps a running turn expanded", () => {
    const items = [item("userMessage"), item("reasoning"), item("agentMessage")];
    expect(turnFold(turn(items, "inProgress", 1_000, null))).toBeNull();
  });

  it("keeps interrupted and failed turns expanded", () => {
    const items = [item("userMessage"), item("reasoning"), item("agentMessage")];
    expect(turnFold(turn(items, "interrupted", 1_000, 2_000))).toBeNull();
    expect(turnFold(turn(items, "failed", 1_000, 2_000))).toBeNull();
  });

  it("shows no fold without intermediate steps or without a final answer", () => {
    expect(turnFold(turn([item("userMessage"), item("agentMessage")], "completed", 1_000, 1_500))).toBeNull();
    expect(turnFold(turn([item("userMessage"), item("reasoning"), item("dynamicToolCall")], "completed", 1_000, 2_000))).toBeNull();
    expect(turnFold(turn([item("agentMessage"), item("reasoning")], "completed", 1_000, 2_000))).toBeNull();
  });

  it("derives the duration from item timestamps when the turn's own are missing", () => {
    const items = withTimes([item("userMessage"), item("reasoning"), item("agentMessage")], 0).map((entry, index) => ({
      ...entry,
      startedAtMs: 5_000 + index * 500,
      completedAtMs: 5_100 + index * 500,
    }));
    expect(turnFold(turn(items, "completed", null, null))).toEqual({ start: 1, end: 2, durationMs: 1_100 });
  });

  it("folds a steer message sent into the turn", () => {
    const items = [item("userMessage"), item("agentMessage"), item("userMessage"), item("agentMessage")];
    expect(turnFold(turn(items, "completed", 0, 1_000))).toEqual({ start: 1, end: 3, durationMs: 1_000 });
  });
});

describe("lastAgentMessageIndex", () => {
  it("finds the last of several answers and -1 without one", () => {
    const items = [item("userMessage"), item("agentMessage"), item("dynamicToolCall"), item("agentMessage")];
    expect(lastAgentMessageIndex(items)).toBe(3);
    expect(lastAgentMessageIndex([item("userMessage"), item("reasoning")])).toBe(-1);
  });
});

describe("waitingPhase", () => {
  it("waits for the session before the turn exists and for the model after it started", () => {
    expect(waitingPhase(null, true)).toBe("startingSession");
    expect(waitingPhase(null, false)).toBeNull();
    expect(waitingPhase(turn([item("userMessage")], "inProgress", 1_000, null), false)).toBe("waitingModel");
  });

  it("stops waiting once any agent work arrived, and never waits on a settled turn", () => {
    expect(waitingPhase(turn([item("userMessage"), item("reasoning")], "inProgress", 1_000, null), false)).toBeNull();
    expect(waitingPhase(turn([item("userMessage")], "completed", 1_000, 2_000), false)).toBeNull();
    expect(waitingPhase(turn([], "inProgress", 1_000, null), false)).toBe("waitingModel");
  });
});

describe("tasksInTurn", () => {
  const task = (id: string, createdAt: string, status = "running"): LiveTask => ({
    task_id: id,
    status,
    execution_mode: "in-process",
    model: "fake/alpha",
    residency_state: "resident",
    depth: 1,
    created_at: createdAt,
    updated_at: createdAt,
  });

  it("maps tasks created inside the turn's range, with slack for truncated timestamps", () => {
    const from = "2026-10-07T10:00:01.500Z";
    const inside = "2026-10-07T10:00:03.000Z";
    const after = "2026-10-07T10:05:00.000Z";
    const items = [item("userMessage"), item("agentMessage")];
    const running = turn(items, "inProgress", Date.parse("2026-10-07T10:00:03.000Z"), null);
    expect(tasksInTurn([task("a", from), task("b", inside), task("c", after)], running).map((entry) => entry.task_id)).toEqual(["a", "b", "c"]);
    const done = turn(items, "completed", Date.parse("2026-10-07T10:00:03.000Z"), Date.parse("2026-10-07T10:00:10.000Z"));
    expect(tasksInTurn([task("a", from), task("c", after)], done).map((entry) => entry.task_id)).toEqual(["a"]);
  });

  it("keeps tasks of a turn without a start time out", () => {
    expect(tasksInTurn([task("a", new Date().toISOString())], turn([item("userMessage")], "inProgress", null, null))).toEqual([]);
  });
});
