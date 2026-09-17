import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DocumentTypeId } from "@/server/deterministic/document-type-registry";
import { findMissingStandardClauses, STANDARD_CLAUSES_BY_DOCUMENT_TYPE } from "@/server/deterministic/standard-clauses";

// Monotonicity: adding text never adds a gap, and adding any presence phrase removes that item's gap.

const cp = (...points: number[]) => String.fromCodePoint(...points);

const NEUTRAL_PARAGRAPH =
  "This paper records the particulars settled between the persons named in it. Each person has read every page " +
  "with care and signs it in good faith. The headings are for ease of reading only. Words in the singular cover " +
  "the plural where the context allows. Nothing here is meant to be read against either person. A copy of this " +
  "paper is kept by each person named above.";
const NEUTRAL = Array.from({ length: 4 }, () => NEUTRAL_PARAGRAPH).join("\n\n");
const NEUTRAL_WORDS = NEUTRAL.split(" ");

const TUNED_TYPES = ["leave_and_license", "job_offer_letter", "nda", "privacy_policy", "freelance_service_agreement"] as const;
const cases = TUNED_TYPES.flatMap((type) =>
  STANDARD_CLAUSES_BY_DOCUMENT_TYPE[type].flatMap((item) =>
    item.presence.map((phrase) => ({ type, gapId: `${type}.${item.id}`, phrase })),
  ),
);

const gapIdsOf = (type: DocumentTypeId, text: string) => findMissingStandardClauses(type, text).map((gap) => gap.id);

function expectSubset(after: string[], before: string[]) {
  for (const id of after) expect(before).toContain(id);
}

describe("findMissingStandardClauses — monotonicity", () => {
  it("flags every item of every tuned type in the neutral base text", () => {
    for (const type of TUNED_TYPES) {
      expect(gapIdsOf(type, NEUTRAL)).toHaveLength(STANDARD_CLAUSES_BY_DOCUMENT_TYPE[type].length);
    }
  });

  it("removes an item's gap for every one of its presence phrases, and adds none", () => {
    expect(cases.length).toBeGreaterThan(500);
    for (const { type, gapId, phrase } of cases) {
      const before = gapIdsOf(type, NEUTRAL);
      const after = gapIdsOf(type, `${NEUTRAL}\n\n${phrase}.`);

      expect(before, gapId).toContain(gapId);
      expect(after, `"${phrase}" should satisfy ${gapId}`).not.toContain(gapId);
      expectSubset(after, before);
    }
  });

  it("removes the gap wherever the phrase lands, in any case and between any punctuation", () => {
    const separator = fc.constantFrom(" ", "\n", ", ", ". ", " (", ") ", ": ", " - ", "\n\n");
    fc.assert(
      fc.property(
        fc.constantFrom(...cases),
        fc.nat({ max: NEUTRAL_WORDS.length }),
        fc.constantFrom("lower", "upper", "title"),
        separator,
        separator,
        ({ type, gapId, phrase }, position, casing, before, after) => {
          const cased =
            casing === "upper"
              ? phrase.toUpperCase()
              : casing === "title"
                ? phrase.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
                : phrase;
          const text = [
            NEUTRAL_WORDS.slice(0, position).join(" "),
            before,
            cased,
            after,
            NEUTRAL_WORDS.slice(position).join(" "),
          ].join("");

          expect(gapIdsOf(type, text)).not.toContain(gapId);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("never adds a gap when any text is appended", () => {
    const pieces = fc.constantFrom(
      "a", "Z", "0", "7", " ", "\n", "-", "'", ".", "(", "\t",
      cp(0x2019), cp(0xad), cp(0x200b), cp(0xfb01), cp(0x0915), cp(0x0301), cp(0x1f44d),
      "notice", "deposit", "sub", "let", "stamp", "shall", "of",
    );
    const appended = fc.oneof(
      fc.array(pieces, { maxLength: 80 }).map((parts) => parts.join("")),
      fc.string({ unit: "binary", maxLength: 200 }),
    );
    fc.assert(
      fc.property(fc.constantFrom(...TUNED_TYPES), appended, (type, extra) => {
        expectSubset(gapIdsOf(type, `${NEUTRAL}\n${extra}`), gapIdsOf(type, NEUTRAL));
      }),
      { numRuns: 500 },
    );
  });
});
