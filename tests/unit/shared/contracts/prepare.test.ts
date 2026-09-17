import { describe, expect, it } from "vitest";
import { PrepareOutput, PrepareQuery } from "@/shared/contracts/prepare";

const finding = {
  id: "0a0a0a0a-0000-4000-8000-00000000000a",
  category: "obligation",
  verification: { status: "verified", spanStart: 4, spanEnd: 8, spanText: "rent", verifierVersion: "2.0.0" },
};

const complete = {
  state: "complete",
  documentId: "0b0b0b0b-0000-4000-8000-00000000000b",
  lens: { id: "tenant_already_signed", role: "tenant", stage: "already_signed" },
  lawyerQuestions: [
    {
      question: "Is the fee refundable?",
      whyItMatters: "It affects your deposit.",
      provenance: "ai_generated",
      findingIds: [finding.id],
      findings: [finding],
    },
  ],
  checklist: [{ item: "Confirm the monthly fee.", provenance: "ai_generated", findingIds: [finding.id], findings: [finding] }],
  modelUsed: "gemini-2.5-flash",
  promptVersion: "prepare-v1",
  markdown: "# Prepare for your lawyer",
};

describe("PrepareOutput — three distinct typed states", () => {
  it("accepts a complete result with lawyerQuestions/checklist/markdown", () => {
    expect(PrepareOutput.safeParse(complete).success).toBe(true);
  });

  it("accepts not_analyzed and no_grounded_findings with only state + documentId", () => {
    expect(PrepareOutput.safeParse({ state: "not_analyzed", documentId: complete.documentId }).success).toBe(true);
    expect(PrepareOutput.safeParse({ state: "no_grounded_findings", documentId: complete.documentId }).success).toBe(true);
  });

  it("not_analyzed/no_grounded_findings never carry lawyerQuestions/checklist — no empty list stands in for them", () => {
    const parsedNotAnalyzed = PrepareOutput.parse({
      state: "not_analyzed",
      documentId: complete.documentId,
      lawyerQuestions: [],
      checklist: [],
      markdown: "sneaked in",
    });
    expect(parsedNotAnalyzed).toEqual({ state: "not_analyzed", documentId: complete.documentId });
    expect("lawyerQuestions" in parsedNotAnalyzed).toBe(false);
    expect("markdown" in parsedNotAnalyzed).toBe(false);
  });

  it("rejects an unknown state — the union is exactly these three", () => {
    expect(PrepareOutput.safeParse({ state: "in_progress", documentId: complete.documentId }).success).toBe(false);
  });

  it("a finding's verification is prepareService's own shape, never the shared VerificationOutput's claimedQuote", () => {
    // No claimedQuote key exists on this shape at all — approximate/not_found aren't offered to the
    // model in the first place (prepare.ts's isEligible), so there is never a model claim to show.
    const withClaimed = { ...finding, verification: { ...finding.verification, claimedQuote: "model text" } };
    const parsed = PrepareOutput.parse({ ...complete, lawyerQuestions: [{ ...complete.lawyerQuestions[0], findings: [withClaimed] }] });
    expect(parsed.state === "complete" && "claimedQuote" in (parsed.lawyerQuestions[0]?.findings[0]?.verification ?? {})).toBe(false);
  });

  it("accepts an approximate finding (non-null spans, no claimedQuote key)", () => {
    const approximate = { ...finding, verification: { status: "approximate", spanStart: 10, spanEnd: 20, spanText: "close enough", verifierVersion: "2.0.0" } };
    const parsed = PrepareOutput.parse({
      ...complete,
      checklist: [{ item: "Check this wording.", provenance: "ai_generated", findingIds: [finding.id], findings: [approximate] }],
    });
    expect(parsed.state === "complete" && parsed.checklist[0].findings[0].verification).toEqual(approximate.verification);
  });

  // prepare.ts's isEligible guarantees a "not_found" finding is never offered to the model, but if a
  // service regression ever did produce one, the contract must reject it (a 500 at the route, never
  // a silently-accepted malformed citation). Same for null spans on a verified/approximate status.
  it("rejects not_found (never emitted) and null spans on verified/approximate — a service regression must fail loud", () => {
    const notFound = { ...finding, verification: { status: "not_found", spanStart: null, spanEnd: null, spanText: null, claimedQuote: "x", verifierVersion: "2.0.0" } };
    expect(
      PrepareOutput.safeParse({ ...complete, checklist: [{ item: "x", provenance: "ai_generated", findingIds: [finding.id], findings: [notFound] }] })
        .success,
    ).toBe(false);

    const nullSpans = { ...finding, verification: { status: "verified", spanStart: null, spanEnd: null, spanText: null, verifierVersion: "2.0.0" } };
    expect(
      PrepareOutput.safeParse({ ...complete, checklist: [{ item: "x", provenance: "ai_generated", findingIds: [finding.id], findings: [nullSpans] }] })
        .success,
    ).toBe(false);
  });

  it("a missing_clause finding carries verification: null", () => {
    const missingClause = { id: finding.id, category: "missing_clause", verification: null };
    expect(
      PrepareOutput.safeParse({
        ...complete,
        checklist: [{ item: "Ask about stamp duty.", provenance: "ai_generated", findingIds: [finding.id], findings: [missingClause] }],
      }).success,
    ).toBe(true);
  });

  it("rejects a checklist item / lawyerQuestion whose provenance is missing or not the literal ai_generated", () => {
    expect(
      PrepareOutput.safeParse({ ...complete, checklist: [{ item: "x", findingIds: [finding.id], findings: [finding] }] }).success,
    ).toBe(false);
    expect(
      PrepareOutput.safeParse({
        ...complete,
        checklist: [{ item: "x", provenance: "templated", findingIds: [finding.id], findings: [finding] }],
      }).success,
    ).toBe(false);
  });

  it("rejects an unrecognized document category", () => {
    expect(
      PrepareOutput.safeParse({
        ...complete,
        lawyerQuestions: [{ ...complete.lawyerQuestions[0], findings: [{ ...finding, category: "penalty_box" }] }],
      }).success,
    ).toBe(false);
  });

  it("a complete result echoes the lens it was written for — id, role and a closed set of stages", () => {
    const parsed = PrepareOutput.parse(complete);
    expect(parsed.state === "complete" && parsed.lens).toEqual(complete.lens);
  });

  it("rejects a complete result missing lens, and rejects an unrecognized stage", () => {
    const withoutLens: Record<string, unknown> = { ...complete };
    delete withoutLens.lens;
    expect(PrepareOutput.safeParse(withoutLens).success).toBe(false);
    expect(PrepareOutput.safeParse({ ...complete, lens: { ...complete.lens, stage: "mid_signature" } }).success).toBe(false);
  });
});

describe("PrepareQuery — the optional ?lens= query", () => {
  it("accepts a real lens id and no lens at all", () => {
    expect(PrepareQuery.safeParse({ lens: "tenant_already_signed" }).success).toBe(true);
    expect(PrepareQuery.safeParse({}).success).toBe(true);
  });

  it("accepts a lens id belonging to a different document type — services/prepare.ts checks it against THIS document's own type, after the ownership check", () => {
    // job_offer_letter's lens, sent for what may turn out to be a leave_and_license document.
    expect(PrepareQuery.safeParse({ lens: "employee_about_to_sign" }).success).toBe(true);
  });

  it("rejects a lens id that names no lens of any document type", () => {
    expect(PrepareQuery.safeParse({ lens: "not_a_real_lens" }).success).toBe(false);
    expect(PrepareQuery.safeParse({ lens: "" }).success).toBe(false);
  });

  it("rejects a non-string lens and an unknown key (strict)", () => {
    expect(PrepareQuery.safeParse({ lens: 123 }).success).toBe(false);
    expect(PrepareQuery.safeParse({ lens: "tenant_already_signed", extra: "x" }).success).toBe(false);
  });
});
