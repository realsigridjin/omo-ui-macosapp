import { describe, expect, it } from "vitest";
import { middleTruncate } from "../../src/ui/git/middle-truncate";

describe("middleTruncate", () => {
  it("keeps short text unchanged", () => {
    expect(middleTruncate("main", 28)).toBe("main");
    expect(middleTruncate("feature/x", 10)).toBe("feature/x");
  });

  it("keeps both ends and cuts the middle", () => {
    expect(middleTruncate("feature/very-long-branch-name", 20)).toBe("feature/ve…anch-name");
  });

  it("splits odd budgets with the longer half in front", () => {
    expect(middleTruncate("abcdefghij", 7)).toBe("abc…hij");
  });

  it("collapses to a single ellipsis for tiny budgets", () => {
    expect(middleTruncate("abcdef", 1)).toBe("…");
  });
});
