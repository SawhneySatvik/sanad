// policy.ts's reason mapping: assertUploadAllowed maps an unsupported MIME type to unsupported_type
// and an over-cap declared size to too_large; assertWrittenSizeAllowed splits its own combined check
// by reason — a non-positive actual byte count is empty (the real zero-byte-content case, since the
// declared-size contract already rejects a non-positive declared size before this point), an
// over-cap one is too_large.

import { describe, expect, it } from "vitest";
import { assertUploadAllowed, assertWrittenSizeAllowed, MAX_UPLOAD_SIZE_BYTES } from "@/server/storage/policy";

function caught(fn: () => void): { code: string; reason: string | undefined } {
  try {
    fn();
  } catch (error) {
    return error as { code: string; reason: string | undefined };
  }
  throw new Error("expected a throw");
}

describe("assertUploadAllowed", () => {
  it("an unsupported declared MIME type: INVALID_DOCUMENT/unsupported_type", () => {
    const error = caught(() => assertUploadAllowed({ filename: "x.zip", mimeType: "application/zip", sizeBytes: 100 }));
    expect(error).toMatchObject({ code: "INVALID_DOCUMENT", reason: "unsupported_type" });
  });

  it("a declared size one byte over the cap: INVALID_DOCUMENT/too_large", () => {
    const error = caught(() => assertUploadAllowed({ filename: "x.pdf", mimeType: "application/pdf", sizeBytes: MAX_UPLOAD_SIZE_BYTES + 1 }));
    expect(error).toMatchObject({ code: "INVALID_DOCUMENT", reason: "too_large" });
  });

  it("positive control: an allowed type within the cap does not throw", () => {
    expect(() => assertUploadAllowed({ filename: "x.pdf", mimeType: "application/pdf", sizeBytes: 100 })).not.toThrow();
  });
});

describe("assertWrittenSizeAllowed", () => {
  it("a zero-byte relay: INVALID_DOCUMENT/empty", () => {
    const error = caught(() => assertWrittenSizeAllowed(0));
    expect(error).toMatchObject({ code: "INVALID_DOCUMENT", reason: "empty" });
  });

  it("a written size over the cap: INVALID_DOCUMENT/too_large", () => {
    const error = caught(() => assertWrittenSizeAllowed(MAX_UPLOAD_SIZE_BYTES + 1));
    expect(error).toMatchObject({ code: "INVALID_DOCUMENT", reason: "too_large" });
  });

  it("positive control: a size within range does not throw", () => {
    expect(() => assertWrittenSizeAllowed(100)).not.toThrow();
  });
});
