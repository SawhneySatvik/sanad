import { describe, expect, it } from "vitest";
import { escapeMarkdown, renderPrepareMarkdown, type PrepareChecklistItem, type PrepareFindingRef, type PrepareQuestion } from "@/server/deterministic/prepare-export/markdown";

const RENT_TEXT = "The Licensee shall pay a monthly license fee of Rs. 32,000";

// PrepareFindingRef.verification is plain data (never the branded VerifyResult — services/prepare.ts
// converts before this module ever sees a finding), so fixtures here are ordinary object literals.
function verifiedRef(id: string, spanText: string): PrepareFindingRef {
  return { id, category: "obligation", verification: { status: "verified", spanStart: 0, spanEnd: spanText.length, spanText, verifierVersion: "2.0.0" } };
}

function notFoundRef(id: string): PrepareFindingRef {
  return { id, category: "penalty", verification: { status: "not_found", spanStart: null, spanEnd: null, spanText: null, verifierVersion: "2.0.0" } };
}

function missingClauseRef(id: string): PrepareFindingRef {
  return { id, category: "missing_clause", verification: null };
}

describe("renderPrepareMarkdown — not-legal-advice notice", () => {
  it("is present and appears before either section heading", () => {
    const md = renderPrepareMarkdown({ lawyerQuestions: [], checklist: [] }, { filename: "lease.pdf" });
    expect(md.toLowerCase()).toContain("not legal advice");
    const noticeIndex = md.toLowerCase().indexOf("not legal advice");
    expect(noticeIndex).toBeGreaterThan(-1);
    expect(noticeIndex).toBeLessThan(md.indexOf("## Questions to ask your lawyer"));
    expect(noticeIndex).toBeLessThan(md.indexOf("## Before you sign"));
  });

  it("empty questions/checklist render a graceful placeholder, not a blank section", () => {
    const md = renderPrepareMarkdown({ lawyerQuestions: [], checklist: [] }, { filename: "lease.pdf" });
    expect(md).toContain("No questions were generated");
    expect(md).toContain("No checklist items were generated");
  });
});

describe("renderPrepareMarkdown — citations render exactly the given verification", () => {
  it("a verified finding's spanText renders inside the citation, escaped", () => {
    const ref = verifiedRef("f1", RENT_TEXT);
    const question: PrepareQuestion = { question: "What is the rent?", whyItMatters: "It sets your monthly cost.", findingIds: ["f1"], findings: [ref] };
    const md = renderPrepareMarkdown({ lawyerQuestions: [question], checklist: [] }, { filename: "lease.pdf" });
    expect(md).toContain(escapeMarkdown(RENT_TEXT));
    expect(md).toContain("Quote verified against the document");
  });

  it("labels a not_found finding's status in words and never renders a highlighted span for it", () => {
    const ref = notFoundRef("f2");
    const item: PrepareChecklistItem = { item: "Confirm the late fee.", findingIds: ["f2"], findings: [ref] };
    const md = renderPrepareMarkdown({ lawyerQuestions: [], checklist: [item] }, { filename: "lease.pdf" });
    expect(md).toContain("Quote could not be found in the document");
  });

  it("labels a missing_clause finding (no verification object) honestly, never asserting absence as a checked fact", () => {
    const ref = missingClauseRef("f3");
    const item: PrepareChecklistItem = { item: "Ask about stamp duty.", findingIds: ["f3"], findings: [ref] };
    const md = renderPrepareMarkdown({ lawyerQuestions: [], checklist: [item] }, { filename: "lease.pdf" });
    expect(md).toContain("Flagged as possibly missing — not checked against the document");
  });
});

describe("renderPrepareMarkdown — the perspective header", () => {
  it("names the reader's role and stage when a lens is given", () => {
    const md = renderPrepareMarkdown({ lawyerQuestions: [], checklist: [] }, { filename: "lease.pdf", lens: { role: "tenant", stage: "already_signed" } });
    expect(md).toContain("Prepared for: Tenant, already signed");
  });

  it("about-to-sign renders with a space, not the underscore in the stage id", () => {
    const md = renderPrepareMarkdown({ lawyerQuestions: [], checklist: [] }, { filename: "lease.pdf", lens: { role: "tenant", stage: "about_to_sign" } });
    expect(md).toContain("Prepared for: Tenant, before signing");
  });

  it("omits the line entirely when no lens is given", () => {
    const md = renderPrepareMarkdown({ lawyerQuestions: [], checklist: [] }, { filename: "lease.pdf" });
    expect(md).not.toContain("Prepared for:");
  });

  it("escapes a hostile role the same way the filename is escaped", () => {
    const md = renderPrepareMarkdown(
      { lawyerQuestions: [], checklist: [] },
      { filename: "lease.pdf", lens: { role: "<script>alert(1)</script>", stage: "already_signed" } },
    );
    expect(md).not.toContain("<script>");
  });
});

