import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { LocalePreference, Preferences, ThemePreference, ThreadNotificationPreference, TimeFormatPreference } from "../shared/ipc";

const THEMES: readonly ThemePreference[] = ["system", "light", "dark"];
const LOCALES: readonly LocalePreference[] = ["system", "en", "ko"];
const MAX_RECENT = 10;
const THREAD_NOTIFICATION_MODES: readonly ThreadNotificationPreference[] = ["off", "background", "always"];
const TIME_FORMATS: readonly TimeFormatPreference[] = ["system", "12h", "24h"];
const MIN_SETTLE_DAYS = 1;
const MAX_SETTLE_DAYS = 365;
const MAX_SETTLED = 200;

export const DEFAULT_PREFERENCES: Preferences = {
  omoAutoUpdate: true,
  theme: "system",
  locale: "system",
  lastWorkspace: null,
  recentWorkspaces: [],
  modelId: null,
  threadNotifications: "background",
  inAppNotifications: true,
  timeFormat: "system",
  autoSettle: true,
  autoSettleDays: 3,
  settledThreads: [],
  unsettledThreads: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick<T extends string>(allowed: readonly T[], value: unknown, current: T): T {
  return allowed.find((candidate) => candidate === value) ?? current;
}

function nullableString(value: unknown, current: string | null): string | null {
  if (value === null) return null;
  return typeof value === "string" && value !== "" ? value : current;
}

function recent(value: unknown, current: string[]): string[] {
  if (!Array.isArray(value)) return current;
  const unique: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry !== "" && !unique.includes(entry)) unique.push(entry);
  }
  return unique.slice(0, MAX_RECENT);
}

/** Thread ids, deduplicated, newest last, at most MAX_SETTLED entries. */
function threadIds(value: unknown, current: string[]): string[] {
  if (!Array.isArray(value)) return current;
  const unique: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry !== "" && !unique.includes(entry)) unique.push(entry);
  }
  return unique.slice(-MAX_SETTLED);
}

/** Whole days clamped into 1..365; anything that is not a finite number keeps the current value. */
function settleDays(value: unknown, current: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return current;
  return Math.min(MAX_SETTLE_DAYS, Math.max(MIN_SETTLE_DAYS, Math.round(value)));
}

/** Applies every valid field of patch to current; invalid or unknown values keep the current value. */
function merge(current: Preferences, patch: unknown): Preferences {
  if (!isRecord(patch)) return current;
  const has = (key: keyof Preferences): boolean => key in patch;
  return {
    omoAutoUpdate: typeof patch["omoAutoUpdate"] === "boolean" ? patch["omoAutoUpdate"] : current.omoAutoUpdate ?? true,
    theme: has("theme") ? pick(THEMES, patch["theme"], current.theme) : current.theme,
    locale: has("locale") ? pick(LOCALES, patch["locale"], current.locale) : current.locale,
    lastWorkspace: has("lastWorkspace") ? nullableString(patch["lastWorkspace"], current.lastWorkspace) : current.lastWorkspace,
    recentWorkspaces: has("recentWorkspaces") ? recent(patch["recentWorkspaces"], current.recentWorkspaces) : current.recentWorkspaces,
    modelId: has("modelId") ? nullableString(patch["modelId"], current.modelId) : current.modelId,
    threadNotifications: has("threadNotifications")
      ? pick(THREAD_NOTIFICATION_MODES, patch["threadNotifications"], current.threadNotifications)
      : current.threadNotifications,
    inAppNotifications: typeof patch["inAppNotifications"] === "boolean" ? patch["inAppNotifications"] : current.inAppNotifications,
    timeFormat: has("timeFormat") ? pick(TIME_FORMATS, patch["timeFormat"], current.timeFormat) : current.timeFormat,
    autoSettle: typeof patch["autoSettle"] === "boolean" ? patch["autoSettle"] : current.autoSettle,
    autoSettleDays: has("autoSettleDays") ? settleDays(patch["autoSettleDays"], current.autoSettleDays) : current.autoSettleDays,
    settledThreads: has("settledThreads") ? threadIds(patch["settledThreads"], current.settledThreads) : current.settledThreads,
    unsettledThreads: has("unsettledThreads") ? threadIds(patch["unsettledThreads"], current.unsettledThreads) : current.unsettledThreads,
    ...(has("modelProfile") ? { modelProfile: patch["modelProfile"] === null ? null :
      (["daily-normal", "daily-heavy", "geeky-normal", "geeky-heavy"] as const).find(value => value === patch["modelProfile"]) ?? current.modelProfile ?? null }
      : current.modelProfile === undefined ? {} : { modelProfile: current.modelProfile }),
  };
}

/** Preferences persisted as <dir>/preferences.json; every write goes through a temp file and rename. */
export class PreferencesStore {
  private readonly file: string;
  private cache: Preferences | null = null;

  constructor(private readonly dir: string) {
    this.file = path.join(dir, "preferences.json");
  }

  get(): Preferences {
    this.cache ??= this.load();
    return this.cache;
  }

  /** Validates patch (which crosses the IPC boundary untyped), persists, and returns the stored preferences. */
  set(patch: unknown): Preferences {
    const next = merge(this.get(), patch);
    mkdirSync(this.dir, { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(temp, this.file);
    this.cache = next;
    return next;
  }

  private load(): Preferences {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      // ENOENT on first launch; any other read failure also starts from defaults.
      void error;
      return { ...DEFAULT_PREFERENCES, recentWorkspaces: [] };
    }
    try {
      return merge(DEFAULT_PREFERENCES, JSON.parse(text));
    } catch (error) {
      // A corrupt preferences file is replaced on the next set().
      void error;
      return { ...DEFAULT_PREFERENCES, recentWorkspaces: [] };
    }
  }
}
