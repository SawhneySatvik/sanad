import { describe, expect, it } from "vitest";
import { DOCUMENT_TYPE_IDS, DOCUMENT_TYPE_REGISTRY } from "@/server/deterministic/document-type-registry";

const EXPECTED_TUNED_TYPES = [
  "leave_and_license",
  "job_offer_letter",
  "nda",
  "privacy_policy",
  "freelance_service_agreement",
];

describe("DOCUMENT_TYPE_REGISTRY", () => {
  it("contains the 5 tuned types, the 6th grounded-response category, and generic", () => {
    for (const id of EXPECTED_TUNED_TYPES) {
      expect(DOCUMENT_TYPE_IDS).toContain(id);
    }
    expect(DOCUMENT_TYPE_IDS).toContain("grounded_response");
    expect(DOCUMENT_TYPE_IDS).toContain("generic");
  });

  it("has no duplicate ids — the migrator's CHECK IN(...) constraint depends on this list being a clean set", () => {
    expect(new Set(DOCUMENT_TYPE_IDS).size).toBe(DOCUMENT_TYPE_IDS.length);
  });

  it("DOCUMENT_TYPE_IDS is the exact pinned list and order the migrator's CHECK IN(...) constraint mirrors", () => {
    expect(DOCUMENT_TYPE_IDS).toEqual([
      "leave_and_license",
      "job_offer_letter",
      "nda",
      "privacy_policy",
      "freelance_service_agreement",
      "grounded_response",
      "generic",
    ]);
  });

  it("registry entry ids exactly match DOCUMENT_TYPE_IDS, in the same order — the two must never drift apart", () => {
    expect(DOCUMENT_TYPE_REGISTRY.map((e) => e.id)).toEqual(DOCUMENT_TYPE_IDS);
  });

  it("every entry scopes to India (national-level jurisdiction only)", () => {
    for (const entry of DOCUMENT_TYPE_REGISTRY) {
      expect(entry.jurisdictions).toEqual(["IN"]);
    }
  });

  it("every entry has a non-empty label and understandPromptRef", () => {
    for (const entry of DOCUMENT_TYPE_REGISTRY) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.understandPromptRef.length).toBeGreaterThan(0);
    }
  });

  it("every tuned type has at least one weighted detection phrase", () => {
    for (const id of EXPECTED_TUNED_TYPES) {
      const entry = DOCUMENT_TYPE_REGISTRY.find((e) => e.id === id);
      expect(entry).toBeDefined();
      expect(entry!.detectionSignature.length).toBeGreaterThan(0);
      for (const phrase of entry!.detectionSignature) {
        expect(phrase.weight).toBeGreaterThan(0);
        expect(phrase.phrase.length).toBeGreaterThan(0);
        expect(phrase.concept.length).toBeGreaterThan(0);
      }
    }
  });

  it("every tuned type has at least one concept with more than one phrase — the detector has synonyms to group", () => {
    for (const id of EXPECTED_TUNED_TYPES) {
      const entry = DOCUMENT_TYPE_REGISTRY.find((e) => e.id === id)!;
      const counts = new Map<string, number>();
      for (const { concept } of entry.detectionSignature) {
        counts.set(concept, (counts.get(concept) ?? 0) + 1);
      }
      expect([...counts.values()].some((count) => count > 1), id).toBe(true);
    }
  });

  it("'generic' and 'grounded_response' have no detection signature — never auto-detected from a document's own text", () => {
    for (const id of ["generic", "grounded_response"]) {
      const entry = DOCUMENT_TYPE_REGISTRY.find((e) => e.id === id);
      expect(entry!.detectionSignature).toEqual([]);
    }
  });
});
