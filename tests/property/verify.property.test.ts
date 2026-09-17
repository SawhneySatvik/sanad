import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { InputMode } from "@/server/core/types";
import { isVerifyResult, VERIFIER_VERSION, verify, verifyMany, type VerifyResult } from "@/server/deterministic/verify/index";
import { normalizeForMatch } from "@/server/deterministic/verify/normalize";
import { referenceNormalize } from "@tests/support/oracles/reference-normalize";

// Special characters are built from code points, never written as escapes — the agent Write tool
// turns \uXXXX escapes in string literals into literal characters, silently testing the wrong input.
const cp = (...points: number[]) => String.fromCodePoint(...points);

// Unicode shapes that break naive offset maps: emoji (surrogate pairs, ZWJ sequences, skin tones),
// combining marks, Hangul jamo, CRLF/CR/LF, NBSP, smart punctuation, invisible characters and lone
// surrogates. Every piece starts with a code point that never attaches to what precedes it.
const HOSTILE_PIECES = [
  "?", ":", "|", '"', "*", "(", ")", "^", "-", "NEAR", "near", "AND", "OR", "NOT", "'", ";", "\\", "%", "_",
  "a", "b", "e", "N", "E", "A", "1", "0", ".", ",",
  " ", "  ", "\t", "\r\n", "\n", "\r", "\u00a0", "\u2028",
  "e\u0301", "a\u0323\u0301", "x\u0301", "\u00e9", "\u212b",
  "\u1100\u1161", "\u1100\u1161\u11a8",
  "\u2018", "\u2019", "\u201c", "\u201d", "\u2013", "\u2014", "\u2026", "\ufb01",
  "\u00ad", "\u200b", "\ufeff", "क्ष",
  "👍", "👍\ud83c\udffd", "👨\u200d👩", "❤\ufe0f",
  "\ud800",
];

const pieces = fc.array(fc.constantFrom(...HOSTILE_PIECES), { maxLength: 60 });
const hostileText = pieces.map((p) => p.join(""));
// Raw code units too: lone low surrogates, stray marks, anything.
const anyText = fc.oneof(
  hostileText,
  fc.string({ unit: "binary", maxLength: 120 }),
  fc.string({ unit: fc.constantFrom("a", " ", "\u0301", "\udc00", "\ud800", "\r", "\u200d", "?", "NEAR"), maxLength: 60 }),
);
const anyMode = fc.constantFrom<InputMode>("text", "native_document", "garbage" as InputMode);

