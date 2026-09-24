import { describe, expect, it } from "vitest";
import { AnalyzeDocumentInput, AnalyzeDocumentOutput, DocumentWithFindingsOutput } from "@/shared/contracts/documents";

const document = {
  id: "0a0a0a0a-0000-4000-8000-00000000000a",
  title: "lease.txt",
  sampleId: null,
  projectId: null,
  filename: "lease.txt",
  mimeType: "text/plain",
  processingStatus: "ready",
  inputMode: "text",
  documentType: "leave_and_license",
  jurisdiction: "IN",
  detectionConfidence: "0.90",
  uploadedAt: "2026-09-23T10:00:00.000Z",
  expiresAt: null,
};
const analysis = {
  id: "0b0b0b0b-0000-4000-8000-00000000000b",
  promptVersion: "v1",
  modelUsed: "gemini-2.5-flash",
  createdAt: "2026-09-23T10:00:00.000Z",
};
const finding = {
  id: "0c0c0c0c-0000-4000-8000-00000000000c",
  category: "obligation",
  explanation: "Monthly rent.",
  explanationProvenance: "ai_generated",
  lensExplanations: [{ lens: "tenant", explanation: "You pay this.", explanationProvenance: "ai_generated" }],
  verification: { status: "verified", spanStart: 12, spanEnd: 22, spanText: "Rs. 32,000", verifierVersion: "2.0.0", textHash: "h" },
  modelUsed: "gemini-2.5-flash",
};

describe("DocumentWithFindingsOutput: not analysed is never 'analysed, nothing found'", () => {
  it("accepts not_analyzed with findings: null, and complete with findings: []", () => {
    expect(
      DocumentWithFindingsOutput.safeParse({ analysisState: "not_analyzed", document, analysis: null, findings: null })
        .success,
    ).toBe(true);
    expect(DocumentWithFindingsOutput.safeParse({ analysisState: "complete", document, analysis, findings: [] }).success).toBe(
      true,
    );
  });

  it("rejects not_analyzed with findings: [], and complete with findings: null", () => {
    expect(
      DocumentWithFindingsOutput.safeParse({ analysisState: "not_analyzed", document, analysis: null, findings: [] })
        .success,
    ).toBe(false);
    expect(
      DocumentWithFindingsOutput.safeParse({ analysisState: "complete", document, analysis, findings: null }).success,
    ).toBe(false);
  });

  it("POST /api/documents' output only admits a completed analysis", () => {
    expect(AnalyzeDocumentOutput.safeParse({ analysisState: "complete", document, analysis, findings: [finding] }).success).toBe(
      true,
    );
    expect(
      AnalyzeDocumentOutput.safeParse({ analysisState: "not_analyzed", document, analysis: null, findings: null }).success,
    ).toBe(false);
  });

  it("strips every server-internal field a service result carries — owner, ref, canonical text, raw VerifyResult fields", () => {
    const parsed = DocumentWithFindingsOutput.parse({
      analysisState: "complete",
      document: {
        ...document,
        storageRef: "guest:x/y/z",
        ownerGuestSessionId: "x",
        ownerUserId: null,
        canonicalText: "The rent is Rs. 32,000.",
        canonicalTextHash: "abc",
      },
      analysis: { ...analysis, documentId: document.id },
      findings: [
        {
          ...finding,
          quote: "Rs. 32,000",
          verification: { ...finding.verification, quote: "q", canonicalTextHash: "h", inputMode: "text", claimedQuote: "q" },
        },
      ],
    });

    expect(Object.keys(parsed.document).sort()).toEqual(Object.keys(document).sort());
    expect(Object.keys(parsed.findings?.[0] ?? {})).not.toContain("quote");
    expect(parsed.findings?.[0].verification).toEqual(finding.verification);
  });
});

describe("every explanation is labelled with its provenance", () => {
  const complete = (f: unknown) => ({ analysisState: "complete", document, analysis, findings: [f] });
  const checklistFinding = {
    id: "0d0d0d0d-0000-8000-8000-00000000000d",
    category: "missing_clause",
    explanation: "The agreement does not appear to mention stamp duty or registration.",
    explanationProvenance: "checklist",
    lensExplanations: [],
    verification: null,
    modelUsed: "none",
  };

  it("accepts a checklist gap: a missing_clause with no verification and no lens explanations", () => {
    expect(DocumentWithFindingsOutput.safeParse(complete(checklistFinding)).success).toBe(true);
  });

  it("rejects a checklist gap carrying a verification, lens explanations or another category", () => {
    const verified = { ...checklistFinding, verification: finding.verification };
    const withLens = { ...checklistFinding, lensExplanations: finding.lensExplanations };
    const obligation = { ...checklistFinding, category: "obligation" };

    for (const bad of [verified, withLens, obligation]) {
      expect(DocumentWithFindingsOutput.safeParse(complete(bad)).success).toBe(false);
    }
  });

  it("a finding or lens explanation without the label, or with any other label, does not fit", () => {
    const { explanationProvenance: _omit, ...unlabelled } = finding;
    void _omit;
    const lensUnlabelled = { ...finding, lensExplanations: [{ lens: "tenant", explanation: "x" }] };
    const templated = { ...finding, explanationProvenance: "templated" };
    const verifiedLabel = { ...finding, lensExplanations: [{ lens: "tenant", explanation: "x", explanationProvenance: "verified" }] };

    for (const bad of [unlabelled, lensUnlabelled, templated, verifiedLabel]) {
      expect(DocumentWithFindingsOutput.safeParse(complete(bad)).success).toBe(false);
    }
    expect(DocumentWithFindingsOutput.safeParse(complete(finding)).success).toBe(true);
  });
});

describe("AnalyzeDocumentInput is strict — a client never supplies a status, span or text", () => {
  const input = { storageRef: "guest:x/y/z.txt", filename: "z.txt", mimeType: "text/plain" };

  it.each(["status", "verification", "canonicalText", "quoteSpanStart", "findings"])("rejects a `%s` key", (key) => {
    expect(AnalyzeDocumentInput.safeParse({ ...input, [key]: "verified" }).success).toBe(false);
  });

  it("accepts the three fields it names", () => {
    expect(AnalyzeDocumentInput.parse(input)).toEqual(input);
  });
});
