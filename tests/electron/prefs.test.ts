import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, PreferencesStore } from "../../electron/prefs";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "omo-ui-prefs-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("PreferencesStore", () => {
  it("returns defaults when no file exists", () => {
    expect(new PreferencesStore(dir).get()).toEqual(DEFAULT_PREFERENCES);
  });

  it("returns defaults when the file is corrupt", async () => {
    await writeFile(path.join(dir, "preferences.json"), "{nope");
    expect(new PreferencesStore(dir).get()).toEqual(DEFAULT_PREFERENCES);
  });

  it("defaults auto-update on for old preferences and persists only boolean choices", async () => {
    await writeFile(path.join(dir, "preferences.json"), JSON.stringify({ theme: "dark" }));
    const store = new PreferencesStore(dir);
    expect(store.get().omoAutoUpdate).toBe(true);
    expect(store.set({ omoAutoUpdate: false }).omoAutoUpdate).toBe(false);
    expect(store.set({ omoAutoUpdate: "true" }).omoAutoUpdate).toBe(false);
    expect(new PreferencesStore(dir).get().omoAutoUpdate).toBe(false);
    expect(store.set({ omoAutoUpdate: true }).omoAutoUpdate).toBe(true);
  });

  it("keeps the current value for invalid fields", () => {
    const store = new PreferencesStore(dir);
    store.set({ theme: "dark", modelId: "gpt" });
    const next = store.set({ theme: "neon", locale: 42, modelId: "", lastWorkspace: 7 });
    expect(next).toEqual({ ...DEFAULT_PREFERENCES, theme: "dark", modelId: "gpt" });
  });

  it("validates and persists profiles without requiring them in old preferences", async () => {
    await writeFile(path.join(dir, "preferences.json"), JSON.stringify({ modelId: "old-model" }));
    const store = new PreferencesStore(dir);
    expect(store.get().modelProfile).toBeUndefined();
    expect(store.set({ modelProfile: "geeky-heavy" }).modelProfile).toBe("geeky-heavy");
    expect(store.set({ modelProfile: "invalid" }).modelProfile).toBe("geeky-heavy");
    expect(new PreferencesStore(dir).get().modelProfile).toBe("geeky-heavy");
    expect(store.set({ modelProfile: null }).modelProfile).toBeNull();
  });

  it("deduplicates recent workspaces and keeps at most 10", () => {
    const store = new PreferencesStore(dir);
    const many = Array.from({ length: 12 }, (_, index) => `/w/${index}`);
    const next = store.set({ recentWorkspaces: ["/w/0", "/w/0", "", 3, ...many] });
    expect(next.recentWorkspaces).toEqual(many.slice(0, 10));
  });

  it("defaults the behaviour fields and backfills old preference files", async () => {
    await writeFile(path.join(dir, "preferences.json"), JSON.stringify({ theme: "dark" }));
    const store = new PreferencesStore(dir);
    expect(store.get()).toMatchObject({
      threadNotifications: "background",
      inAppNotifications: true,
      timeFormat: "system",
      autoSettle: true,
      autoSettleDays: 3,
      settledThreads: [],
      unsettledThreads: [],
    });
  });

  it("validates thread notification and time format choices", () => {
    const store = new PreferencesStore(dir);
    expect(store.set({ threadNotifications: "always" }).threadNotifications).toBe("always");
    expect(store.set({ threadNotifications: "sometimes" }).threadNotifications).toBe("always");
    expect(store.set({ threadNotifications: 7 }).threadNotifications).toBe("always");
    expect(store.set({ timeFormat: "24h" }).timeFormat).toBe("24h");
    expect(store.set({ timeFormat: "24" }).timeFormat).toBe("24h");
    expect(store.set({ inAppNotifications: false }).inAppNotifications).toBe(false);
    expect(store.set({ inAppNotifications: "no" }).inAppNotifications).toBe(false);
    expect(store.set({ autoSettle: false }).autoSettle).toBe(false);
    expect(store.set({ autoSettle: 0 }).autoSettle).toBe(false);
  });

  it("clamps auto-settle days into 1..365 and ignores non-numbers", () => {
    const store = new PreferencesStore(dir);
    expect(store.set({ autoSettleDays: 0 }).autoSettleDays).toBe(1);
    expect(store.set({ autoSettleDays: -5 }).autoSettleDays).toBe(1);
    expect(store.set({ autoSettleDays: 400 }).autoSettleDays).toBe(365);
    expect(store.set({ autoSettleDays: 3.6 }).autoSettleDays).toBe(4);
    expect(store.set({ autoSettleDays: "7" }).autoSettleDays).toBe(4);
    expect(new PreferencesStore(dir).get().autoSettleDays).toBe(4);
  });

  it("bounds and deduplicates settled and unsettled thread ids", () => {
    const store = new PreferencesStore(dir);
    const many = Array.from({ length: 205 }, (_, index) => `t${index}`);
    const next = store.set({ settledThreads: ["a", "a", "", 4, ...many] });
    expect(next.settledThreads).toEqual(many.slice(-200));
    expect(store.set({ settledThreads: "x" }).settledThreads).toEqual(many.slice(-200));
    expect(store.set({ unsettledThreads: ["u", "u"] }).unsettledThreads).toEqual(["u"]);
  });

  it("persists atomically so a new store reads the saved values", async () => {
    new PreferencesStore(dir).set({ theme: "light", locale: "ko", lastWorkspace: "/repo", modelId: null });
    expect(await readdir(dir)).toEqual(["preferences.json"]);
    expect(JSON.parse(await readFile(path.join(dir, "preferences.json"), "utf8"))).toMatchObject({ theme: "light", locale: "ko" });
    expect(new PreferencesStore(dir).get()).toEqual({ ...DEFAULT_PREFERENCES, theme: "light", locale: "ko", lastWorkspace: "/repo" });
  });
});
