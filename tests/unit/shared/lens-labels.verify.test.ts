import { describe, expect, it } from "vitest";
import { LENS_STAGES as SERVER_STAGES, LENSES_BY_DOCUMENT_TYPE } from "@/server/prompts/understand/lenses";
import { LENS_STAGES, LENS_IDS_BY_DOCUMENT_TYPE, lensLabel, lensLabelParts } from "@/shared/lens-labels";
import { PrepareQuery } from "@/shared/contracts/prepare";
import { renderPrepareMarkdown } from "@/server/deterministic/prepare-export/markdown";
import { LEGAL_ADVICE_COPY } from "@/shared/copy/legal-advice";
import { DISCLAIMER_TEXT } from "@/components/brand/disclaimer-line";

describe("public lens labels", () => {
  it("mirrors the server registry in id, role, stage and order without prompt descriptions", () => {
    expect(LENS_STAGES).toEqual(SERVER_STAGES);
    for (const [type, lenses] of Object.entries(LENSES_BY_DOCUMENT_TYPE)) {
      expect(LENS_IDS_BY_DOCUMENT_TYPE[type]).toEqual(lenses.map(({ id, role, stage }) => ({ id, role, stage })));
      for (const lens of LENS_IDS_BY_DOCUMENT_TYPE[type]) {
        expect(PrepareQuery.safeParse({ lens: lens.id }).success).toBe(true);
        expect(lens).not.toHaveProperty("description");
      }
    }
  });

  it("pins the heading and Markdown preparedFor line to the same human label", () => {
    const lens = LENS_IDS_BY_DOCUMENT_TYPE.leave_and_license[0];
    const label = lensLabel(lens);
    expect(label).toBe("Tenant, before signing");
    const heading = `Prepared for: ${label}`;
    const markdown = renderPrepareMarkdown({ lawyerQuestions: [], checklist: [] }, { filename: "lease.txt", lens });
    expect(markdown).toContain(heading);
    expect(lensLabel({ role: "receiving_party", stage: "already_signed" })).toBe("Receiving party, already signed");
  });

  it("keeps a comma in a role separate from the stage", () => {
    const lens = { role: "tenant, advocate", stage: "already_signed" };
    expect(lensLabelParts(lens)).toEqual({ role: "Tenant, Advocate", stage: "already signed" });
    const markdown = renderPrepareMarkdown({ lawyerQuestions: [], checklist: [] }, { filename: "lease.txt", lens });
    expect(markdown).toContain("Prepared for: Tenant\\, Advocate, already signed");
  });

  it("the UI and Prepare export draw their disclaimers from shared copy", () => {
    expect(DISCLAIMER_TEXT).toBe(LEGAL_ADVICE_COPY.short);
    expect(LEGAL_ADVICE_COPY.prepareNotice).toBe("This is not legal advice. It is a plain-language summary to help you prepare for a conversation with a qualified lawyer about this document.");
    const markdown = renderPrepareMarkdown({ lawyerQuestions: [], checklist: [] }, { filename: "lease.txt" });
    expect(markdown).toContain(`**${LEGAL_ADVICE_COPY.prepareLead}** ${LEGAL_ADVICE_COPY.prepareDetail}`);
  });
});
