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

  it("persists each profile's model independently and restores Automatic by omitting an entry", () => {
    const store = new PreferencesStore(dir);
    expect(store.get().profileModels).toBeUndefined();
    const profileModels = {
      "daily-normal": "opus",
      "daily-heavy": "fable",
      "geeky-normal": "sol",
      "geeky-heavy": "astra",
    };
    expect(store.set({ profileModels }).profileModels).toEqual(profileModels);
    expect(store.set({ theme: "dark" }).profileModels).toEqual(profileModels);
    expect(new PreferencesStore(dir).get().profileModels).toEqual(profileModels);
    expect(store.set({ profileModels: { "daily-heavy": "custom" } }).profileModels).toEqual({ "daily-heavy": "custom" });
    expect(new PreferencesStore(dir).get().profileModels).toEqual({ "daily-heavy": "custom" });
    expect(store.set({ profileModels: {} }).profileModels).toEqual({});
    expect(new PreferencesStore(dir).get().profileModels).toEqual({});
  });

  it("rejects invalid profile-model maps and entries at the IPC boundary", () => {
    const store = new PreferencesStore(dir);
    store.set({ profileModels: { "daily-heavy": "custom" } });
    for (const profileModels of [null, [], "custom", 42]) {
      expect(store.set({ profileModels }).profileModels).toEqual({ "daily-heavy": "custom" });
    }
    expect(store.set({ profileModels: {
      "daily-heavy": "  ", "daily-normal": 42, "geeky-normal": null,
      "geeky-heavy": "astra", unknown: "custom",
    } }).profileModels).toEqual({ "daily-heavy": "custom", "geeky-heavy": "astra" });
    expect(store.set({ profileModels: { "daily-heavy": "", "geeky-heavy": false } }).profileModels).toEqual({
      "daily-heavy": "custom", "geeky-heavy": "astra",
    });
  });

  it("persists atomically so a new store reads the saved values", async () => {
    new PreferencesStore(dir).set({ theme: "light", locale: "ko", lastWorkspace: "/repo", modelId: null });
    expect(await readdir(dir)).toEqual(["preferences.json"]);
    expect(JSON.parse(await readFile(path.join(dir, "preferences.json"), "utf8"))).toMatchObject({ theme: "light", locale: "ko" });
    expect(new PreferencesStore(dir).get()).toEqual({ ...DEFAULT_PREFERENCES, theme: "light", locale: "ko", lastWorkspace: "/repo" });
  });
});
