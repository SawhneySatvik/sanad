// prepareView — the three typed states stay distinct on the wire, spanText is relayed exactly as
// prepareService produced it (never re-sliced/re-derived here), and a missing_clause finding's null
// verification survives the mapping.

import { describe, expect, it } from "vitest";
import type { PrepareGenerated, PrepareNoGroundedFindings, PrepareNotAnalyzed } from "@/server/services/prepare";
import { prepareView } from "@/server/http/views/prepare-view";

const document = { id: "0a0a0a0a-0000-4000-8000-00000000000a" } as PrepareGenerated["document"];
const LENS: PrepareGenerated["lens"] = { id: "tenant_already_signed", role: "tenant", stage: "already_signed", description: "d" };

function completeResult(): PrepareGenerated {
  return {
    state: "complete",
    document,
    lens: LENS,
    lawyerQuestions: [
      {
        question: "Is the fee refundable?",
        whyItMatters: "It affects your deposit.",
        findingIds: ["0b0b0b0b-0000-4000-8000-00000000000b"],
        findings: [
          {
            id: "0b0b0b0b-0000-4000-8000-00000000000b",
            category: "obligation",
            verification: { status: "verified", spanStart: 4, spanEnd: 8, spanText: "rent", verifierVersion: "2.0.0" },
          },
        ],
      },
    ],
    checklist: [
      {
        item: "Ask about stamp duty.",
        findingIds: ["0c0c0c0c-0000-4000-8000-00000000000c"],
        findings: [{ id: "0c0c0c0c-0000-4000-8000-00000000000c", category: "missing_clause", verification: null }],
      },
    ],
    modelUsed: "fake-model",
    promptVersion: "prepare-v1",
    markdown: "# Prepare for your lawyer",
  };
}

describe("prepareView", () => {
  it("complete: relays lawyerQuestions/checklist/markdown/modelUsed/promptVersion/lens unchanged, plus the ai_generated provenance label", () => {
    const result = completeResult();
    const view = prepareView(result);
    expect(view).toEqual({
      state: "complete",
      documentId: document.id,
      lens: LENS,
      lawyerQuestions: result.lawyerQuestions.map((q) => ({ ...q, provenance: "ai_generated" })),
      checklist: result.checklist.map((c) => ({ ...c, provenance: "ai_generated" })),
      modelUsed: result.modelUsed,
      promptVersion: result.promptVersion,
      markdown: result.markdown,
    });
  });

  it("echoes the lens the output was written for, exactly as generate() resolved it", () => {
    const view = prepareView(completeResult());
    expect(view.state).toBe("complete");
    if (view.state !== "complete") return;
    expect(view.lens).toEqual(LENS);
  });

  it("every lawyerQuestion and checklist item carries provenance: \"ai_generated\"", () => {
    const view = prepareView(completeResult());
    expect(view.state).toBe("complete");
    if (view.state !== "complete") return;
    expect(view.lawyerQuestions[0].provenance).toBe("ai_generated");
    expect(view.checklist[0].provenance).toBe("ai_generated");
  });

  it("spanText is relayed exactly as prepareService produced it — never re-sliced here", () => {
    const view = prepareView(completeResult());
    expect(view.state).toBe("complete");
    if (view.state !== "complete") return;
    expect(view.lawyerQuestions[0].findings[0].verification?.spanText).toBe("rent");
  });

  it("two findings on the same item keep their OWN distinct verification, not each other's", () => {
    const result = completeResult();
    result.checklist = [
      {
        item: "Confirm the monthly fee and the notice period.",
        findingIds: ["0b0b0b0b-0000-4000-8000-00000000000b", "0d0d0d0d-0000-4000-8000-00000000000d"],
        findings: [
          {
            id: "0b0b0b0b-0000-4000-8000-00000000000b",
            category: "obligation",
            verification: { status: "verified", spanStart: 4, spanEnd: 8, spanText: "rent", verifierVersion: "2.0.0" },
          },
          {
            id: "0d0d0d0d-0000-4000-8000-00000000000d",
            category: "deadline",
            verification: { status: "approximate", spanStart: 20, spanEnd: 30, spanText: "one month", verifierVersion: "2.0.0" },
          },
        ],
      },
    ];
    const view = prepareView(result);
    expect(view.state).toBe("complete");
    if (view.state !== "complete") return;
    expect(view.checklist[0].findings[0].verification).toEqual(result.checklist[0].findings[0].verification);
    expect(view.checklist[0].findings[1].verification).toEqual(result.checklist[0].findings[1].verification);
    expect(view.checklist[0].findings[0].verification?.spanText).toBe("rent");
    expect(view.checklist[0].findings[1].verification?.spanText).toBe("one month");
  });

  it("a missing_clause finding's null verification survives the mapping", () => {
    const view = prepareView(completeResult());
    expect(view.state).toBe("complete");
    if (view.state !== "complete") return;
    expect(view.checklist[0].findings[0].verification).toBeNull();
  });

  it("not_analyzed carries only state + documentId — no lawyerQuestions/checklist/markdown key at all", () => {
    const result: PrepareNotAnalyzed = { state: "not_analyzed", document };
    const view = prepareView(result);
    expect(view).toEqual({ state: "not_analyzed", documentId: document.id });
    expect("lawyerQuestions" in view).toBe(false);
    expect("markdown" in view).toBe(false);
  });

  it("no_grounded_findings carries only state + documentId", () => {
    const result: PrepareNoGroundedFindings = { state: "no_grounded_findings", document };
    const view = prepareView(result);
    expect(view).toEqual({ state: "no_grounded_findings", documentId: document.id });
  });
});
