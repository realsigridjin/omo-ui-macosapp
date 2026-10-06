import { relativeTime } from "../../dsh/primitives/relative-time";
import type { TimeFormatPreference } from "../../../shared/ipc";
import type { Translate } from "../../i18n";
import { formatClockTime } from "../time-format";

/**
 * Compact trailing time for a sidebar row: "now", "5m", "2h" within a day, then the clock time (for example
 * "Mar 3, 4:05 PM") honoring the timeFormat preference.
 */
export function formatThreadTime(at: number, now: number, t: Translate, pref: TimeFormatPreference, locale: string): string {
  const { unit, n } = relativeTime(at, now);
  if (unit === "days" || unit === "months" || unit === "years") return formatClockTime(at, pref, locale);
  return t(`shell.time.${unit}`, { n });
}
