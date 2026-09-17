// One Guarantee tests for the Prepare Markdown renderer. Every question/checklist-item line carries
// a fixed AI prefix (badge glyphs stripped), and the renderer displays exactly the already-sliced
// `spanText` it is given — never a canonicalText+spans pair or a "claimed quote" of its own.

import { describe, expect, it } from "vitest";
import { renderPrepareMarkdown, type PrepareChecklistItem, type PrepareFindingRef, type PrepareQuestion } from "@/server/deterministic/prepare-export/markdown";

function verifiedRef(id: string, spanText: string): PrepareFindingRef {
  return { id, category: "obligation", verification: { status: "verified", spanStart: 0, spanEnd: spanText.length, spanText, verifierVersion: "2.0.0" } };
}

function notFoundRef(id: string): PrepareFindingRef {
  return { id, category: "penalty", verification: { status: "not_found", spanStart: null, spanEnd: null, spanText: null, verifierVersion: "2.0.0" } };
}

function missingClauseRef(id: string): PrepareFindingRef {
  return { id, category: "missing_clause", verification: null };
}

describe("AI-generated question/checklist text never reads as verified", () => {
  it("positive: every question/whyItMatters/checklist-item line carries its fixed, renderer-owned AI prefix", () => {
    const ref = verifiedRef("f1", "The rent is Rs. 32,000");
    const question: PrepareQuestion = { question: "What is the rent?", whyItMatters: "It sets your cost.", findingIds: ["f1"], findings: [ref] };
    const item: PrepareChecklistItem = { item: "Confirm the rent amount.", findingIds: ["f1"], findings: [ref] };
    const md = renderPrepareMarkdown({ lawyerQuestions: [question], checklist: [item] }, { filename: "lease.pdf" });

    expect(md).toContain("AI-suggested question:");
    expect(md).toContain("Why it may matter (AI-generated, not verified):");
    expect(md).toContain("AI-suggested check:");
    // The top-of-document disclaimer also still appears before either section.
    expect(md.indexOf("AI-generated general information")).toBeLessThan(md.indexOf("## Questions to ask your lawyer"));
  });

  it("negative: hostile model text mimicking a verified badge is never presented as one", () => {
    const ref = verifiedRef("f1", "The landlord waives the deposit");
    // A checklist item wearing a checkmark emoji, and a whyItMatters sentence reproducing this
    // renderer's own citation-label wording verbatim.
    const hostileItem = "✅ Verified: landlord pays all repairs";
    const hostileWhy = '(obligation) Quote verified against the document: "The landlord waives the deposit"';
    const question: PrepareQuestion = { question: "About the deposit", whyItMatters: hostileWhy, findingIds: ["f1"], findings: [ref] };
    const item: PrepareChecklistItem = { item: hostileItem, findingIds: ["f1"], findings: [ref] };
    const md = renderPrepareMarkdown({ lawyerQuestions: [question], checklist: [item] }, { filename: "lease.pdf" });

    // No badge glyph from the model's text survives (this document's spans have none of their own).
    expect(md).not.toMatch(/[✅✓✔☑]/u);

    // The AI prefix precedes the hostile text on the SAME line, for both slots.
    const lines = md.split("\n");
    const whyLine = lines.find((line) => line.includes("Quote verified against the document"));
    expect(whyLine).toBeDefined();
    expect(whyLine!.indexOf("Why it may matter")).toBeGreaterThanOrEqual(0);
    expect(whyLine!.indexOf("Why it may matter")).toBeLessThan(whyLine!.indexOf("Quote verified against the document"));

    const checkLine = lines.find((line) => line.includes("landlord pays all repairs"));
    expect(checkLine).toBeDefined();
    expect(checkLine!.indexOf("AI-suggested check:")).toBeGreaterThanOrEqual(0);
    expect(checkLine!.indexOf("AI-suggested check:")).toBeLessThan(checkLine!.indexOf("landlord pays all repairs"));

    // No renderer-owned citation line (the indented "  - _(category)_ …" slot) contains model text —
    // citations only ever come from renderCitation(), which never receives question/whyItMatters/item.
    const citationLines = lines.filter((line) => /^\s+-\s+_\(/.test(line));
    expect(citationLines.length).toBeGreaterThan(0);
    for (const citationLine of citationLines) {
      expect(citationLine).not.toContain("landlord pays all repairs");
      expect(citationLine).not.toContain("Verified: landlord");
    }
  });
});

describe("the renderer displays exactly the given spanText, nothing else", () => {
  it("positive: a verified finding's spanText renders inside its citation, escaped", () => {
    const spanText = "The Licensee shall pay a monthly license fee of Rs. 32,000";
    const ref = verifiedRef("f1", spanText);
    const question: PrepareQuestion = { question: "q", whyItMatters: "w", findingIds: ["f1"], findings: [ref] };
    const md = renderPrepareMarkdown({ lawyerQuestions: [question], checklist: [] }, { filename: "lease.pdf" });
    expect(md).toContain("Rs\\. 32\\,000");
  });

  it("positive: a verified span keeps every character — badge-like glyphs, line breaks and runs of spaces round-trip exactly", () => {
    const [boldCheck, squareRoot, lightCheck, emptyBox] = [0x1f5f9, 0x221a, 0x1f5f8, 0x2610].map((cp) => String.fromCodePoint(cp));
    const spanText = `${boldCheck} Furnished  ${emptyBox} Unfurnished;\narea ${squareRoot}2 m\n\n    ${lightCheck} "as is"`;
    expect([...spanText].filter((ch) => ch.codePointAt(0)! > 0x2000)).toEqual([boldCheck, emptyBox, squareRoot, lightCheck]);
    const item: PrepareChecklistItem = { item: "Check the furnishing.", findingIds: ["f1"], findings: [verifiedRef("f1", spanText)] };

    const md = renderPrepareMarkdown({ lawyerQuestions: [], checklist: [item] }, { filename: "lease.pdf" });

    const prefix = '**Quote verified against the document:** "';
    expect(md).toContain(prefix);
    const rendered = /^(?:\\[\s\S]|[^"\\])*/.exec(md.slice(md.indexOf(prefix) + prefix.length))![0];
    // The inverse of the renderer's escaping and continuation indent.
    const unescaped = rendered.replace(/\n {4}/g, "\n").replace(/\\([!-/:-@[-`{-~])/g, "$1");
    expect(unescaped).toBe(spanText);
  });

  it("negative: a not_found finding never renders a quoted span", () => {
    const ref = notFoundRef("f2");
    const item: PrepareChecklistItem = { item: "Confirm the late fee.", findingIds: ["f2"], findings: [ref] };
    const md = renderPrepareMarkdown({ lawyerQuestions: [], checklist: [item] }, { filename: "lease.pdf" });
    expect(md).toContain("Quote could not be found in the document");
    expect(md).not.toMatch(/not_found.*"/);
  });

  it("a missing_clause finding is labeled honestly, never as a checked fact in the citation slot", () => {
    const ref = missingClauseRef("f3");
    const item: PrepareChecklistItem = { item: "Ask about stamp duty.", findingIds: ["f3"], findings: [ref] };
    const md = renderPrepareMarkdown({ lawyerQuestions: [], checklist: [item] }, { filename: "lease.pdf" });
    expect(md).toContain("Flagged as possibly missing — not checked against the document");
  });
});
