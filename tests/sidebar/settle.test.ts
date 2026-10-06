import { describe, expect, it } from "vitest";
import type { ThreadSummary, WorkspaceGroup } from "../../src/state";
import { isThreadSettled, partitionSettled, type SettleConfig } from "../../src/ui/sidebar/settle";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function thread(id: string, overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return { id, cwd: "/w/server", name: null, preview: "", updatedAt: 0, status: { type: "idle" }, path: null, source: null, ...overrides };
}

function config(overrides: Partial<SettleConfig> = {}): SettleConfig {
  return { autoSettle: true, autoSettleDays: 3, settledThreads: [], unsettledThreads: [], ...overrides };
}

describe("isThreadSettled", () => {
  const now = 100 * DAY;

  it("settles a thread at exactly autoSettleDays and not a millisecond earlier", () => {
    expect(isThreadSettled(thread("a", { updatedAt: now - 3 * DAY }), config(), now)).toBe(true);
    expect(isThreadSettled(thread("a", { updatedAt: now - 3 * DAY + 1 }), config(), now)).toBe(false);
  });

  it("never settles a running thread", () => {
    const running = thread("a", { updatedAt: now - 40 * DAY, status: { type: "active", activeFlags: [] } });
    expect(isThreadSettled(running, config(), now)).toBe(false);
  });

  it("keeps a manually settled thread settled even with auto-settle off", () => {
    expect(isThreadSettled(thread("a", { updatedAt: now }), config({ settledThreads: ["a"] }), now)).toBe(true);
    expect(isThreadSettled(thread("a", { updatedAt: now }), config({ autoSettle: false, settledThreads: ["a"] }), now)).toBe(true);
  });

  it("manual unsettle wins over auto-settle until the thread's next activity clears it", () => {
    const old = thread("a", { updatedAt: now - 10 * DAY });
    expect(isThreadSettled(old, config({ unsettledThreads: ["a"] }), now)).toBe(false);
    expect(isThreadSettled(old, config(), now)).toBe(true);
  });

  it("trusts the configured days, not the preference clamp", () => {
    const updatedAt = now - 2 * DAY;
    expect(isThreadSettled(thread("a", { updatedAt }), config({ autoSettleDays: 2 }), now)).toBe(true);
    expect(isThreadSettled(thread("a", { updatedAt }), config({ autoSettleDays: 4 }), now)).toBe(false);
  });
});

describe("partitionSettled", () => {
  const now = 100 * DAY;
  const groups: WorkspaceGroup[] = [
    { cwd: "/w/server", label: "server", threads: [thread("fresh", { updatedAt: now }), thread("old", { updatedAt: now - 5 * DAY })] },
    { cwd: "/w/client", label: "client", threads: [thread("manual", { cwd: "/w/client", updatedAt: now }), thread("ancient", { cwd: "/w/client", updatedAt: now - 9 * DAY })] },
  ];

  it("moves settled threads out of their groups and returns them flat", () => {
    const { groups: active, settled } = partitionSettled(groups, config({ settledThreads: ["manual"] }), now);
    expect(active.map((group) => [group.cwd, group.threads.map((entry) => entry.id)])).toEqual([["/w/server", ["fresh"]]]);
    expect(settled.map((entry) => entry.id)).toEqual(["old", "manual", "ancient"]);
  });

  it("drops groups whose threads all settle", () => {
    const solo: WorkspaceGroup[] = [{ cwd: "/w/old", label: "old", threads: [thread("gone", { cwd: "/w/old", updatedAt: now - 5 * DAY })] }];
    const { groups: active, settled } = partitionSettled(solo, config(), now);
    expect(active).toEqual([]);
    expect(settled.map((entry) => entry.id)).toEqual(["gone"]);
  });
});
