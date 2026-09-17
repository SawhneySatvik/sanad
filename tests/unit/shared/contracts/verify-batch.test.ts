import { describe, expect, it } from "vitest";
import { MAX_QUOTE_CHARS } from "@/server/deterministic/verify";
import { MAX_BATCH_CITATIONS, MAX_BATCH_DOCUMENTS } from "@/server/services/verify-batch";
import {
  VERIFY_BATCH_MAX_CITATIONS,
  VERIFY_BATCH_MAX_DOCUMENT_ID_CHARS,
  VERIFY_BATCH_MAX_DOCUMENTS,
  VERIFY_BATCH_MAX_QUOTE_CHARS,
  VerifyBatchInput,
  VerifyBatchOutput,
} from "@/shared/contracts/verify-batch";

const ID = "0192f5a4-3c6e-7b1d-8a2f-4e5d6c7b8a90";
const citation = (documentId = ID, quote = "one month's notice") => ({ documentId, quote });
const ids = (n: number) => Array.from({ length: n }, (_, i) => `0192f5a4-3c6e-7b1d-8a2f-${String(i).padStart(12, "0")}`);

describe("VerifyBatchInput", () => {
  it("uses the service's caps and verify()'s quote limit — the same numbers, not a second opinion", () => {
    expect(VERIFY_BATCH_MAX_CITATIONS).toBe(MAX_BATCH_CITATIONS);
    expect(VERIFY_BATCH_MAX_DOCUMENTS).toBe(MAX_BATCH_DOCUMENTS);
    expect(VERIFY_BATCH_MAX_QUOTE_CHARS).toBe(MAX_QUOTE_CHARS);
  });

  it("accepts a batch at every cap exactly", () => {
    const documentIds = ids(VERIFY_BATCH_MAX_DOCUMENTS);
    const atCaps = Array.from({ length: VERIFY_BATCH_MAX_CITATIONS }, (_, i) => citation(documentIds[i % documentIds.length]));
    atCaps[0] = citation(documentIds[0], "q".repeat(VERIFY_BATCH_MAX_QUOTE_CHARS));
    expect(VerifyBatchInput.safeParse({ citations: atCaps }).success).toBe(true);
    expect(VerifyBatchInput.safeParse({ citations: [] }).success).toBe(true);
  });

  it("rejects each cap exceeded by one", () => {
    const over = [
      Array.from({ length: VERIFY_BATCH_MAX_CITATIONS + 1 }, () => citation()),
      ids(VERIFY_BATCH_MAX_DOCUMENTS + 1).map((id) => citation(id)),
      [citation(ID, "q".repeat(VERIFY_BATCH_MAX_QUOTE_CHARS + 1))],
      [citation("x".repeat(VERIFY_BATCH_MAX_DOCUMENT_ID_CHARS + 1))],
    ];
    for (const citations of over) expect(VerifyBatchInput.safeParse({ citations }).success).toBe(false);
  });

  it("a malformed document id is accepted — the service answers not_found for it, not the contract a 400", () => {
    expect(VerifyBatchInput.safeParse({ citations: [citation("not-a-uuid"), citation("")] }).success).toBe(true);
  });

  it("is strict: a client-sent status, span, text or cached status is rejected, never read", () => {
    const smuggled = [
      { ...citation(), status: "verified" },
      { ...citation(), unverifiedCachedStatus: "cached_verified" },
      { ...citation(), spanStart: 0, spanEnd: 4 },
      { ...citation(), canonicalText: "one month's notice" },
    ];
    for (const extra of smuggled) expect(VerifyBatchInput.safeParse({ citations: [extra] }).success).toBe(false);
    expect(VerifyBatchInput.safeParse({ citations: [citation()], status: "verified" }).success).toBe(false);
    expect(VerifyBatchInput.safeParse({ citations: [{ quote: "q" }] }).success).toBe(false);
  });
});

describe("VerifyBatchOutput", () => {
  it("carries only VerificationOutput per result: a document id or reason is stripped", () => {
    const notFound = {
      status: "not_found",
      spanStart: null,
      spanEnd: null,
      spanText: null,
      claimedQuote: "q",
      verifierVersion: "2.0.0",
    };
    const parsed = VerifyBatchOutput.parse({ results: [{ ...notFound, documentId: ID, reason: "not_owned" }] });
    expect(parsed).toEqual({ results: [notFound] });
  });
});
