import { describe, expect, it } from "vitest";
import { AppError } from "@/server/core/errors";
import { DOCUMENT_TYPE_REGISTRY } from "@/server/deterministic/document-type-registry";
import {
  aiSectionKeys,
  DRAFT_TEMPLATES,
  DRAFTABLE_DOCUMENT_TYPE_IDS,
  getDraftTemplate,
  headingFor,
  isDraftableDocumentType,
  missingRequiredSections,
  REGISTRY_DRAFTABLE_IDS,
  renderDraftContent,
  requiredSectionKeys,
} from "@/server/deterministic/draft-templates/registry";

describe("draft-templates registry ↔ document-type-registry parity", () => {
  it("every draftable id here has a registry entry, and vice versa (no silent drift)", () => {
    expect(new Set(REGISTRY_DRAFTABLE_IDS)).toEqual(new Set(DRAFTABLE_DOCUMENT_TYPE_IDS));
  });

  it("generic has no draft template — it is Understand's fallback only, never a Draft target", () => {
    expect(isDraftableDocumentType("generic")).toBe(false);
    expect(() => getDraftTemplate("generic")).toThrow(AppError);
  });

  it("an unknown document type is rejected with a typed VALIDATION_FAILED error", () => {
    expect(() => getDraftTemplate("not_a_real_type")).toThrow(/No draft template exists/);
    try {
      getDraftTemplate("not_a_real_type");
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("VALIDATION_FAILED");
    }
  });
});

describe.each(DRAFTABLE_DOCUMENT_TYPE_IDS)("template shape — %s", (documentType) => {
  it("has at least one templated and one ai_generated section, every key unique, every heading non-blank", () => {
    const template = DRAFT_TEMPLATES[documentType];
    expect(template.sections.length).toBeGreaterThan(1);
    expect(template.sections.some((s) => s.provenance === "templated")).toBe(true);
    expect(template.sections.some((s) => s.provenance === "ai_generated")).toBe(true);
    expect(new Set(template.sections.map((s) => s.key)).size).toBe(template.sections.length);
    for (const section of template.sections) {
      expect(section.heading.trim().length).toBeGreaterThan(0);
    }
  });

  it("every templated section has a fixed, non-blank body; every ai_generated section has none", () => {
    for (const section of DRAFT_TEMPLATES[documentType].sections) {
      if (section.provenance === "templated") {
        expect(section.body?.trim().length ?? 0).toBeGreaterThan(0);
      } else {
        expect(section.body).toBeUndefined();
      }
    }
  });

  it("the templated disclaimer/closing body never claims to be legal advice or verified", () => {
    const templatedText = DRAFT_TEMPLATES[documentType].sections
      .filter((s) => s.provenance === "templated")
      .map((s) => s.body)
      .join(" ");
    expect(templatedText.toLowerCase()).toContain("not legal advice");
    expect(templatedText.toLowerCase()).not.toMatch(/\bverified\b/);
  });

  // A fixed template body must never assert something the template itself cannot guarantee (deemed
  // consent; a date that appears nowhere in the document).
  it("no templated body implies deemed/passive consent, or references a date the template never actually states", () => {
    const templatedText = DRAFT_TEMPLATES[documentType].sections
      .filter((s) => s.provenance === "templated")
      .map((s) => s.body)
      .join(" ")
      .toLowerCase();
    expect(templatedText).not.toContain("constitutes acceptance");
    expect(templatedText).not.toContain("date first written above");
  });

  it("requiredSectionKeys/aiSectionKeys match the template, in template order", () => {
    const template = DRAFT_TEMPLATES[documentType];
    expect(requiredSectionKeys(documentType)).toEqual(template.sections.map((s) => s.key));
    expect(aiSectionKeys(documentType)).toEqual(
      template.sections.filter((s) => s.provenance === "ai_generated").map((s) => s.key),
    );
  });

  it("headingFor resolves every real key and falls back to the key itself for an unknown one", () => {
    for (const section of DRAFT_TEMPLATES[documentType].sections) {
      expect(headingFor(documentType, section.key)).toBe(section.heading);
    }
    expect(headingFor(documentType, "not_a_real_key")).toBe("not_a_real_key");
  });
});

describe.each(DRAFTABLE_DOCUMENT_TYPE_IDS)("section guidance — %s", (documentType) => {
  it("every ai_generated section has non-blank guidance; templated sections carry none", () => {
    for (const section of DRAFT_TEMPLATES[documentType].sections) {
      if (section.provenance === "ai_generated") {
        expect(section.guidance?.trim().length ?? 0).toBeGreaterThan(0);
      } else {
        expect(section.guidance).toBeUndefined();
      }
    }
  });
});

