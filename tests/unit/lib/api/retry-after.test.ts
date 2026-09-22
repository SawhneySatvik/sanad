import { describe, expect, it } from "vitest";
import { parseRetryAfterHeader } from "@/lib/api/retry-after";

describe("parseRetryAfterHeader", () => {
  it("returns undefined for a missing header", () => {
    expect(parseRetryAfterHeader(null)).toBeUndefined();
  });

  it("parses the delta-seconds form", () => {
    expect(parseRetryAfterHeader("120")).toBe(120);
  });

  it("treats a zero or negative delta-seconds value as absent", () => {
    expect(parseRetryAfterHeader("0")).toBeUndefined();
    expect(parseRetryAfterHeader("-5")).toBeUndefined();
  });

  it("parses the HTTP-date form into a positive delta from now", () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const seconds = parseRetryAfterHeader(future);
    expect(seconds).toBeGreaterThanOrEqual(58);
    expect(seconds).toBeLessThanOrEqual(60);
  });

  it("treats an HTTP-date already in the past as absent", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfterHeader(past)).toBeUndefined();
  });

  it("treats an unparseable string as absent", () => {
    expect(parseRetryAfterHeader("not-a-valid-header")).toBeUndefined();
  });
});
