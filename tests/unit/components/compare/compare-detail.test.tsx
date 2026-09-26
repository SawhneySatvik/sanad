// Regression guard for the phone tab bar: the trigger and the visible panel share one controlled
// `value` (phoneTab), so selecting a change from the Changes tab must always leave the SAME tab
// marked active as the one now showing — never "Changes" highlighted while Document A's panel
// shows instead.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { CompareDetail } from "@/components/compare/compare-detail";
import type { ComparisonWithChangesOutput } from "@/shared/contracts/comparisons";
import type { DocumentTextOutput } from "@/shared/contracts/document-text";

const DOC_A = "11111111-1111-4111-8111-111111111111";
const DOC_B = "22222222-2222-4222-8222-222222222222";
const TEXT_A: DocumentTextOutput = { documentId: DOC_A, text: "The monthly fee is Rs. 10,000, payable monthly.", textHash: "hash-a", inputMode: "text", sampleId: null };
const TEXT_B: DocumentTextOutput = { documentId: DOC_B, text: "The monthly fee is Rs. 15,000, payable monthly.", textHash: "hash-b", inputMode: "text", sampleId: null };

const comparison: ComparisonWithChangesOutput = {
  id: "cmp-1",
  title: "before.txt vs after.txt",
  titleA: "before.txt",
  titleB: "after.txt",
  documentAId: DOC_A,
  documentBId: DOC_B,
  modelUsed: "gemini-2.5-flash",
  createdAt: new Date().toISOString(),
  expiresAt: null,
  changes: [
    {
      id: "c1",
      changeType: "changed",
      explanation: "The monthly fee changed from Rs. 10,000 to Rs. 15,000.",
      explanationProvenance: "ai_generated",
      verificationA: { status: "verified", spanStart: 19, spanEnd: 29, spanText: "Rs. 10,000", verifierVersion: "v1", textHash: "hash-a" },
      verificationB: { status: "verified", spanStart: 19, spanEnd: 29, spanText: "Rs. 15,000", verifierVersion: "v1", textHash: "hash-b" },
    },
  ],
};

describe("CompareDetail — phone tab bar stays in sync with the visible panel", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("selecting a change from the Changes tab activates Document A's own tab, never leaving Changes marked active", async () => {
    const user = userEvent.setup();
    render(
      <LiveRegionProvider>
        <CompareDetail comparison={comparison} textA={TEXT_A} textB={TEXT_B} />
      </LiveRegionProvider>,
    );

    await user.click(screen.getByRole("tab", { name: "Changes" }));
    await user.click(screen.getByRole("button", { name: "Summary of changes (1)" }));
    await user.click(screen.getByRole("button", { name: "Show this change" }));

    const tabA = screen.getByRole("tab", { name: "Document A" });
    const tabChanges = screen.getByRole("tab", { name: "Changes" });
    expect(tabA).toHaveAttribute("aria-selected", "true");
    expect(tabChanges).toHaveAttribute("aria-selected", "false");
  });
});
