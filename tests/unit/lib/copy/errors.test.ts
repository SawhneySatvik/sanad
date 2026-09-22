import { describe, expect, it } from "vitest";
import { APP_ERROR_CODES, safeMessageFor } from "@/server/core/errors";
import { INTERNAL_ERROR_CODE, FORBIDDEN_CODE } from "@/shared/contracts/common";
import { FORBIDDEN_MESSAGE, INTERNAL_ERROR_MESSAGE } from "@/server/http/errors";
import { canonicalErrorMessage, OFFLINE_MESSAGE, type CanonicalErrorCode } from "@/lib/copy/errors";

const ALL_CODES: CanonicalErrorCode[] = [...APP_ERROR_CODES, INTERNAL_ERROR_CODE, FORBIDDEN_CODE, "OFFLINE"];

// APP_ERROR_CODES minus RATE_LIMITED/UPSTREAM_UNAVAILABLE, which format their own copy rather than
// passing the server's message through.
const PASSTHROUGH_APP_CODES = APP_ERROR_CODES.filter((code) => code !== "RATE_LIMITED" && code !== "UPSTREAM_UNAVAILABLE");

describe("canonicalErrorMessage", () => {
  it("maps every real ErrorBody code, plus OFFLINE, to exactly one non-empty string", () => {
    for (const code of ALL_CODES) {
      const message = canonicalErrorMessage(code, { serverMessage: "server fixed message" });
      expect(typeof message).toBe("string");
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it("canonicalErrorMessage(code, {}) is non-empty for every code, even with no server message at all", () => {
    for (const code of ALL_CODES) {
      expect(canonicalErrorMessage(code, {}).length).toBeGreaterThan(0);
    }
  });

  it("mirrors the server's own fixed per-code message as the fallback when serverMessage is missing or empty", () => {
    for (const code of PASSTHROUGH_APP_CODES) {
      expect(canonicalErrorMessage(code)).toBe(safeMessageFor(code));
      expect(canonicalErrorMessage(code, { serverMessage: "" })).toBe(safeMessageFor(code));
      // A real server message still wins over the mirrored fallback.
      expect(canonicalErrorMessage(code, { serverMessage: "server fixed message" })).toBe("server fixed message");
    }
    expect(canonicalErrorMessage(INTERNAL_ERROR_CODE)).toBe(INTERNAL_ERROR_MESSAGE);
    expect(canonicalErrorMessage(FORBIDDEN_CODE)).toBe(FORBIDDEN_MESSAGE);
  });

  it("passes the server's own fixed message through unchanged for every passthrough code", () => {
    const passthroughCodes: CanonicalErrorCode[] = [
      "NOT_FOUND",
      "VALIDATION_FAILED",
      "TIMEOUT",
      "INVALID_DOCUMENT",
      "EXTRACTION_FAILED",
      "SCHEMA_FAILED",
      INTERNAL_ERROR_CODE,
      FORBIDDEN_CODE,
    ];
    for (const code of passthroughCodes) {
      expect(canonicalErrorMessage(code, { serverMessage: "The requested resource could not be found." })).toBe(
        "The requested resource could not be found.",
      );
    }
  });

  it("404 (NOT_FOUND) is always exactly the fixed sentence, never distinguishing missing from foreign", () => {
    expect(canonicalErrorMessage("NOT_FOUND", { serverMessage: "The requested resource could not be found." })).toBe(
      "The requested resource could not be found.",
    );
  });

  it("RATE_LIMITED with a retry time formats the {time} sentence", () => {
    expect(canonicalErrorMessage("RATE_LIMITED", { retryAfterSeconds: 45 })).toBe(
      "You've reached your limit for now. Try again in 45 seconds.",
    );
  });

  it("RATE_LIMITED without a retry time keeps its identifying prefix in the fallback", () => {
    expect(canonicalErrorMessage("RATE_LIMITED", {})).toBe("You've reached your limit for now. Try again in a little while.");
  });

  it("RATE_LIMITED treats a zero, negative or NaN retry time as absent", () => {
    expect(canonicalErrorMessage("RATE_LIMITED", { retryAfterSeconds: 0 })).toBe(
      "You've reached your limit for now. Try again in a little while.",
    );
    expect(canonicalErrorMessage("RATE_LIMITED", { retryAfterSeconds: -3 })).toBe(
      "You've reached your limit for now. Try again in a little while.",
    );
    expect(canonicalErrorMessage("RATE_LIMITED", { retryAfterSeconds: Number.NaN })).toBe(
      "You've reached your limit for now. Try again in a little while.",
    );
  });

  it("UPSTREAM_UNAVAILABLE with a retry time formats the {time} sentence and never says 'too many requests'", () => {
    const message = canonicalErrorMessage("UPSTREAM_UNAVAILABLE", { retryAfterSeconds: 180 });
    expect(message).toBe("The AI providers are busy right now. Try again in 3 minutes.");
    expect(message).not.toMatch(/too many requests/i);
  });

  it("UPSTREAM_UNAVAILABLE without a retry time keeps its identifying prefix in the fallback", () => {
    expect(canonicalErrorMessage("UPSTREAM_UNAVAILABLE", {})).toBe(
      "The AI providers are busy right now. Try again in a few minutes.",
    );
  });

  it("OFFLINE always renders the fixed OfflineBanner text, ignoring any server message", () => {
    expect(canonicalErrorMessage("OFFLINE", { serverMessage: "irrelevant" })).toBe(OFFLINE_MESSAGE);
    expect(OFFLINE_MESSAGE).toBe("You're offline. Saboot needs a connection to read and answer.");
  });
});
