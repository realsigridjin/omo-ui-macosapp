import { describe, expect, it } from "vitest";
import { OMO_INSTALL_COMMAND } from "../../shared/ipc";
import type { BridgeStatus } from "../../shared/ipc";
import { createInitialState, reduce } from "../../src/state";
import type { AppEvent, AppState } from "../../src/state";
import { makeThread, notification, PROBE_THREAD_ID, probeNotificationEvents } from "./helpers";

function replay(events: AppEvent[], initial: AppState = createInitialState()): AppState {
  return events.reduce(reduce, initial);
}

function status(state: BridgeStatus["state"]): BridgeStatus {
  return {
    state,
    omo: null,
    userAgent: null,
    message: null,
    stderrTail: null,
    exitCode: null,
    restartAttempt: 0,
    installCommand: OMO_INSTALL_COMMAND,
  };
}

const userMessage = (id: string, text: string, clientId: string | null = null) => ({
  type: "userMessage",
  id,
  clientId,
  content: [{ type: "text", text, text_elements: [] }],
});

const turnStarted = (threadId: string, turnId: string, receivedAtMs = 1_000) =>
  notification(
    "turn/started",
    { threadId, turn: { id: turnId, items: [], status: "inProgress", error: null, startedAt: null } },
    receivedAtMs,
  );

describe("right-panel exclusivity", () => {
  it("opens at most one of the side chat and Agents panels at a time", () => {
    const sideOpen = reduce(createInitialState(), { type: "btw/toggled", open: true });
    expect(sideOpen.btw.open).toBe(true);
    const agentsOpen = reduce(sideOpen, { type: "agents/toggled", open: true });
    expect(agentsOpen.agents.open).toBe(true);
    expect(agentsOpen.btw.open).toBe(false);
    const sideAgain = reduce(agentsOpen, { type: "btw/toggled", open: true });
    expect(sideAgain.btw.open).toBe(true);
    expect(sideAgain.agents.open).toBe(false);
    const agentsClosed = reduce(sideAgain, { type: "agents/toggled", open: false });
    expect(agentsClosed).toBe(sideAgain);
    expect(reduce(agentsOpen, { type: "agents/toggled", open: true })).toBe(agentsOpen);
  });
});

