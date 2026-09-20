// describeError writes into the committed live-validation outputs, so a non-AppError's message goes
// through the same key redaction as the provider-error summary before it is capped.

import { describe, expect, it } from "vitest";
import { AppError } from "@/server/core/errors";
import { describeError } from "../../../../scripts/validate-live/harness";

describe("describeError", () => {
  it("redacts key-shaped text in a non-AppError message", () => {
    const keys = ["AIzaSyTESTnotARealKey0123456789abcdef", "nvapi-TESTnotARealKey0123", "sk-or-v1-TESTnotARealKey0123"];

    const described = describeError(new TypeError(`fetch failed for key=${keys[0]} (${keys[1]}, ${keys[2]})`));

    expect(described).toBe("TypeError: fetch failed for key=[redacted] ([redacted], [redacted])");
  });

  it("caps the redacted message at 200 characters and keeps an AppError's fixed message as-is", () => {
    expect(describeError(new Error("word ".repeat(100)))).toBe(`Error: ${"word ".repeat(40)}`);
    expect(describeError(new AppError("TIMEOUT", "The request timed out."))).toBe("TIMEOUT: The request timed out.");
    expect(describeError("thrown string")).toBe("non-Error thrown");
  });
});
