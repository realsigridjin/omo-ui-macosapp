import type { TimeFormatPreference } from "../../shared/ipc";

const HOUR_CYCLES: Record<Exclude<TimeFormatPreference, "system">, "h12" | "h23"> = { "12h": "h12", "24h": "h23" };

const CLOCK_OPTIONS: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Formats one clock time as a short date plus hour and minute: the locale's own hour cycle for "system" (the
 * browser or OS clock preference), the forced 12- or 24-hour cycle otherwise. Formatters are cached per
 * preference and locale because the sidebar re-renders its rows every half minute.
 */
export function formatClockTime(at: number, pref: TimeFormatPreference, locale: string): string {
  const key = `${pref}:${locale}`;
  let format = formatters.get(key);
  if (format === undefined) {
    format = new Intl.DateTimeFormat(locale, pref === "system" ? CLOCK_OPTIONS : { ...CLOCK_OPTIONS, hourCycle: HOUR_CYCLES[pref] });
    formatters.set(key, format);
  }
  return format.format(at);
}
