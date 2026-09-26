// buildPrepareCopyText() feeds ExportMenu's Copy action (plain text) — deliberately different from
// prepare.markdown (escaped Markdown, the Download action's own source). Never escapes punctuation,
// never states a status word, and looks citations up the same way FindingCitation does.

import { describe, expect, it } from "vitest";
import { buildPrepareCopyText } from "@/components/prepare/build-prepare-copy-text";
import type { FindingOutput } from "@/shared/contracts/documents";
import type { PrepareCompleteOutput } from "@/components/prepare/types";

const FINDING: FindingOutput = {
  id: "66666666-6666-4666-8666-666666666666",
  category: "obligation",
  explanation: "Explains the lock-in period.",
  explanationProvenance: "ai_generated",
  lensExplanations: [],
  modelUsed: "gemini-2.5-flash",
  verification: {
    status: "verified",
    spanStart: 0,
    spanEnd: 20,
    spanText: "an eleven-month lock-in period?",
    verifierVersion: "v1",
    textHash: "hash-d",
  },
};

const NOT_FOUND_FINDING: FindingOutput = {
  id: "77777777-7777-4777-8777-777777777777",
  category: "ambiguity",
  explanation: "A claim the model made up.",
  explanationProvenance: "ai_generated",
  lensExplanations: [],
  modelUsed: "gemini-2.5-flash",
  verification: {
    status: "not_found",
    spanStart: null,
    spanEnd: null,
    spanText: null,
    claimedQuote: "a fabricated clause",
    verifierVersion: "v1",
    textHash: "hash-e",
  },
};

function prepareFixture(): PrepareCompleteOutput {
  return {
    state: "complete",
    documentId: "88888888-8888-4888-8888-888888888888",
    lens: { id: "tenant_about_to_sign", role: "tenant", stage: "about_to_sign" },
    lawyerQuestions: [
      {
        question: "What is the lock-in period?",
        whyItMatters: "It limits when you can leave without penalty.",
        provenance: "ai_generated",
        findingIds: [FINDING.id],
        findings: [{ id: FINDING.id, category: FINDING.category, verification: { status: "verified", spanStart: 0, spanEnd: 20, spanText: "irrelevant", verifierVersion: "v1" } }],
      },
    ],
    checklist: [
      {
        item: "Confirm the lock-in period with the landlord.",
        provenance: "ai_generated",
        findingIds: [NOT_FOUND_FINDING.id],
        findings: [{ id: NOT_FOUND_FINDING.id, category: NOT_FOUND_FINDING.category, verification: null }],
      },
    ],
    modelUsed: "gemini-2.5-flash",
    promptVersion: "prepare-v4",
    markdown: "# Prepare for your lawyer\n\nlock\\-in period\\?",
  };
}

describe("buildPrepareCopyText", () => {
  it("includes the lens header, question, whyItMatters and checklist item text, unescaped", () => {
    const text = buildPrepareCopyText(prepareFixture(), [FINDING, NOT_FOUND_FINDING]);
    expect(text).toContain("Prepared for: Tenant, before signing");
    expect(text).toContain("What is the lock-in period?");
    expect(text).toContain("It limits when you can leave without penalty.");
    expect(text).toContain("Confirm the lock-in period with the landlord.");
    // Never backslash-escaped, unlike the Markdown export.
    expect(text).not.toContain("lock\\-in");
    expect(text).not.toContain("period\\?");
  });

  it("includes the real finding's spanText for a verified citation, looked up from documentFindings", () => {
    const text = buildPrepareCopyText(prepareFixture(), [FINDING, NOT_FOUND_FINDING]);
    expect(text).toContain("an eleven-month lock-in period?");
  });

  it("never states a status word of its own — no 'Verified'/'Approximate' anywhere", () => {
    const text = buildPrepareCopyText(prepareFixture(), [FINDING, NOT_FOUND_FINDING]);
    expect(text).not.toMatch(/\bVerified\b/);
    expect(text).not.toMatch(/\bApproximate\b/);
  });

  it("omits a citation line for a not_found finding (nothing to quote)", () => {
    const text = buildPrepareCopyText(prepareFixture(), [FINDING, NOT_FOUND_FINDING]);
    expect(text).not.toContain("a fabricated clause");
  });

  it("diverges from prepare.markdown — Copy is plain text, Download is Markdown", () => {
    const fixture = prepareFixture();
    const text = buildPrepareCopyText(fixture, [FINDING, NOT_FOUND_FINDING]);
    expect(text).not.toBe(fixture.markdown);
  });
});