describe.each(["leave_and_license", "nda", "freelance_service_agreement"] as const)(
  "governing_law_and_disputes — %s",
  (documentType) => {
    it("is ai_generated, sits immediately before the signatures section, and commits to exactly one dispute forum", () => {
      const keys = DRAFT_TEMPLATES[documentType].sections.map((s) => s.key);
      const section = DRAFT_TEMPLATES[documentType].sections.find((s) => s.key === "governing_law_and_disputes")!;
      expect(section).toBeDefined();
      expect(section.provenance).toBe("ai_generated");
      expect(section.heading).toBe("Governing Law and Disputes");
      expect(keys.indexOf("governing_law_and_disputes")).toBe(keys.indexOf("signatures") - 1);
      expect(section.guidance).toContain("Indian law");
      expect(section.guidance).toContain("exactly one dispute");
      expect(section.guidance).toContain("courts at a named Indian city");
      expect(section.guidance).toContain("Arbitration and Conciliation Act, 1996");
      expect(section.guidance).toContain("Never leave the choice open");
    });
  },
);

describe("job_offer_letter and privacy_policy — unaffected by the governing-law addition", () => {
  it("carry no governing_law_and_disputes section", () => {
    expect(DRAFT_TEMPLATES.job_offer_letter.sections.some((s) => s.key === "governing_law_and_disputes")).toBe(false);
    expect(DRAFT_TEMPLATES.privacy_policy.sections.some((s) => s.key === "governing_law_and_disputes")).toBe(false);
  });
});

describe("freelance_service_agreement — termination_and_liability guidance", () => {
  it("requires a mutual liability cap with fraud/wilful-misconduct/unpaid-fees carve-outs, and a capped mutual IP indemnity", () => {
    const guidance = DRAFT_TEMPLATES.freelance_service_agreement.sections.find((s) => s.key === "termination_and_liability")!.guidance!;
    expect(guidance).toContain("mutual liability cap");
    expect(guidance).toContain("fraud");
    expect(guidance).toContain("wilful misconduct");
    expect(guidance).toContain("fees already due");
    expect(guidance).toContain("unpaid fees are never capped");
    expect(guidance).toContain("indemnity limited to third-party intellectual-property-infringement claims");
    expect(guidance).toContain("mutual and capped");
  });
});

describe("missingRequiredSections", () => {
  function sectionsWithContent(keys: readonly string[]): { sectionKey: string; content: string }[] {
    return keys.map((sectionKey) => ({ sectionKey, content: `body for ${sectionKey}` }));
  }

  it("reports nothing missing when every required key is present with real content (extra/unrelated keys ignored)", () => {
    expect(missingRequiredSections("nda", sectionsWithContent([...requiredSectionKeys("nda"), "some_extra_key"]))).toEqual([]);
  });

  it("reports exactly the missing keys, order-independent input, template-ordered output", () => {
    const keys = requiredSectionKeys("nda");
    const withoutFirstAndLast = keys.slice(1, -1);
    expect(missingRequiredSections("nda", sectionsWithContent(withoutFirstAndLast))).toEqual([keys[0], keys[keys.length - 1]]);
    expect(missingRequiredSections("nda", [])).toEqual(keys);
  });

  it("treats a blank or whitespace-only body as missing, not present", () => {
    const keys = requiredSectionKeys("nda");
    const withOneBlank = keys.map((sectionKey, i) => ({ sectionKey, content: i === 0 ? "   " : `body for ${sectionKey}` }));
    expect(missingRequiredSections("nda", withOneBlank)).toEqual([keys[0]]);
    const withOneEmpty = keys.map((sectionKey, i) => ({ sectionKey, content: i === 0 ? "" : `body for ${sectionKey}` }));
    expect(missingRequiredSections("nda", withOneEmpty)).toEqual([keys[0]]);
  });
});

describe("renderDraftContent", () => {
  it("renders every section, in template order, under its heading — missing content renders empty, not throwing", () => {
    const keys = requiredSectionKeys("privacy_policy");
    const rendered = renderDraftContent(
      "privacy_policy",
      keys.slice(0, -1).map((sectionKey) => ({ sectionKey, content: `BODY(${sectionKey})` })),
    );
    const headings = DRAFT_TEMPLATES.privacy_policy.sections.map((s) => s.heading);
    let lastIndex = -1;
    for (const heading of headings) {
      const index = rendered.indexOf(`## ${heading}`);
      expect(index).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
    expect(rendered).toContain(`BODY(${keys[0]})`);
  });
});

describe("document-type-registry cross-check", () => {
  it("every registry entry with a draftTemplateRef is draftable here, and generic (no ref) is not", () => {
    for (const entry of DOCUMENT_TYPE_REGISTRY) {
      expect(isDraftableDocumentType(entry.id)).toBe(entry.draftTemplateRef !== undefined);
    }
  });
});