describe("escapeMarkdown — no raw HTML / markdown-link passthrough", () => {
  it("neutralizes a <script> tag", () => {
    const escaped = escapeMarkdown("<script>alert(1)</script>");
    expect(escaped).not.toContain("<script>");
    expect(escaped).toBe("\\<script\\>alert\\(1\\)\\<\\/script\\>");
  });

  it("neutralizes a markdown-link javascript: payload", () => {
    const escaped = escapeMarkdown("click here](javascript:alert(1))");
    expect(escaped).not.toContain("](javascript:");
    expect(escaped).toContain("\\]\\(javascript\\:alert\\(1\\)\\)");
  });

  it("is a no-op on plain alphanumeric text", () => {
    expect(escapeMarkdown("Rs 32000 due on the 5th")).toBe("Rs 32000 due on the 5th");
  });
});

describe("renderPrepareMarkdown — hostile text is inert in every field it can reach", () => {
  const HOSTILE = "<script>alert(1)</script> and click ](javascript:alert(1))";

  it("in a model-generated question and whyItMatters", () => {
    const ref = verifiedRef("f1", RENT_TEXT);
    const question: PrepareQuestion = { question: HOSTILE, whyItMatters: HOSTILE, findingIds: ["f1"], findings: [ref] };
    const md = renderPrepareMarkdown({ lawyerQuestions: [question], checklist: [] }, { filename: "lease.pdf" });
    expect(md).not.toContain("<script>");
    expect(md).not.toContain("](javascript:");
  });

  it("in a model-generated checklist item", () => {
    const ref = verifiedRef("f1", RENT_TEXT);
    const item: PrepareChecklistItem = { item: HOSTILE, findingIds: ["f1"], findings: [ref] };
    const md = renderPrepareMarkdown({ lawyerQuestions: [], checklist: [item] }, { filename: "lease.pdf" });
    expect(md).not.toContain("<script>");
    expect(md).not.toContain("](javascript:");
  });

  it("in the server-sliced spanText", () => {
    const ref = verifiedRef("f1", HOSTILE);
    const question: PrepareQuestion = { question: "About the rent clause", whyItMatters: "It is unusual wording.", findingIds: ["f1"], findings: [ref] };
    const md = renderPrepareMarkdown({ lawyerQuestions: [question], checklist: [] }, { filename: "lease.pdf" });
    expect(md).not.toContain("<script>");
    expect(md).not.toContain("](javascript:");
  });

  it("in the document filename", () => {
    const md = renderPrepareMarkdown({ lawyerQuestions: [], checklist: [] }, { filename: `${HOSTILE}.pdf` });
    expect(md).not.toContain("<script>");
    expect(md).not.toContain("](javascript:");
  });

  it("a blank line inside model text never breaks a list item open (whitespace is collapsed before escaping)", () => {
    const ref = verifiedRef("f1", RENT_TEXT);
    const question: PrepareQuestion = {
      question: "What about\n\nthe rent?",
      whyItMatters: "It matters\n\na lot.",
      findingIds: ["f1"],
      findings: [ref],
    };
    const md = renderPrepareMarkdown({ lawyerQuestions: [question], checklist: [] }, { filename: "lease.pdf" });
    expect(md).not.toContain("\n\n\n");
    expect(md).toContain(escapeMarkdown("What about the rent?"));
  });

  it("badge/checkmark glyphs (✅ ✓ ✔ ☑) never survive into the rendered output", () => {
    const ref = verifiedRef("f1", RENT_TEXT);
    const question: PrepareQuestion = {
      question: "✅ Verified: everything is fine ✓",
      whyItMatters: "☑ trust this ✔",
      findingIds: ["f1"],
      findings: [ref],
    };
    const md = renderPrepareMarkdown({ lawyerQuestions: [question], checklist: [] }, { filename: "lease.pdf" });
    expect(md).not.toMatch(/[✅✓✔☑]/u);
  });
});
