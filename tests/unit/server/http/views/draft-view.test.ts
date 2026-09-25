// draftView's mapper-level guarantee: the object it returns names no status/verified key anywhere,
// at the top level or inside any section.

import { describe, expect, it } from "vitest";
import type { DraftResult } from "@/server/services/draft";
import { draftView } from "@/server/http/views/draft-view";

function fullDraft(): DraftResult {
  return {
    id: "0a0a0a0a-0000-4000-8000-00000000000a",
    title: "NDA draft",
    documentType: "nda",
    mode: "from_scratch",
    groundingDocumentId: null,
    revisionNumber: 1,
    parentDraftId: null,
    createdAt: new Date("2026-09-23T10:00:00.000Z"),
    expiresAt: null,
    modelUsed: "fake-model",
    jurisdiction: "IN",
    groundingDocumentAvailable: null,
    promptVersion: "draft-v1",
    content: "## Parties and Purpose\n\nAcme and Bob.",
    sections: [
      { key: "disclaimer", heading: "About This Draft", provenance: "templated", content: "This is a DRAFT." },
      { key: "parties_and_purpose", heading: "Parties and Purpose", provenance: "ai_generated", content: "Acme and Bob." },
    ],
  };
}

const FORBIDDEN = ["status", "verified", "verification", "quoteSpanStart", "quoteSpanEnd"];

describe("draftView", () => {
  it("passes every documented field through unchanged", () => {
    const draft = fullDraft();
    const { title, ...existingWireFields } = draft;
    expect(title).toBe("NDA draft");
    expect(draftView(draft)).toMatchObject({ ...existingWireFields, content: expect.any(String) });
  });

  it("names no status/verified key at the top level or in any section", () => {
    const view = draftView(fullDraft());
    for (const key of FORBIDDEN) expect(Object.keys(view)).not.toContain(key);
    for (const section of view.sections) {
      for (const key of FORBIDDEN) expect(Object.keys(section)).not.toContain(key);
      expect(Object.keys(section).sort()).toEqual(["content", "heading", "key", "provenance"]);
    }
  });

  it("provenance is one of exactly the two closed values", () => {
    const view = draftView(fullDraft());
    for (const section of view.sections) expect(["templated", "ai_generated"]).toContain(section.provenance);
  });
});
