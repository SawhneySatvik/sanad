import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildMatchText, normalizeForMatch } from "@/server/deterministic/verify/normalize";
import { referenceNormalize } from "@tests/support/oracles/reference-normalize";

describe("normalizeForMatch — the documented tolerances", () => {
  it("collapses every whitespace/line-break run to one space and trims", () => {
    expect(normalizeForMatch(" \t The\r\nTenant\u00a0\u2028 shall\u3000pay \n")).toBe("The Tenant shall pay");
  });

  it("maps smart quotes and dashes to ASCII", () => {
    expect(normalizeForMatch("\u201cLandlord\u201d \u2018s\u2019 a\u2013b\u2014c\u2212d")).toBe('"Landlord" \'s\' a-b-c-d');
  });

  it("composes to NFC, so decomposed and precomposed text compare equal", () => {
    expect(normalizeForMatch("cafe\u0301")).toBe("caf\u00e9");
    expect(normalizeForMatch("\u1100\u1161\u11a8")).toBe("\uac01");
  });

  it("does NOT tolerate case, punctuation presence, or invisible characters", () => {
    expect(normalizeForMatch("Tenant")).not.toBe(normalizeForMatch("tenant"));
    expect(normalizeForMatch("rent, due")).not.toBe(normalizeForMatch("rent due"));
    expect(normalizeForMatch("co\u00adoperate")).not.toBe(normalizeForMatch("cooperate"));
    // U+FEFF renders as nothing: it must not become a space.
    expect(normalizeForMatch("a\ufeffb")).not.toBe(normalizeForMatch("a b"));
  });

  it("returns empty for whitespace-only input", () => {
    expect(normalizeForMatch(" \r\n\t\u00a0")).toBe("");
  });

  it("stays linear on a long combining-mark run (whole-string NFC is quadratic there)", () => {
    const marks = ["\u0301", "\u0316", "\u0334"];
    let text = "a";
    for (let i = 0; i < 400_000; i++) text += marks[i % 3];
    const started = performance.now();
    buildMatchText(text);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

// Each piece starts with a code point that never attaches to what precedes it,
// and no mark follows whitespace — the domain on which chunked NFC must equal
// whole-string NFC exactly.
const PIECES = [
  "a", "b", "e", "N", "E", "A", "R", "1", "0", "?", ":", "|", '"', "*", "(", ")", "^", "-", "NEAR",
  " ", "  ", "\t", "\r\n", "\n", "\r", "\u00a0", "\u2028",
  "e\u0301", "a\u0323\u0301", "o\u0308\u0304", "x\u0301", "\u00e9", "\u212b", "\u2126",
  "\u1100\u1161", "\u1100\u1161\u11a8", "\uac00\u11a8",
  "\u2018", "\u2019", "\u201c", "\u201d", "\u2013", "\u2014", "\u2212", "\u2026", "\ufb01",
  "\u00ad", "\u200b", "\ufeff", "क्ष", "\u0958", "👍", "👍\ud83c\udffd",
  "👨\u200d👩", "\u0130",
];

describe("normalizeForMatch — agrees with a plain whole-string reference", () => {
  it("equals NFC + regex mapping/collapse/trim on piece-built strings", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...PIECES), { maxLength: 40 }), (pieces) => {
        const input = pieces.join("");
        expect(normalizeForMatch(input)).toBe(referenceNormalize(input));
      }),
      { numRuns: 1000 },
    );
  });
});

describe("buildMatchText — offset map is well-formed on any input", () => {
  it("units tile the original string and every output code unit maps to one", () => {
    const anyText = fc.oneof(
      fc.string({ unit: "binary", maxLength: 80 }),
      fc.array(fc.constantFrom(...PIECES, "\ud800", "\udc00", "\u0301", "\u200d", " \u0301"), { maxLength: 40 }).map(
        (p) => p.join(""),
      ),
    );
    fc.assert(
      fc.property(anyText, (input) => {
        const mt = buildMatchText(input);
        const units = mt.unitBoundary.length - 1;
        expect(mt.unitBoundary[0]).toBe(0);
        expect(mt.unitBoundary[units]).toBe(input.length);
        for (let u = 0; u < units; u++) expect(mt.unitBoundary[u + 1]).toBeGreaterThan(mt.unitBoundary[u]);
        expect(mt.unitOf.length).toBe(mt.text.length);
        if (mt.text.length === 0) return;
        expect(mt.unitOf[0]).toBe(0);
        for (let i = 1; i < mt.unitOf.length; i++) expect([0, 1]).toContain(mt.unitOf[i] - mt.unitOf[i - 1]);
        expect(mt.unitOf[mt.text.length - 1]).toBe(units - 1);
      }),
      { numRuns: 1000 },
    );
  });
});
