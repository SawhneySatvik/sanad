import { describe, expect, it } from "vitest";
import { collectLensOptions, parseLensId, resolveDefaultLens } from "@/components/workspace/lens/resolve-default-lens";
import type { FindingOutput } from "@/shared/contracts/documents";

function findingWithLenses(lensIds: string[]): FindingOutput {
  return {
    id: `f-${lensIds.join("-")}`,
    category: "obligation",
    explanation: "explanation",
    explanationProvenance: "ai_generated",
    lensExplanations: lensIds.map((lens) => ({ lens, explanation: `${lens} explanation`, explanationProvenance: "ai_generated" as const })),
    verification: null,
    modelUsed: "gemini",
  };
}

describe("parseLensId", () => {
  it("splits role_stage into { role, stage }", () => {
    expect(parseLensId("tenant_about_to_sign")).toEqual({ id: "tenant_about_to_sign", role: "tenant", stage: "about_to_sign" });
    expect(parseLensId("landlord_already_signed")).toEqual({ id: "landlord_already_signed", role: "landlord", stage: "already_signed" });
  });

  it("returns null for an id with no known stage suffix", () => {
    expect(parseLensId("not-a-real-lens")).toBeNull();
  });

  it("returns null when the role part would be empty", () => {
    expect(parseLensId("_about_to_sign")).toBeNull();
  });
});

describe("collectLensOptions", () => {
  it("dedupes across findings, in first-seen order", () => {
    const findings = [findingWithLenses(["tenant_about_to_sign", "landlord_about_to_sign"]), findingWithLenses(["tenant_about_to_sign"])];
    const options = collectLensOptions(findings);
    expect(options.map((o) => o.id)).toEqual(["tenant_about_to_sign", "landlord_about_to_sign"]);
  });

  it("drops a malformed lens id rather than rendering it raw", () => {
    const options = collectLensOptions([findingWithLenses(["garbage"])]);
    expect(options).toEqual([]);
  });

  it("returns [] for checklist findings (empty lensExplanations)", () => {
    expect(collectLensOptions([findingWithLenses([])])).toEqual([]);
  });
});

describe("resolveDefaultLens", () => {
  const options = [
    { id: "tenant_about_to_sign", role: "tenant", stage: "about_to_sign" as const },
    { id: "tenant_already_signed", role: "tenant", stage: "already_signed" as const },
    { id: "landlord_about_to_sign", role: "landlord", stage: "about_to_sign" as const },
  ];

  it("returns null when there is nothing to switch between", () => {
    expect(resolveDefaultLens({ options: [], documentType: "leave_and_license" })).toBeNull();
  });

  it("rule 1: a valid ?lens= wins over everything else", () => {
    expect(resolveDefaultLens({ options, documentType: "leave_and_license", urlLens: "landlord_about_to_sign", chipRole: "tenant" })).toBe(
      "landlord_about_to_sign",
    );
  });

  it("an invalid ?lens= is treated as absent, falling through to the next rule", () => {
    expect(resolveDefaultLens({ options, documentType: "leave_and_license", urlLens: "not-a-real-lens", chipRole: "landlord" })).toBe(
      "landlord_about_to_sign",
    );
  });

  it("rule 2: the remembered chip role wins over the document type's first lens", () => {
    expect(resolveDefaultLens({ options, documentType: "leave_and_license", chipRole: "landlord" })).toBe("landlord_about_to_sign");
  });

  it("a chip role with no matching lens for this document falls through to rule 3", () => {
    expect(resolveDefaultLens({ options, documentType: "leave_and_license", chipRole: "employee" })).toBe("tenant_about_to_sign");
  });

  it("rule 3: the document type's own first lens, read from the shared table", () => {
    expect(resolveDefaultLens({ options, documentType: "leave_and_license" })).toBe("tenant_about_to_sign");
  });

  it("falls back to options[0] when the document type is unrecognised", () => {
    expect(resolveDefaultLens({ options, documentType: "some_future_type" })).toBe("tenant_about_to_sign");
  });
});
