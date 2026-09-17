import { describe, expect, it } from "vitest";
import { extractDocument } from "@/server/deterministic/extract";
import { verifyMany } from "@/server/deterministic/verify";

const RLO = String.fromCharCode(0x202e);
const PDF = String.fromCharCode(0x202c);
const BIDI_CONTROL = new RegExp(
  `[${[0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069].map((codePoint) => String.fromCharCode(codePoint)).join("")}]`,
);

// A bidi override inside a verified span makes a bidi-aware UI display "30" while the text verify()
// matched says "03" — the displayed text would no longer be the verified text.
describe("canonical text never carries bidi controls into a verified span", () => {
  const filler = "This leave and license agreement is made at Mumbai between the Licensor and the Licensee. ";
  const pasted = `${filler}\nThe security deposit shall be refunded within ${RLO}03${PDF} days of vacating. Unterminated tail: ${RLO}evil`;

  it("positive: the plain quote verifies, and its span is exactly the plain text", async () => {
    expect(pasted).toContain(`${RLO}03${PDF}`);
    const extracted = await extractDocument({ pastedText: pasted });
    if (extracted.kind !== "extracted") throw new Error("expected extracted text");
    expect(BIDI_CONTROL.test(extracted.canonicalText)).toBe(false);

    const [result] = verifyMany(["refunded within 03 days"], extracted.canonicalText, "text");
    expect(result.status).toBe("verified");
    if (result.status !== "verified") throw new Error("unreachable");
    expect(extracted.canonicalText.slice(result.spanStart, result.spanEnd)).toBe("refunded within 03 days");
  });

  it("negative: a quote that still carries the override or an unterminated override is never verified", async () => {
    const extracted = await extractDocument({ pastedText: pasted });
    if (extracted.kind !== "extracted") throw new Error("expected extracted text");

    const quotes = [`refunded within ${RLO}03${PDF} days`, `Unterminated tail: ${RLO}evil`];
    expect(quotes.every((quote) => BIDI_CONTROL.test(quote))).toBe(true);
    for (const result of verifyMany(quotes, extracted.canonicalText, "text")) {
      expect(result.status).not.toBe("verified");
    }
  });
});