function assertWellFormed(r: VerifyResult, quote: string, canonicalText: string, inputMode: InputMode) {
  expect(isVerifyResult(r)).toBe(true);
  expect(r.verifierVersion).toBe(VERIFIER_VERSION);
  if (r.status === "not_found") {
    expect(r.spanStart).toBeNull();
    expect(r.spanEnd).toBeNull();
    return;
  }
  expect(["verified", "approximate"]).toContain(r.status);
  expect(Number.isInteger(r.spanStart) && Number.isInteger(r.spanEnd)).toBe(true);
  expect(r.spanStart).toBeGreaterThanOrEqual(0);
  expect(r.spanEnd).toBeGreaterThan(r.spanStart);
  expect(r.spanEnd).toBeLessThanOrEqual(canonicalText.length);
  if (inputMode !== "text") expect(r.status).not.toBe("verified");
  if (r.status === "verified") {
    // What the UI highlights normalizes to exactly the quote — judged by the independent
    // reference, not by normalizeForMatch, which verify() uses internally and would agree with
    // any bug in itself.
    const shown = canonicalText.slice(r.spanStart, r.spanEnd);
    expect(referenceNormalize(shown)).toBe(referenceNormalize(quote));
    // The token-boundary rule, restated without any Cf look-through: never a word character
    // on both sides of either edge.
    expect(wordOnBothSides(canonicalText, r.spanStart)).toBe(false);
    expect(wordOnBothSides(canonicalText, r.spanEnd)).toBe(false);
  }
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
function wordOnBothSides(text: string, pos: number): boolean {
  if (pos === 0 || pos === text.length) return false;
  const before = String.fromCodePoint(text.codePointAt(pos - 1)!);
  const beforePair = pos >= 2 ? text.slice(pos - 2, pos) : "";
  const left = beforePair.length === 2 && [...beforePair].length === 1 ? beforePair : before;
  const right = String.fromCodePoint(text.codePointAt(pos)!);
  return WORD_CHAR.test(left) && WORD_CHAR.test(right);
}

describe("verify — property: never throws, always well-formed", () => {
  it("any quote × any canonicalText × any inputMode", () => {
    fc.assert(
      fc.property(anyText, anyText, anyMode, (quote, canonicalText, inputMode) => {
        assertWellFormed(verify({ quote, canonicalText, inputMode }), quote, canonicalText, inputMode);
      }),
      { numRuns: 2000 },
    );
  });

  it("arbitrary code-unit slices (mid-grapheme, mid-surrogate): any verified result round-trips", () => {
    fc.assert(
      fc.property(anyText, fc.nat(), fc.nat(), (canonicalText, a, b) => {
        const i = canonicalText.length === 0 ? 0 : a % (canonicalText.length + 1);
        const j = canonicalText.length === 0 ? 0 : b % (canonicalText.length + 1);
        const quote = canonicalText.slice(Math.min(i, j), Math.max(i, j));
        assertWellFormed(verify({ quote, canonicalText, inputMode: "text" }), quote, canonicalText, "text");
      }),
      { numRuns: 2000 },
    );
  });
});

// Words of 1-3 hostile pieces (plus flags) separated by single spaces: every
// word edge is a token boundary, so any run of whole words must verify.
const WORD_PIECES = [
  ...HOSTILE_PIECES.filter((p) => normalizeForMatch(p) !== ""),
  cp(0x1f1fa, 0x1f1f8),
  cp(0x1f1ee, 0x1f1f3),
];
const words = fc.array(
  fc.array(fc.constantFrom(...WORD_PIECES), { minLength: 1, maxLength: 3 }).map((p) => p.join("")),
  { maxLength: 30 },
);

describe("verify — property: whole-word runs verify and round-trip", () => {
  it("a run of whole words is verified (text) / approximate (native) at spans that round-trip", () => {
    fc.assert(
      fc.property(words, fc.nat(), fc.nat(), (ws, a, b) => {
        const canonicalText = ws.join(" ");
        const from = Math.min(a, b) % (ws.length + 1);
        const to = from + (Math.max(a, b) % (ws.length + 1 - from));
        const quote = ws.slice(from, to).join(" ");
        const asText = verify({ quote, canonicalText, inputMode: "text" });
        const asNative = verify({ quote, canonicalText, inputMode: "native_document" });
        if (from === to) {
          expect(asText.status).toBe("not_found");
          return;
        }
        expect(asText.status).toBe("verified");
        assertWellFormed(asText, quote, canonicalText, "text");
        // First boundary-valid occurrence: never later than where this run sits.
        const runStart = from === 0 ? 0 : ws.slice(0, from).join(" ").length + 1;
        expect(asText.spanStart).toBeLessThanOrEqual(runStart);
        expect(asNative.status).toBe("approximate");
        expect([asNative.spanStart, asNative.spanEnd]).toEqual([asText.spanStart, asText.spanEnd]);
      }),
      { numRuns: 3000 },
    );
  });
});

// Single tokens by the token-boundary rule's definition: word characters joined by at most one
// word joiner, or digit groups joined by one of , . / — so every proper piece
// of one has at least one edge inside the token.
const WORD_SEGMENT = fc
  .array(fc.constantFrom("a", "b", "N", "1", "0", "e" + cp(0x301), cp(0x915, 0x94d, 0x937), cp(0x92a, 0x93e)), {
    minLength: 1,
    maxLength: 4,
  })
  .map((p) => p.join(""));
const DIGIT_SEGMENT = fc.array(fc.constantFrom("1", "2", "0", cp(0x967)), { minLength: 1, maxLength: 4 }).map((p) => p.join(""));
const joinedBy = (segment: fc.Arbitrary<string>, joiners: string[]) =>
  fc
    .tuple(segment, fc.array(fc.tuple(fc.constantFrom(...joiners), segment), { maxLength: 4 }))
    .map(([head, rest]) => head + rest.map(([joiner, s]) => joiner + s).join(""));
const singleToken = fc.oneof(
  joinedBy(WORD_SEGMENT, ["", "-", "'", cp(0x2010), cp(0x2011), cp(0x2013), cp(0x2014), cp(0x2019)]),
  joinedBy(DIGIT_SEGMENT, [",", ".", "/"]),
);

describe("verify — property: never verifies a strict piece of one token", () => {
  it("any proper substring of a single token is not verified", () => {
    fc.assert(
      fc.property(singleToken, fc.nat(), fc.nat(), (token, a, b) => {
        const i = a % token.length;
        const j = i + 1 + (b % (token.length - i));
        fc.pre(!(i === 0 && j === token.length));
        const quote = token.slice(i, j);
        expect(verify({ quote, canonicalText: token, inputMode: "text" }).status).not.toBe("verified");
        // Padded with spaces only: any other context could hold a real, separate occurrence.
        expect(verify({ quote, canonicalText: `  ${token}  `, inputMode: "text" }).status).not.toBe("verified");
      }),
      { numRuns: 3000 },
    );
  });
});

// The document never contains Cyrillic or the letter R; every word of the
// quote contains one of them, so no exact match and no known token exist.
const DOC_PIECES = HOSTILE_PIECES.filter((p) => !/[rR]/.test(p));
const ABSENT_WORDS = ["ж", "фщ", "ЖИВ", "NEAR", "rent", "R"];
const ABSENT_PUNCT = ["?", ":", "|", '"', "*", "(", ")", "^", "-", " ", "\r\n", "\u201c", "\u2014", "👍"];

describe("verify — property: absent quotes are not_found", () => {
  it("a quote whose every word is guaranteed absent from the document", () => {
    const doc = fc.array(fc.constantFrom(...DOC_PIECES), { maxLength: 80 }).map((p) => p.join(""));
    const absentQuote = fc
      .tuple(
        fc.array(fc.oneof(fc.constantFrom(...ABSENT_WORDS), fc.constantFrom(...ABSENT_PUNCT)), { maxLength: 30 }),
        fc.constantFrom("ж", "фщ"),
        fc.nat(),
      )
      .map(([parts, cyrillic, at]) => {
        const withCyrillic = [...parts];
        withCyrillic.splice(at % (parts.length + 1), 0, " ", cyrillic, " ");
        return withCyrillic.join("");
      });
    fc.assert(
      fc.property(absentQuote, doc, anyMode, (quote, canonicalText, inputMode) => {
        expect(verify({ quote, canonicalText, inputMode }).status).toBe("not_found");
      }),
      { numRuns: 2000 },
    );
  });
});

describe("verify — property: deterministic", () => {
  it("repeated calls and verifyMany agree exactly", () => {
    fc.assert(
      fc.property(fc.array(anyText, { maxLength: 6 }), hostileText, anyMode, (quotes, canonicalText, inputMode) => {
        // Include real substrings so verified/approximate paths are exercised, not just not_found.
        const all = [...quotes, canonicalText.slice(0, 20), canonicalText.slice(5, 60).toUpperCase()];
        const once = all.map((quote) => ({ ...verify({ quote, canonicalText, inputMode }) }));
        const twice = all.map((quote) => ({ ...verify({ quote, canonicalText, inputMode }) }));
        const batched = verifyMany(all, canonicalText, inputMode).map((r) => ({ ...r }));
        expect(twice).toEqual(once);
        expect(batched).toEqual(once);
      }),
      { numRuns: 500 },
    );
  });
});
