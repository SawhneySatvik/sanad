import { describe, expect, it } from "vitest";
import { APP_ERROR_CODES } from "@/server/core/errors";
import { ErrorBody, FORBIDDEN_CODE, IdParams, INTERNAL_ERROR_CODE, VerificationOutput } from "@/shared/contracts/common";
import { HealthOutput } from "@/shared/contracts/health";

describe("IdParams", () => {
  it("accepts any 8-4-4-4-12 hex id, the set the repositories look up", () => {
    expect(IdParams.safeParse({ id: "0a0a0a0a-0000-4000-8000-00000000000a" }).success).toBe(true);
    expect(IdParams.safeParse({ id: "0A0A0A0A-0000-7000-0000-00000000000A" }).success).toBe(true);
  });

  it.each(["not-a-uuid", "", "0a0a0a0a-0000-4000-8000-00000000000", "0a0a0a0a00004000800000000000000a", "../x"])(
    "rejects %j",
    (id) => {
      expect(IdParams.safeParse({ id }).success).toBe(false);
    },
  );
});

describe("ErrorBody", () => {
  it("admits every AppError code plus the internal and cross-site-refusal codes, and nothing else", () => {
    for (const code of [...APP_ERROR_CODES, INTERNAL_ERROR_CODE, FORBIDDEN_CODE]) {
      expect(ErrorBody.safeParse({ error: { code, message: "m" } }).success).toBe(true);
    }
    expect(ErrorBody.safeParse({ error: { code: "UNAUTHORIZED", message: "m" } }).success).toBe(false);
  });
});

describe("HealthOutput", () => {
  it("is booleans only — a string value in config does not fit", () => {
    const config = { llm: true, storage: true };
    expect(HealthOutput.safeParse({ status: "ok", config }).success).toBe(true);
    expect(HealthOutput.safeParse({ status: "ok", config: { ...config, llm: "sk-123" } }).success).toBe(false);
  });
});

describe("VerificationOutput — the wire shape", () => {
  const EMPTY_TEXT_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const verified = { status: "verified", spanStart: 4, spanEnd: 8, spanText: "rent", verifierVersion: "2.0.0", textHash: EMPTY_TEXT_HASH };

  it("verified and approximate carry a span and its text; not_found carries neither", () => {
    expect(VerificationOutput.safeParse(verified).success).toBe(true);
    expect(VerificationOutput.safeParse({ ...verified, status: "approximate", claimedQuote: "rnt" }).success).toBe(true);
    const notFound = { status: "not_found", spanStart: null, spanEnd: null, spanText: null, claimedQuote: "x", verifierVersion: "2", textHash: EMPTY_TEXT_HASH };
    expect(VerificationOutput.safeParse(notFound).success).toBe(true);
    expect(VerificationOutput.safeParse({ ...verified, spanText: null }).success).toBe(false);
    expect(VerificationOutput.safeParse({ ...notFound, spanStart: 0, spanEnd: 1, spanText: "x" }).success).toBe(false);
    expect(VerificationOutput.safeParse({ ...verified, status: "trusted" }).success).toBe(false);
  });

  it("approximate and not_found must name the model's claim as claimedQuote", () => {
    expect(VerificationOutput.safeParse({ ...verified, status: "approximate" }).success).toBe(false);
  });

  it("every branch requires textHash — the source document's real hash, or the anti-oracle sentinel", () => {
    const approximate = { ...verified, status: "approximate" as const, claimedQuote: "rnt" };
    const notFound = { status: "not_found", spanStart: null, spanEnd: null, spanText: null, claimedQuote: "x", verifierVersion: "2", textHash: EMPTY_TEXT_HASH };
    for (const branch of [verified, approximate, notFound]) {
      const { textHash: _omit, ...withoutHash } = branch;
      void _omit;
      expect(VerificationOutput.safeParse(withoutHash).success, `${branch.status} without textHash`).toBe(false);
    }
  });

  it("a verified passage never carries model text: a claimedQuote or raw VerifyResult field is stripped", () => {
    const parsed = VerificationOutput.parse({
      ...verified,
      claimedQuote: "model text",
      quote: "model text",
      canonicalTextHash: "h",
      inputMode: "text",
    });
    expect(parsed).toEqual(verified);
  });
});