describe("probe replay", () => {
  const events = probeNotificationEvents();

  it("builds the probe thread with two completed live turns", () => {
    const state = replay(events);
    expect(state.threads[PROBE_THREAD_ID]).toMatchObject({ cwd: "/tmp/omo-ui-discovery/probe-cwd", source: "appServer" });
    const conversation = state.conversations[PROBE_THREAD_ID];
    expect(conversation?.turns).toHaveLength(2);
    expect(conversation?.turns.map((turn) => turn.origin)).toEqual(["live", "live"]);
    expect(conversation?.activeTurnId).toBeNull();
    expect(conversation?.turns.flatMap((turn) => turn.items).some((entry) => entry.streaming)).toBe(false);
  });

  it("holds the pong exchange in turn 1", () => {
    const turn = replay(events).conversations[PROBE_THREAD_ID]?.turns[0];
    expect(turn?.items.map((entry) => entry.item)).toMatchObject([
      { type: "userMessage", content: [{ type: "text", text: "Reply with exactly: pong" }] },
      { type: "agentMessage", text: "pong" },
    ]);
  });

  it("holds reasoning, the eval tool call and the answer in turn 2", () => {
    const turn = replay(events).conversations[PROBE_THREAD_ID]?.turns[1];
    expect(turn?.items.map((entry) => entry.item)).toMatchObject([
      { type: "userMessage" },
      { type: "reasoning", content: [expect.stringMatching(/^There's no direct bash tool/)] },
      {
        type: "dynamicToolCall",
        tool: "eval",
        success: true,
        contentItems: expect.arrayContaining([
          expect.objectContaining({ type: "inputText", text: expect.stringContaining("omo-probe-42") }),
        ]),
      },
      { type: "agentMessage", text: "omo-probe-42" },
    ]);
  });

  it("streams the first agent delta into a streaming agent message", () => {
    const firstDelta = events.findIndex(
      (event) => event.type === "rpc/notification" && event.notification.method === "item/agentMessage/delta",
    );
    const state = replay(events.slice(0, firstDelta + 1));
    const agent = state.conversations[PROBE_THREAD_ID]?.turns[0]?.items.find((entry) => entry.item.type === "agentMessage");
    expect(agent?.item).toMatchObject({ type: "agentMessage", text: "p" });
    expect(agent?.streaming).toBe(true);
  });
});

describe("reduce", () => {
  const threadId = "thread-1";

  it("sets a reconciled error without changing the reported status", () => {
    const state = replay([
      turnStarted(threadId, "t1"),
      notification("turn/completed", { threadId, turn: { id: "t1", items: [], status: "completed", error: null } }),
    ]);
    const turn = state.conversations[threadId]?.turns[0];
    if (turn === undefined) throw new Error("missing turn");
    const error = { message: "402: Insufficient Balance" };
    const next = reduce(state, { type: "turn/errorReconciled", threadId, turn, error });
    expect(next.conversations[threadId]?.turns[0]).toEqual({ ...turn, error });
    expect(reduce(next, { type: "turn/errorReconciled", threadId, turn, error })).toBe(next);
    const deleted = reduce(state, notification("thread/deleted", { threadId }));
    expect(reduce(deleted, { type: "turn/errorReconciled", threadId, turn, error })).toBe(deleted);
  });

  it("drops the pending user message echoed with the same clientId", () => {
    const state = replay([
      { type: "user/messageSent", threadId, clientId: "c1", text: "same", sentAtMs: 1 },
      { type: "user/messageSent", threadId, clientId: "c2", text: "same", sentAtMs: 2 },
      turnStarted(threadId, "t1"),
      notification("item/started", { threadId, turnId: "t1", item: userMessage("u1", "same", "c2") }),
    ]);
    expect(state.conversations[threadId]?.pendingUserMessages.map((message) => message.clientId)).toEqual(["c1"]);
  });

  it("drops the oldest pending message with identical text when the echo has no clientId", () => {
    const state = replay([
      { type: "user/messageSent", threadId, clientId: "c1", text: "hello", sentAtMs: 1 },
      { type: "user/messageSent", threadId, clientId: "c2", text: "hello", sentAtMs: 2 },
      turnStarted(threadId, "t1"),
      notification("item/started", { threadId, turnId: "t1", item: userMessage("u1", "hello") }),
    ]);
    expect(state.conversations[threadId]?.pendingUserMessages.map((message) => message.clientId)).toEqual(["c2"]);
  });

  it("keeps live turns missing from loaded history after the history turns", () => {
    const state = replay([
      { type: "thread/activated", threadId },
      turnStarted(threadId, "live-1"),
      turnStarted(threadId, "shared"),
      {
        type: "history/loaded",
        threadId,
        turns: [{ id: "shared", status: "failed", error: { message: "402: Insufficient Balance" }, items: [], startedAt: 10, completedAt: 20 }],
      },
    ]);
    const conversation = state.conversations[threadId];
    expect(conversation?.turns.map((turn) => [turn.id, turn.origin])).toEqual([
      ["shared", "history"],
      ["live-1", "live"],
    ]);
    expect(conversation?.historyState).toBe("loaded");
    expect(conversation?.turns[0]?.error).toEqual({ message: "402: Insufficient Balance" });
  });

  it("removes the thread, its conversation and its requests on thread/deleted", () => {
    const state = replay([
      { type: "thread/opened", thread: makeThread(threadId), resumed: true },
      { type: "thread/activated", threadId },
      {
        type: "rpc/serverRequest",
        request: { id: 7, method: "item/commandExecution/requestApproval", params: { threadId, turnId: "t1", itemId: "i1" } },
        receivedAtMs: 1,
      },
      notification("thread/deleted", { threadId }),
    ]);
    expect(state.threads[threadId]).toBeUndefined();
    expect(state.threadOrder).toEqual([]);
    expect(state.conversations[threadId]).toBeUndefined();
    expect(state.pendingRequests).toEqual([]);
    expect(state.activeThreadId).toBeNull();
  });

  it("interrupts running turns and clears pending requests when the bridge disconnects", () => {
    const state = replay([
      { type: "bridge/status", status: status("connected") },
      { type: "thread/opened", thread: makeThread(threadId), resumed: true },
      turnStarted(threadId, "t1"),
      notification("item/agentMessage/delta", { threadId, turnId: "t1", itemId: "a1", delta: "partial" }),
      {
        type: "rpc/serverRequest",
        request: { id: "r1", method: "item/fileChange/requestApproval", params: { threadId, turnId: "t1", itemId: "f1" } },
        receivedAtMs: 1,
      },
      { type: "bridge/status", status: status("exited") },
    ]);
    const conversation = state.conversations[threadId];
    expect(conversation?.resumed).toBe(false);
    expect(conversation?.activeTurnId).toBeNull();
    expect(conversation?.turns[0]?.status).toBe("interrupted");
    expect(conversation?.turns[0]?.items[0]?.streaming).toBe(false);
    expect(state.pendingRequests).toEqual([]);
  });

  it("drops a pending request when serverRequest/resolved arrives", () => {
    const received = reduce(createInitialState(), {
      type: "rpc/serverRequest",
      request: {
        id: 3,
        method: "item/tool/requestUserInput",
        params: { threadId, turnId: "t1", itemId: "q", questions: [{ id: "q1", header: "H", question: "?", options: null }] },
      },
      receivedAtMs: 5,
    });
    expect(received.pendingRequests).toMatchObject([{ kind: "userInput", id: 3, threadId, receivedAtMs: 5 }]);
    const resolved = reduce(received, notification("serverRequest/resolved", { threadId, requestId: 3 }));
    expect(resolved.pendingRequests).toEqual([]);
  });

  it("pushes an error notice for an unsupported server request", () => {
    const state = reduce(createInitialState(), {
      type: "rpc/serverRequest",
      request: { id: 4, method: "item/permissions/requestApproval", params: { threadId } },
      receivedAtMs: 1,
    });
    expect(state.pendingRequests).toEqual([]);
    expect(state.notices).toMatchObject([{ level: "error" }]);
  });

  it("ignores items of unknown type", () => {
    const started = replay([turnStarted(threadId, "t1")]);
    const next = reduce(started, notification("item/started", { threadId, turnId: "t1", item: { type: "hologram", id: "h1" } }));
    expect(next).toBe(started);
  });

  it("keeps identical item ids in different turns separate", () => {
    const state = replay([
      turnStarted(threadId, "t1"),
      notification("item/completed", { threadId, turnId: "t1", item: { type: "agentMessage", id: "message-1:0", text: "first", phase: null } }),
      turnStarted(threadId, "t2"),
      notification("item/started", { threadId, turnId: "t2", item: { type: "reasoning", id: "message-1:0", summary: [], content: [] } }),
      notification("item/reasoning/textDelta", { threadId, turnId: "t2", itemId: "message-1:0", delta: "think", contentIndex: 1 }),
    ]);
    const turns = state.conversations[threadId]?.turns;
    expect(turns?.[0]?.items.map((entry) => entry.item)).toMatchObject([{ type: "agentMessage", text: "first" }]);
    expect(turns?.[1]?.items.map((entry) => entry.item)).toMatchObject([{ type: "reasoning", content: ["", "think"] }]);
  });
});

describe("thread preview", () => {
  const opened: AppEvent = { type: "thread/opened", thread: makeThread("t-preview"), resumed: true };

  it("fills an empty preview with the first user message item", () => {
    const state = replay([
      opened,
      turnStarted("t-preview", "turn-1"),
      notification("item/started", { threadId: "t-preview", turnId: "turn-1", item: userMessage("u1", "Fix the login bug\nand add tests") }),
    ]);
    expect(state.threads["t-preview"]?.preview).toBe("Fix the login bug\nand add tests");
  });

  it("fills the preview when a message is sent and keeps it afterwards", () => {
    const state = replay([
      opened,
      { type: "user/messageSent", threadId: "t-preview", clientId: "c1", text: "first", sentAtMs: 1 },
      { type: "user/messageSent", threadId: "t-preview", clientId: "c2", text: "second", sentAtMs: 2 },
    ]);
    expect(state.threads["t-preview"]?.preview).toBe("first");
  });
});

describe("thread session model", () => {
  it("keeps the model omo reported when a thread is opened", () => {
    const session = { modelProvider: "anthropic-subscription", model: "claude-opus-5-5", reasoningEffort: "medium" as const };
    const state = replay([{ type: "thread/opened", thread: makeThread("t-model"), resumed: true, session }]);
    expect(state.conversations["t-model"]?.session).toEqual(session);
  });
});
