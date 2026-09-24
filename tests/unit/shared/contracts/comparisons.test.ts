import { describe, expect, it } from "vitest";
import { ComparisonOutput, ComparisonWithChangesOutput, CreateComparisonInput } from "@/shared/contracts/comparisons";

const verified = { status: "verified", spanStart: 4, spanEnd: 8, spanText: "rent", verifierVersion: "2.0.0", textHash: "h" };

const comparison = {
  id: "0a0a0a0a-0000-4000-8000-00000000000a",
  title: "Lease A vs Lease B",
  titleA: "Lease A",
  titleB: "Lease B",
  documentAId: "0b0b0b0b-0000-4000-8000-00000000000b",
  documentBId: "0c0c0c0c-0000-4000-8000-00000000000c",
  modelUsed: "gemini-2.5-flash",
  createdAt: "2026-09-23T10:00:00.000Z",
  expiresAt: null,
  changes: [
    {
      id: "0d0d0d0d-0000-4000-8000-00000000000d",
      changeType: "changed",
      explanation: "The fee changed.",
      explanationProvenance: "ai_generated",
      verificationA: verified,
      verificationB: verified,
    },
  ],
};

describe("CreateComparisonInput is strict — a client never supplies modelUsed, status or a span", () => {
  const input = { documentAId: "0b0b0b0b-0000-4000-8000-00000000000b", documentBId: "0c0c0c0c-0000-4000-8000-00000000000c" };

  it("accepts the two document ids it names", () => {
    expect(CreateComparisonInput.parse(input)).toEqual(input);
  });

  it.each(["modelUsed", "status", "verification", "quoteA"])("rejects a `%s` key", (key) => {
    expect(CreateComparisonInput.safeParse({ ...input, [key]: "x" }).success).toBe(false);
  });

  it("rejects an empty or oversized document id, but not a non-guid-shaped one", () => {
    // Deliberate: the format check is loose so a malformed body id gets the same NOT_FOUND
    // compare.ts's repository layer gives a foreign or missing one, not a distinguishing 400 — a
    // strict z.guid() here would break byte-identical 404s (comparisons.idor.test.ts asserts this).
    expect(CreateComparisonInput.safeParse({ ...input, documentAId: "" }).success).toBe(false);
    expect(CreateComparisonInput.safeParse({ ...input, documentAId: "x".repeat(65) }).success).toBe(false);
    expect(CreateComparisonInput.safeParse({ ...input, documentAId: "not-a-uuid" }).success).toBe(true);
  });
});

describe("ComparisonWithChangesOutput / ComparisonOutput — one shape for both routes", () => {
  it("accepts a full comparison with verified changes on both sides", () => {
    expect(ComparisonWithChangesOutput.safeParse(comparison).success).toBe(true);
    expect(ComparisonOutput.safeParse(comparison).success).toBe(true);
  });

  it("accepts a change with a null verification on one side (added/removed) — that IS the absence signal", () => {
    const added = {
      ...comparison,
      changes: [{ ...comparison.changes[0], changeType: "added", verificationA: null }],
    };
    expect(ComparisonWithChangesOutput.safeParse(added).success).toBe(true);
  });

  it("rejects a status a comparison change cannot carry, and an unknown changeType", () => {
    expect(
      ComparisonWithChangesOutput.safeParse({
        ...comparison,
        changes: [{ ...comparison.changes[0], verificationA: { ...verified, status: "trusted" } }],
      }).success,
    ).toBe(false);
    expect(
      ComparisonWithChangesOutput.safeParse({ ...comparison, changes: [{ ...comparison.changes[0], changeType: "unchanged" }] })
        .success,
    ).toBe(false);
  });

  it("modelUsed carries the 'none' sentinel for identical documents (no model call)", () => {
    expect(ComparisonWithChangesOutput.safeParse({ ...comparison, modelUsed: "none", changes: [] }).success).toBe(true);
  });

  it("strips server-internal fields a service result might carry (e.g. a raw VerifyResult's quote/canonicalTextHash)", () => {
    const parsed = ComparisonWithChangesOutput.parse({
      ...comparison,
      changes: [{ ...comparison.changes[0], verificationA: { ...verified, quote: "rent", canonicalTextHash: "h", inputMode: "text" } }],
    });
    expect(parsed.changes[0].verificationA).toEqual(verified);
  });

  // The model's raw claimed quote must never ride the wire next to a verified/approximate status —
  // claimedQuote is the one sanctioned place for the model's own text. The output schema strips
  // quoteA/quoteB even though the service result still carries them internally.
  it("strips a service-internal quoteA/quoteB — they never reach the parsed output, verified or not", () => {
    const parsed = ComparisonWithChangesOutput.parse({
      ...comparison,
      changes: [{ ...comparison.changes[0], quoteA: "   Rs.     32,000/-   ", quoteB: "rent" }],
    });
    expect(Object.keys(parsed.changes[0]).sort()).toEqual([
      "changeType",
      "explanation",
      "explanationProvenance",
      "id",
      "verificationA",
      "verificationB",
    ]);
  });

  it("the change schema itself has no quoteA/quoteB key (schema-level guarantee, not just parse-time stripping)", () => {
    const shape = ComparisonWithChangesOutput.shape.changes.element.shape;
    expect(Object.keys(shape)).not.toContain("quoteA");
    expect(Object.keys(shape)).not.toContain("quoteB");
    expect(Object.keys(shape).sort()).toEqual([
      "changeType",
      "explanation",
      "explanationProvenance",
      "id",
      "verificationA",
      "verificationB",
    ]);
  });

  it("explanationProvenance belongs to each change, including a templated fallback after a model call", () => {
    expect(
      ComparisonWithChangesOutput.safeParse({
        ...comparison,
        changes: [comparison.changes[0], { ...comparison.changes[0], id: "0e0e0e0e-0000-4000-8000-00000000000e", explanationProvenance: "templated" }],
      }).success,
    ).toBe(true);
    expect(
      ComparisonWithChangesOutput.safeParse({
        ...comparison,
        changes: [{ ...comparison.changes[0], explanationProvenance: "verified" }],
      }).success,
    ).toBe(false);
  });
});
