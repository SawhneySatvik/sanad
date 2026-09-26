// SampleCards' catalogue is a static client constant — pinned by an EXACT match (not
// merely a superset) against src/server/samples/registry.ts's own SAMPLE_IDS, so a manifest rename
// or a registry change can never silently drift from what the client shows.

import { describe, expect, it } from "vitest";
import { SAMPLE_IDS as REGISTRY_SAMPLE_IDS } from "@/server/samples/registry";
import { SAMPLE_CATALOGUE, SAMPLE_IDS, orderedSamples } from "@/components/chat/catalogue";

describe("SAMPLE_IDS parity with the registry", () => {
  it("is an exact match, in order — not merely a superset", () => {
    expect(SAMPLE_IDS).toEqual(REGISTRY_SAMPLE_IDS);
  });

  it("every catalogue entry's sampleId is one of SAMPLE_IDS, one entry per id", () => {
    expect(SAMPLE_CATALOGUE.map((s) => s.sampleId)).toEqual(SAMPLE_IDS);
  });

  it("every entry carries a distinct, non-empty assetId, independent of its (underscored) sampleId", () => {
    const assetIds = SAMPLE_CATALOGUE.map((s) => s.assetId);
    expect(new Set(assetIds).size).toBe(assetIds.length);
    for (const s of SAMPLE_CATALOGUE) {
      expect(s.assetId.length).toBeGreaterThan(0);
      expect(s.assetId).not.toBe(s.sampleId);
    }
  });

  it("every entry has a full, distinguishing accessible name (never the same string repeated across cards)", () => {
    const names = SAMPLE_CATALOGUE.map((s) => s.accessibleName);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name.startsWith("Try a sample:")).toBe(true);
  });
});

describe("orderedSamples — per-role reorder", () => {
  it("no chip / 'other': baseline order (lease first)", () => {
    expect(orderedSamples(null).map((s) => s.sampleId)).toEqual(SAMPLE_IDS);
    expect(orderedSamples("other").map((s) => s.sampleId)).toEqual(SAMPLE_IDS);
  });

  it("tenant: lease is already first, so this alone wouldn't prove reordering works", () => {
    expect(orderedSamples("tenant").map((s) => s.sampleId)[0]).toBe("lease");
  });

  it("employee: offer_letter moves first, the rest keep their relative order", () => {
    expect(orderedSamples("employee").map((s) => s.sampleId)).toEqual(["offer_letter", "lease", "nda", "privacy_policy", "freelance"]);
  });

  it("freelancer: freelance moves first", () => {
    expect(orderedSamples("freelancer").map((s) => s.sampleId)).toEqual(["freelance", "lease", "offer_letter", "nda", "privacy_policy"]);
  });
});
