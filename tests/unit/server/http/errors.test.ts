// mapError()/errorResponse(): reason and retryAfterSeconds both land in the JSON body, alongside
// the existing Retry-After header, and the two always agree exactly (rounded up, omitted when zero
// or negative) — an SSE error frame has no headers of its own, so the body is the only place a
// stream consumer ever sees either.

import { describe, expect, it } from "vitest";
import { AppError } from "@/server/core/errors";
import { errorResponse, mapError } from "@/server/http/errors";

describe("mapError — reason", () => {
  it("copies reason into body.error when the AppError carries one", () => {
    const mapped = mapError(new AppError("INVALID_DOCUMENT", "bad", { reason: "too_large" }));
    expect(mapped.body.error).toMatchObject({ code: "INVALID_DOCUMENT", reason: "too_large" });
  });

  it("omits reason entirely when the AppError doesn't carry one", () => {
    const mapped = mapError(new AppError("NOT_FOUND", "gone"));
    expect(mapped.body.error).not.toHaveProperty("reason");
  });
});

describe("mapError — retryAfterSeconds", () => {
  it("copies a positive value into body.error, rounded up", () => {
    const mapped = mapError(new AppError("UPSTREAM_UNAVAILABLE", "busy", { retryAfterSeconds: 14.2 }));
    expect(mapped.body.error).toMatchObject({ retryAfterSeconds: 15 });
    expect(mapped.retryAfterSeconds).toBe(15);
  });

  it("omits retryAfterSeconds from the body when unset, zero or negative", () => {
    for (const retryAfterSeconds of [undefined, 0, -5]) {
      const mapped = mapError(new AppError("UPSTREAM_UNAVAILABLE", "busy", { retryAfterSeconds }));
      expect(mapped.body.error).not.toHaveProperty("retryAfterSeconds");
      expect(mapped.retryAfterSeconds).toBeUndefined();
    }
  });
});

describe("errorResponse — the header and the body always agree", () => {
  it("a positive retryAfterSeconds: same rounded number in the Retry-After header and body.error.retryAfterSeconds", async () => {
    const mapped = mapError(new AppError("RATE_LIMITED", "slow down", { retryAfterSeconds: 29.6 }));
    const res = errorResponse(mapped, "corr-1");

    expect(res.headers.get("retry-after")).toBe("30");
    const body = (await res.json()) as { error: { retryAfterSeconds?: number } };
    expect(body.error.retryAfterSeconds).toBe(30);
  });

  it("no retryAfterSeconds: neither the header nor the body carries one", async () => {
    const mapped = mapError(new AppError("VALIDATION_FAILED", "bad request"));
    const res = errorResponse(mapped, "corr-2");

    expect(res.headers.has("retry-after")).toBe(false);
    const body = (await res.json()) as { error: Record<string, unknown> };
    expect(body.error).not.toHaveProperty("retryAfterSeconds");
  });
});

describe("mapError — a generic (non-AppError) failure", () => {
  it("never leaks a reason or retryAfterSeconds it doesn't have", () => {
    const mapped = mapError(new TypeError("boom"));
    expect(mapped.body.error).toEqual({ code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." });
    expect(mapped.retryAfterSeconds).toBeUndefined();
  });
});
