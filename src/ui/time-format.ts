import type { TimeFormatPreference } from "../../shared/ipc";

const HOUR_CYCLES: Record<Exclude<TimeFormatPreference, "system">, "h12" | "h23"> = { "12h": "h12", "24h": "h23" };

const CLOCK_OPTIONS: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
const HOUR_MINUTE_OPTIONS: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(pref: TimeFormatPreference, locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${pref}:${locale}:${options.hourCycle ?? ""}:${options.month ?? ""}`;
  let format = formatters.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locale, pref === "system" ? options : { ...options, hourCycle: HOUR_CYCLES[pref] });
    formatters.set(key, format);
  }
  return format;
}

/**
 * Formats one clock time as a short date plus hour and minute: the locale's own hour cycle for "system" (the
 * browser or OS clock preference), the forced 12- or 24-hour cycle otherwise. Formatters are cached per
 * preference and locale because the sidebar re-renders its rows every half minute.
 */
export function formatClockTime(at: number, pref: TimeFormatPreference, locale: string): string {
  return formatter(pref, locale, CLOCK_OPTIONS).format(at);
}

/** The hour and minute alone ("3:12 PM"), honoring the timeFormat preference the same way as {@link formatClockTime}. */
export function formatClockHourMinute(at: number, pref: TimeFormatPreference, locale: string): string {
  return formatter(pref, locale, HOUR_MINUTE_OPTIONS).format(at);
}
