import { describe, expect, it } from "vitest";
import { DRAFTABLE_TYPES, GROUNDED_RESPONSE_LABEL, fromScratchTypeLabel } from "@/components/draft/document-type-labels";
import { DOCUMENT_TYPE_REGISTRY } from "@/server/deterministic/document-type-registry";

// The client mirror must never drift from the server registry it copies from — this test is the
// only place that imports both, and never ships (test-only import of server code, not the browser
// bundle DraftComposer itself imports).
describe("DRAFTABLE_TYPES — parity with the server registry", () => {
  it("has exactly the five from-scratch ids, in the registry's own order, with matching labels", () => {
    const expected = DOCUMENT_TYPE_REGISTRY.filter((entry) =>
      ["leave_and_license", "job_offer_letter", "nda", "privacy_policy", "freelance_service_agreement"].includes(entry.id),
    ).map((entry) => ({ id: entry.id, label: entry.label }));

    expect(DRAFTABLE_TYPES.map((entry) => ({ id: entry.id, label: entry.label }))).toEqual(expected);
  });

  it("never lists grounded_response — it has no from-scratch meaning of its own", () => {
    expect(DRAFTABLE_TYPES.some((entry) => (entry.id as string) === "grounded_response")).toBe(false);
  });

  it("GROUNDED_RESPONSE_LABEL matches the registry's own label for grounded_response", () => {
    const entry = DOCUMENT_TYPE_REGISTRY.find((candidate) => candidate.id === "grounded_response");
    expect(GROUNDED_RESPONSE_LABEL).toBe(entry?.label);
  });

  it("fromScratchTypeLabel resolves a known id and falls back to the raw id for an unknown one", () => {
    expect(fromScratchTypeLabel("leave_and_license")).toBe("Leave and License Agreement (Rental)");
    expect(fromScratchTypeLabel("unknown_type")).toBe("unknown_type");
  });
});
