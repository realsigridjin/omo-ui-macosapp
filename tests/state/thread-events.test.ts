import { describe, expect, it } from "vitest";
import { decideNotification, eventFromNotification, type ThreadEvent } from "../../src/state/thread-events";

const completed: ThreadEvent = { kind: "completed", eventId: "t1", threadId: "a", errorMessage: null };

describe("decideNotification", () => {
  it("never notifies the active thread", () => {
    const decision = decideNotification(completed, {
      threadNotifications: "always",
      inAppNotifications: true,
      windowFocused: true,
      activeThreadId: "a",
    });
    expect(decision).toEqual({ system: false, toast: false });
  });

  it("off shows no system notification in any focus state", () => {
    const options = { threadNotifications: "off" as const, inAppNotifications: true, activeThreadId: "b" };
    expect(decideNotification(completed, { ...options, windowFocused: true }).system).toBe(false);
    expect(decideNotification(completed, { ...options, windowFocused: false }).system).toBe(false);
  });

  it("background notifies only while unfocused, always notifies either way", () => {
    const options = { inAppNotifications: false, activeThreadId: "b" };
    expect(decideNotification(completed, { ...options, threadNotifications: "background", windowFocused: true }).system).toBe(false);
    expect(decideNotification(completed, { ...options, threadNotifications: "background", windowFocused: false }).system).toBe(true);
    expect(decideNotification(completed, { ...options, threadNotifications: "always", windowFocused: true }).system).toBe(true);
  });

  it("toasts only while focused, never for the active thread, and obeys the toggle", () => {
    const options = { threadNotifications: "off" as const, activeThreadId: "b" };
    expect(decideNotification(completed, { ...options, inAppNotifications: true, windowFocused: true }).toast).toBe(true);
    expect(decideNotification(completed, { ...options, inAppNotifications: true, windowFocused: false }).toast).toBe(false);
    expect(decideNotification(completed, { ...options, inAppNotifications: false, windowFocused: true }).toast).toBe(false);
  });
});

describe("eventFromNotification", () => {
  it("reports completed and failed turns, not interrupted ones", () => {
    const turn = (status: string) => ({
      method: "turn/completed",
      params: { threadId: "a", turn: { id: "t1", status, items: [], startedAt: 1, completedAt: 2, error: null } },
    });
    expect(eventFromNotification(turn("completed"))).toEqual({ kind: "completed", eventId: "t1", threadId: "a", errorMessage: null });
    expect(eventFromNotification(turn("failed"))).toEqual({ kind: "failed", eventId: "t1", threadId: "a", errorMessage: null });
    expect(eventFromNotification(turn("interrupted"))).toBeNull();
    expect(eventFromNotification({ method: "thread/started", params: {} })).toBeNull();
  });
});
