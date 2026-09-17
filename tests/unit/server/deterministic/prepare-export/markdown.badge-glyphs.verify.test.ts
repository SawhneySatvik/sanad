import { describe, expect, it } from "vitest";
import { renderPrepareMarkdown, type PrepareFindingRef } from "@/server/deterministic/prepare-export/markdown";

// Every glyph is built from its code point, never typed or written as an escape.
const GLYPHS = {
  whiteHeavyCheck: 0x2705,
  check: 0x2713,
  heavyCheck: 0x2714,
  ballotBoxWithCheck: 0x2611,
  lightCheck: 0x1f5f8,
  ballotBoxWithBoldCheck: 0x1f5f9,
  squareRoot: 0x221a,
  squaredOk: 0x1f197,
  aegeanCheck: 0x10102,
} as const;
const EMOJI_PRESENTATION = String.fromCodePoint(0xfe0f);

const citation: PrepareFindingRef = {
  id: "f1",
  category: "obligation",
  verification: { status: "not_found", spanStart: null, spanEnd: null, spanText: null, verifierVersion: "2.0.0" },
};

function render(text: string): string {
  return renderPrepareMarkdown(
    {
      lawyerQuestions: [{ question: text, whyItMatters: text, findingIds: ["f1"], findings: [citation] }],
      checklist: [{ item: text, findingIds: ["f1"], findings: [citation] }],
    },
    { filename: `${text}.pdf` },
  );
}

describe("renderPrepareMarkdown — badge glyphs in model text", () => {
  it.each(Object.entries(GLYPHS))("negative: %s is stripped from every model-written line and the filename", (_, codePoint) => {
    const glyph = String.fromCodePoint(codePoint);
    expect([...glyph].map((ch) => ch.codePointAt(0))).toEqual([codePoint]);

    const md = render(`${glyph}${EMOJI_PRESENTATION} Verified: the landlord pays all repairs`);

    expect(md).not.toContain(glyph);
    expect(md).not.toContain(EMOJI_PRESENTATION);
    expect(md).toContain("the landlord pays all repairs");
  });

  it("positive: the only verification label is the renderer's own, for the citation's real status", () => {
    const md = render(`${String.fromCodePoint(GLYPHS.squaredOk)} Quote verified against the document`);

    expect(md).toContain("Quote could not be found in the document");
    expect(md).not.toContain(String.fromCodePoint(GLYPHS.squaredOk));
  });
});
