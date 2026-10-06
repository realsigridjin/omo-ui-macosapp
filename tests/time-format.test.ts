import { describe, expect, it } from "vitest";
import { formatClockTime } from "../src/ui/time-format";

const at = new Date(2026, 5, 11, 9, 5).getTime();
const evening = new Date(2026, 5, 11, 18, 45).getTime();

describe("formatClockTime", () => {
  it("forces the 12-hour and 24-hour cycles", () => {
    expect(formatClockTime(at, "12h", "en-US")).toBe("Jun 11, 9:05 AM");
    expect(formatClockTime(evening, "12h", "en-US")).toBe("Jun 11, 6:45 PM");
    expect(formatClockTime(at, "24h", "en-US")).toBe("Jun 11, 09:05");
    expect(formatClockTime(evening, "24h", "en-US")).toBe("Jun 11, 18:45");
  });

  it("system keeps the locale's own hour cycle", () => {
    expect(formatClockTime(evening, "system", "en-US")).toBe("Jun 11, 6:45 PM");
    expect(formatClockTime(evening, "system", "en-GB")).toBe("11 Jun, 18:45");
  });

  it("formats through the locale's calendar", () => {
    expect(formatClockTime(at, "24h", "ko")).toBe("6월 11일 09:05");
  });
});
