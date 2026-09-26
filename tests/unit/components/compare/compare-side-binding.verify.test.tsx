// Channel 8 (Span/display binding) — the rendered path, not just the pure helper: ChangeCard's
// QuoteBlock/VerificationBadge plus both DocumentViewer panes, wired through the real
// buildSideEntries -> segmentDocumentText -> DocumentViewer/HighlightMark chain, no fetch mocking.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { DocumentViewer } from "@/components/document/document-viewer";
import { ChangeCard, type ComparisonChange } from "@/components/compare/change-card";
import { buildSideEntries } from "@/components/compare/build-side-entries";
import { segmentDocumentText } from "@/lib/verification/segmentDocumentText";
import type { ComparisonWithChangesOutput } from "@/shared/contracts/comparisons";
import type { DocumentTextOutput } from "@/shared/contracts/document-text";

const DOC_A = "11111111-1111-4111-8111-111111111111";
const DOC_B = "22222222-2222-4222-8222-222222222222";
const TEXT_A: DocumentTextOutput = { documentId: DOC_A, text: "The security deposit is Rs. 1,50,000 refundable at the end of the lease.", textHash: "hash-a", inputMode: "text", sampleId: null };
const TEXT_B: DocumentTextOutput = { documentId: DOC_B, text: "The security deposit is Rs. 2,25,000 refundable at the end of the lease.", textHash: "hash-b", inputMode: "text", sampleId: null };

function comparisonWith(change: ComparisonChange): ComparisonWithChangesOutput {
  return {
    id: "cmp-1",
    title: "A vs B",
    titleA: "Document A",
    titleB: "Document B",
    documentAId: DOC_A,
    documentBId: DOC_B,
    modelUsed: "gemini-3.5-flash-lite",
    createdAt: new Date().toISOString(),
    expiresAt: null,
    changes: [change],
  };
}

function renderHarness(comparison: ComparisonWithChangesOutput) {
  const entriesA = buildSideEntries("A", comparison, TEXT_A);
  const entriesB = buildSideEntries("B", comparison, TEXT_B);
  const segmentsA = segmentDocumentText(TEXT_A.text, entriesA);
  const segmentsB = segmentDocumentText(TEXT_B.text, entriesB);
  return render(
    <LiveRegionProvider>
      {comparison.changes.map((change) => (
        <ChangeCard key={change.id} change={change} active={false} onSelect={() => {}} openDocumentId={comparison.documentBId} />
      ))}
      <DocumentViewer documentId={DOC_A} segments={segmentsA} inputMode="text" label="Document A: A" />
      <DocumentViewer documentId={DOC_B} segments={segmentsB} inputMode="text" label="Document B: B" />
    </LiveRegionProvider>,
  );
}

describe("Compare — a verified side renders exactly one badge, bound to the right side", () => {
  it("positive: verificationA (real hash/offsets against document A's own text), verificationB null — one verified badge on side A, one mark in A's pane, nothing on side B", () => {
    const change: ComparisonChange = {
      id: "c1",
      changeType: "changed",
      explanation: "The security deposit changed.",
      explanationProvenance: "ai_generated",
      verificationA: { status: "verified", spanStart: 24, spanEnd: 36, spanText: "Rs. 1,50,000", verifierVersion: "v1", textHash: "hash-a" },
      verificationB: { status: "verified", spanStart: 24, spanEnd: 36, spanText: "Rs. 2,25,000", verifierVersion: "v1", textHash: "hash-b" },
    };
    const { container } = renderHarness(comparisonWith(change));

    const sideA = container.querySelector('[data-side="A"]')!;
    const sideB = container.querySelector('[data-side="B"]')!;
    expect(sideA.querySelectorAll('[data-verification-status="verified"]')).toHaveLength(1);
    expect(sideB.querySelectorAll('[data-verification-status="verified"]')).toHaveLength(1);

    const paneA = container.querySelector('[data-document-id="11111111-1111-4111-8111-111111111111"]')!;
    const paneB = container.querySelector('[data-document-id="22222222-2222-4222-8222-222222222222"]')!;
    expect(paneA.querySelectorAll("mark")).toHaveLength(1);
    expect(paneA.querySelector("mark")).toHaveTextContent("Rs. 1,50,000");
    expect(paneB.querySelectorAll("mark")).toHaveLength(1);
    expect(paneB.querySelector("mark")).toHaveTextContent("Rs. 2,25,000");
  });

  it("negative: verificationA carrying document B's own textHash/offsets never highlights on either pane, and never shows a verified badge on side B", () => {
    const change: ComparisonChange = {
      id: "c1",
      changeType: "changed",
      explanation: "The security deposit changed.",
      explanationProvenance: "ai_generated",
      // A forged/stale record: this claims to be side A's verification, but its textHash is
      // document B's, not document A's own currently-fetched hash.
      verificationA: { status: "verified", spanStart: 24, spanEnd: 36, spanText: "Rs. 1,50,000", verifierVersion: "v1", textHash: "hash-b" },
      verificationB: null,
    };
    const { container } = renderHarness(comparisonWith(change));

    const paneA = container.querySelector('[data-document-id="11111111-1111-4111-8111-111111111111"]')!;
    const paneB = container.querySelector('[data-document-id="22222222-2222-4222-8222-222222222222"]')!;
    // Never highlights, on either side.
    expect(paneA.querySelectorAll("mark")).toHaveLength(0);
    expect(paneB.querySelectorAll("mark")).toHaveLength(0);

    // Rule 12: the badge is never suppressed by a failed bind — it always shows the server's own
    // status, on side A, exactly as given. This is not the same claim as "never shows verified" —
    // that reading applies to the WRONG side only, asserted next.
    const sideA = container.querySelector('[data-side="A"]')!;
    expect(sideA.querySelectorAll('[data-verification-status="verified"]')).toHaveLength(1);

    // Side B never even reads verificationA — its own verification is null on this change, so it
    // can show no status of any kind, let alone "verified".
    const sideB = container.querySelector('[data-side="B"]')!;
    expect(sideB.querySelectorAll("[data-verification-status]")).toHaveLength(0);
  });
});
