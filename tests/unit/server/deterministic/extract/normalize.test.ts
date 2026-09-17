import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normalizeText } from "@/server/deterministic/extract/normalize";

describe("normalizeText", () => {
  it("converts CRLF and lone CR to LF", () => {
    expect(normalizeText("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("strips a leading BOM", () => {
    expect(normalizeText("﻿Hello")).toBe("Hello");
  });

  it("collapses horizontal whitespace runs to a single space", () => {
    expect(normalizeText("a   b\t\tc")).toBe("a b c");
  });

  it("trims trailing horizontal whitespace at line ends", () => {
    expect(normalizeText("a   \nb")).toBe("a\nb");
  });

  it("collapses 3+ consecutive newlines to exactly one blank line", () => {
    expect(normalizeText("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("preserves a single blank line between paragraphs", () => {
    expect(normalizeText("a\n\nb")).toBe("a\n\nb");
  });

  it("strips stray C0 control characters but keeps \\n and \\t", () => {
    expect(normalizeText("a\x00\x01\x1Fb\nc\td")).toBe("ab\nc d");
  });

  it("applies Unicode NFC composition", () => {
    const decomposed = "é"; // "e" + combining acute accent
    const precomposed = "é"; // "é"
    expect(normalizeText(decomposed)).toBe(normalizeText(precomposed));
  });

  it("trims leading/trailing whitespace from the whole string", () => {
    expect(normalizeText("  \n hello \n  ")).toBe("hello");
  });

  it("is idempotent on a representative mixed-whitespace legal-text sample", () => {
    const sample = "1.  TERM\r\n\r\n\r\nThis   Agreement\tshall commence...\r\n\r\n\r\n\r\n2. FEES\r\n";
    const once = normalizeText(sample);
    const twice = normalizeText(once);
    expect(twice).toBe(once);
  });

  it("stays idempotent when a control character sits between a base letter and a combining mark", () => {
    // A control char between a base letter and a combining mark blocks NFC
    // composition on pass 1; stripping control chars must run BEFORE NFC,
    // or pass 2 (which no longer has the control char) would compose the
    // sequence differently than pass 1 did — breaking idempotency.
    const input = "e\x01́"; // "e", SOH (control), combining acute accent
    const once = normalizeText(input);
    const twice = normalizeText(once);
    expect(twice).toBe(once);
    expect(once).toBe("é"); // precomposed "é"
  });

  it("maps vertical tab / form feed to a newline instead of stripping them outright, so adjacent words are never glued together", () => {
    // Stripping \x0B/\x0C entirely instead of mapping them to a newline would invent a word
    // verify() could then wrongly "confirm" exists in the source ("is not\x0Bable" -> "is notable").
    const verticalTab = String.fromCharCode(0x0b);
    const formFeed = String.fromCharCode(0x0c);
    expect(normalizeText(`is not${verticalTab}able to sublet`)).toBe("is not\nable to sublet");
    expect(normalizeText(`is not${verticalTab}able to sublet`)).not.toContain("notable");
    expect(normalizeText(`page one${formFeed}page two`)).toBe("page one\npage two");
  });

  it("maps NEL, LINE SEPARATOR, and PARAGRAPH SEPARATOR to a newline too", () => {
    const nel = String.fromCharCode(0x85);
    const lineSeparator = String.fromCharCode(0x2028);
    const paragraphSeparator = String.fromCharCode(0x2029);
    expect(normalizeText(`a${nel}b`)).toBe("a\nb");
    expect(normalizeText(`a${lineSeparator}b`)).toBe("a\nb");
    expect(normalizeText(`a${paragraphSeparator}b`)).toBe("a\nb");
  });
});

describe("normalizeText — bidirectional control characters are stripped", () => {
  // Every embedding, override, isolate and directional mark: rendered, each can reorder the
  // characters around it, so the displayed text would differ from the text verify() matched.
  const BIDI_CONTROL_CODEPOINTS = [
    0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c,
  ];

  it("removes each one, leaving the surrounding text intact", () => {
    for (const codePoint of BIDI_CONTROL_CODEPOINTS) {
      const control = String.fromCharCode(codePoint);
      const input = `refunded within ${control}03 days`;
      expect(input.codePointAt(16)).toBe(codePoint);
      expect(normalizeText(input)).toBe("refunded within 03 days");
    }
  });

  it("removes a bidi control between a base letter and a combining mark before NFC, so the pair still composes", () => {
    const input = `e${String.fromCharCode(0x202e)}${String.fromCharCode(0x0301)}`;
    expect(input.length).toBe(3);
    expect(normalizeText(input)).toBe(String.fromCharCode(0x00e9));
  });

  it("leaves zero-width joiner and non-joiner alone — Indic scripts need them", () => {
    const input = `a${String.fromCharCode(0x200d)}b${String.fromCharCode(0x200c)}c`;
    expect(normalizeText(input)).toBe(input);
  });
});

describe("normalizeText — lone UTF-16 surrogates become well-formed", () => {
  it("three distinct lone-surrogate inputs normalize to the identical, well-formed text", () => {
    // Built via String.fromCharCode, not a `\uD800`-style escape literal: the Write tool can turn
    // such escapes into the wrong raw character, which would make this pass for the wrong reason.
    // The assertions right below are the actual proof this input is what it's supposed to be.
    const highSurrogateA = String.fromCharCode(0xd800) + "abc";
    const highSurrogateB = String.fromCharCode(0xd801) + "abc";
    const lowSurrogate = String.fromCharCode(0xdc00) + "abc";

    for (const s of [highSurrogateA, highSurrogateB, lowSurrogate]) {
      expect(s.isWellFormed()).toBe(false);
    }
    expect(highSurrogateA).not.toBe(highSurrogateB);
    expect(highSurrogateA).not.toBe(lowSurrogate);
    expect(highSurrogateB).not.toBe(lowSurrogate);

    const normalized = [highSurrogateA, highSurrogateB, lowSurrogate].map(normalizeText);
    expect(normalized[0]).toBe(normalized[1]);
    expect(normalized[1]).toBe(normalized[2]);
    expect(normalized[0].isWellFormed()).toBe(true);
    expect(normalized[0]).toBe(`${String.fromCharCode(0xfffd)}abc`);
  });
});

describe("normalizeText — combining-mark run guard bounds NFC's worst-case cost", () => {
  it("rejects an excessively long single-base-character combining-mark run in well under a second", () => {
    // Hebrew point marks span many Unicode canonical combining classes, making NFC's reordering
    // expensive for a long run of them — a bare `.normalize("NFC")` on this 400,001-character
    // payload measures 84.5s. The guard runs before NFC, so this proves it rejects the input fast.
    const hebrewPoints: string[] = [];
    for (let codePoint = 0x05b0; codePoint <= 0x05bc; codePoint++) {
      hebrewPoints.push(String.fromCharCode(codePoint));
    }
    let bomb = String.fromCharCode(0x05d0); // Hebrew letter Alef (base character)
    for (let i = 0; i < 400_000; i++) {
      bomb += hebrewPoints[hebrewPoints.length - 1 - (i % hebrewPoints.length)];
    }
    expect(bomb.length).toBe(400_001);

    const t0 = Date.now();
    expect(() => normalizeText(bomb)).toThrow(
      expect.objectContaining({ code: "INVALID_DOCUMENT" }),
    );
    const elapsedMs = Date.now() - t0;
    // Generous stated bound: the guard itself measured under 15ms in
    // manual testing; 1s leaves comfortable headroom for slower CI
    // machines while remaining two orders of magnitude below the 84.5s
    // unguarded failure mode this guard exists to prevent.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("still rejects a long run split into short ones by control or bidi characters, which the strip step would rejoin before NFC", () => {
    const hebrewPoints: string[] = [];
    for (let codePoint = 0x05b0; codePoint <= 0x05bc; codePoint++) {
      hebrewPoints.push(String.fromCharCode(codePoint));
    }
    for (const separator of [String.fromCharCode(0x01), String.fromCharCode(0x202e)]) {
      let bomb = String.fromCharCode(0x05d0);
      for (let i = 0; bomb.length < 80_000; i++) {
        bomb += hebrewPoints[i % hebrewPoints.length];
        if (i % 30 === 29) bomb += separator;
      }
      expect(/\p{M}{31,}/u.test(bomb)).toBe(false);

      const t0 = Date.now();
      expect(() => normalizeText(bomb)).toThrow(expect.objectContaining({ code: "INVALID_DOCUMENT" }));
      // Unguarded, this 80,000-character input took 27s in NFC.
      expect(Date.now() - t0).toBeLessThan(1000);
    }
  });

  it("does not false-positive on realistic legal-document text with ordinary accented characters", () => {
    const realistic = "The licensee shall pay the café's café's café's naïve résumé fee promptly.".repeat(50);
    expect(() => normalizeText(realistic)).not.toThrow();
  });
});

describe("normalizeText — property: idempotent for any input", () => {
  it("normalizeText(normalizeText(x)) === normalizeText(x)", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const once = normalizeText(input);
        const twice = normalizeText(once);
        expect(twice).toBe(once);
      }),
    );
  });

  it("holds for arbitrary full-Unicode input too (combining marks, astral chars, control chars)", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 200 }), (input) => {
        const once = normalizeText(input);
        const twice = normalizeText(once);
        expect(twice).toBe(once);
      }),
    );
  });

  it("holds over a targeted alphabet that deliberately mixes base letters, combining marks, control chars, bidi controls, and BOM — the exact shape that breaks composition-order idempotency bugs", () => {
    const alphabet = fc.constantFrom(
      "e",
      "a",
      "́", // combining acute
      "̈", // combining diaeresis
      "\x01", // SOH control char
      "\x7F", // DEL
      String.fromCharCode(0x202e), // RIGHT-TO-LEFT OVERRIDE
      String.fromCharCode(0x2067), // RIGHT-TO-LEFT ISOLATE
      String.fromCharCode(0x200f), // RIGHT-TO-LEFT MARK
      " ",
      "\t",
      "\n",
      "\r",
      "﻿", // BOM
    );
    fc.assert(
      fc.property(fc.array(alphabet, { maxLength: 30 }), (chars) => {
        const input = chars.join("");
        const once = normalizeText(input);
        const twice = normalizeText(once);
        expect(twice).toBe(once);
      }),
    );
  });
});
