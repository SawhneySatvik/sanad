import { describe, expect, it } from "vitest";
import { formatRetryTime } from "@/lib/format/retry-time";

describe("formatRetryTime", () => {
  it("formats sub-minute durations as seconds", () => {
    expect(formatRetryTime(45)).toBe("45 seconds");
  });

  it("formats a single second in the singular", () => {
    expect(formatRetryTime(1)).toBe("1 second");
  });

  it("formats minute-scale durations as minutes", () => {
    expect(formatRetryTime(180)).toBe("3 minutes");
  });

  it("formats a single minute in the singular", () => {
    expect(formatRetryTime(60)).toBe("1 minute");
  });

  it("rounds to the nearest whole second below a minute", () => {
    expect(formatRetryTime(44.6)).toBe("45 seconds");
  });

  it("rounds to the nearest whole minute at or above a minute", () => {
    expect(formatRetryTime(89)).toBe("1 minute");
    expect(formatRetryTime(91)).toBe("2 minutes");
  });

  it("floors at 1 second for a zero or negative input rather than reading as already expired", () => {
    expect(formatRetryTime(0)).toBe("1 second");
    expect(formatRetryTime(-5)).toBe("1 second");
  });
});
