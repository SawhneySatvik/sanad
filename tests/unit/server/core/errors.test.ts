import { describe, expect, it } from "vitest";
import { AppError, APP_ERROR_CODES, httpStatusFor, notFound, safeMessageFor } from "@/server/core/errors";

describe("AppError", () => {
  it("carries the code and message it was constructed with", () => {
    const err = new AppError("VALIDATION_FAILED", "bad input");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.message).toBe("bad input");
    expect(err.retryAfterSeconds).toBeUndefined();
  });

  it("carries an optional retryAfterSeconds", () => {
    const err = new AppError("RATE_LIMITED", "slow down", { retryAfterSeconds: 30 });
    expect(err.retryAfterSeconds).toBe(30);
  });
});

describe("httpStatusFor", () => {
  it("maps every code to its documented HTTP status, in order", () => {
    expect(httpStatusFor("NOT_FOUND")).toBe(404);
    expect(httpStatusFor("VALIDATION_FAILED")).toBe(400);
    expect(httpStatusFor("RATE_LIMITED")).toBe(429);
    expect(httpStatusFor("UPSTREAM_UNAVAILABLE")).toBe(503);
    expect(httpStatusFor("TIMEOUT")).toBe(504);
    expect(httpStatusFor("INVALID_DOCUMENT")).toBe(422);
    expect(httpStatusFor("EXTRACTION_FAILED")).toBe(422);
    expect(httpStatusFor("SCHEMA_FAILED")).toBe(502);
  });

  it("has a status for every declared code — no gaps", () => {
    for (const code of APP_ERROR_CODES) {
      expect(typeof httpStatusFor(code)).toBe("number");
    }
  });
});

// Type-level assertion: safeMessageFor's parameter type is exactly
// AppErrorCode, a closed union — there is no runtime code path where an
// arbitrary/raw string (let alone raw exception text) could reach it in the
// first place. (A prior runtime test here iterated only valid codes and
// asserted properties every fixed dictionary string trivially satisfies —
// it could never fail, so it proved nothing. This is what actually backs
// the "never returns a raw exception message" claim.)
// @ts-expect-error — a bare string is not assignable to AppErrorCode
void safeMessageFor("SOME_RANDOM_UNSANCTIONED_CODE");

describe("safeMessageFor", () => {
  it("returns a fixed, non-empty string per code, distinct across codes", () => {
    const messages = APP_ERROR_CODES.map(safeMessageFor);
    for (const message of messages) {
      expect(typeof message).toBe("string");
      expect(message.length).toBeGreaterThan(0);
    }
    expect(new Set(messages).size).toBe(APP_ERROR_CODES.length);
  });
});

describe("notFound()", () => {
  it("constructs a NOT_FOUND AppError with the safe default message", () => {
    const err = notFound();
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe(safeMessageFor("NOT_FOUND"));
    expect(httpStatusFor(err.code)).toBe(404);
  });

  it("accepts a custom message while keeping the NOT_FOUND code", () => {
    const err = notFound("custom message");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe("custom message");
  });
});
