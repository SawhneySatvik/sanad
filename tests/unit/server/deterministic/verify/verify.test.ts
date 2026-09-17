import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppError } from "@/server/core/errors";
import type { InputMode } from "@/server/core/types";
import { MAX_EXTRACTED_CHARS } from "@/server/deterministic/extract/constants";
import {
  assertVerifyResultFor,
  isVerifyResult,
  MAX_QUOTE_CHARS,
  MAX_QUOTES_PER_CALL,
  VERIFIER_VERSION,
  verify,
  verifyMany,
  type VerifyResult,
} from "@/server/deterministic/verify/index";
import { MAX_CANONICAL_TEXT_CHARS } from "@/server/deterministic/verify/verify";

// Special characters are built from code points, never written as `\uXXXX` escapes: some editing
// tools turn those into the literal character, and the test would silently check the wrong input.
const cp = (...points: number[]) => String.fromCodePoint(...points);
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const LEASE = [
  "LEAVE AND LICENSE AGREEMENT",
  "",
  "4. RENT. The Licensee shall pay the monthly license fee of Rs. 25,000 on or before the",
  "5th day of each calendar month, without demand.",
  "7(b) Termination: either party may terminate this Agreement by giving one (1) month\u2019s",
  "written notice \u2014 the \u201cNotice Period\u201d.",
  '12. Special terms: "NEAR" clauses (rent* ^ | ? : "quoted") - see Annexure-A.',
].join("\r\n");

function text(quote: string, canonicalText = LEASE, inputMode: InputMode = "text"): VerifyResult {
  return verify({ quote, canonicalText, inputMode });
}

function highlighted(r: VerifyResult, canonicalText = LEASE): string | null {
  return r.status === "not_found" ? null : canonicalText.slice(r.spanStart, r.spanEnd);
}

describe("verify — positive: verbatim quotes verify with exact spans", () => {
  it("a quote cut verbatim from canonicalText is verified at its exact offsets", () => {
    const quote = "The Licensee shall pay the monthly license fee of Rs. 25,000";
    const r = text(quote);
    expect(r.status).toBe("verified");
    expect(r.spanStart).toBe(LEASE.indexOf(quote));
    expect(r.spanEnd).toBe(LEASE.indexOf(quote) + quote.length);
    expect(r.verifierVersion).toBe(VERIFIER_VERSION);
  });

  it("returns the first occurrence when the quote appears more than once", () => {
    const doc = "Rent is due monthly. Late fee applies. Rent is due monthly.";
    const r = verify({ quote: "Rent is due monthly.", canonicalText: doc, inputMode: "text" });
    expect(r).toMatchObject({ status: "verified", spanStart: 0, spanEnd: 20 });
  });

  it("verifies V2's FTS-crashing punctuation verbatim — ? : | \" * ( ) ^ - NEAR are plain characters", () => {
    const quote = '12. Special terms: "NEAR" clauses (rent* ^ | ? : "quoted") - see Annexure-A.';
    const r = text(quote);
    expect(r.status).toBe("verified");
    expect(highlighted(r)).toBe(quote);
  });

  it("verifies a quote spanning a CRLF line break, highlighting the original text", () => {
    const r = text("on or before the 5th day of each calendar month");
    expect(r.status).toBe("verified");
    expect(highlighted(r)).toBe("on or before the\r\n5th day of each calendar month");
  });
});

describe("verify — negative: fabricated quotes are not_found", () => {
  it("a fabricated clause is not_found with null spans", () => {
    const r = text("The Licensor may enter the premises at any time without notice");
    expect(r).toMatchObject({ status: "not_found", spanStart: null, spanEnd: null });
  });

  it("a quote that exists only in a different document is not_found", () => {
    expect(text("The employee shall serve a notice period of ninety days").status).toBe("not_found");
  });
});

describe("verify — near-miss rules", () => {
  it("curly vs straight quotes and em dash vs hyphen → verified (normalization tolerates them)", () => {
    const r = text('one (1) month\'s written notice - the "Notice Period".');
    expect(r.status).toBe("verified");
    expect(highlighted(r)).toBe("one (1) month\u2019s\r\nwritten notice \u2014 the \u201cNotice Period\u201d.");
  });

  it("extra whitespace / different line breaks → verified", () => {
    expect(text("The   Licensee\nshall\tpay  the monthly license fee").status).toBe("verified");
  });

  it("one word changed in a >= 5-word quote → approximate, highlighting the document's own words", () => {
    const r = text("The Licensee shall pay the weekly license fee of Rs. 25,000");
    expect(r.status).toBe("approximate");
    expect(highlighted(r)).toBe("The Licensee shall pay the monthly license fee of Rs. 25,000");
  });

  it("case or punctuation drift → approximate, never verified", () => {
    expect(text("the licensee shall pay the monthly license fee").status).toBe("approximate");
    expect(text("The Licensee shall pay, the monthly license fee").status).toBe("approximate");
  });

  it("one word changed in a 4-word quote → not_found (5 * edits must be <= word count)", () => {
    expect(text("Licensee shall pay weekly").status).toBe("not_found");
  });

  it("a quote padded with invented words beyond the 0.8 threshold → not_found", () => {
    expect(text("The Licensee shall promptly and happily pay the monthly license fee").status).toBe("not_found");
  });

  it("does not verify a quote that would split a base letter from its accent", () => {
    const doc = "The cafe\u0301 on the ground floor";
    expect(verify({ quote: "The cafe", canonicalText: doc, inputMode: "text" }).status).not.toBe("verified");
    const r = verify({ quote: "The caf\u00e9 on", canonicalText: doc, inputMode: "text" });
    expect(r).toMatchObject({ status: "verified", spanStart: 0, spanEnd: "The cafe\u0301 on".length });
  });

  it("invisible characters are not tolerated by the exact path", () => {
    const doc = "Both parties shall co\u00adoperate in good faith";
    expect(verify({ quote: "Both parties shall cooperate in good faith", canonicalText: doc, inputMode: "text" }).status).not.toBe(
      "verified",
    );
  });
});

describe("verify — native_document can never be verified", () => {
  it("a byte-for-byte match against the transcription is capped at approximate, same spans", () => {
    const quote = "The Licensee shall pay the monthly license fee of Rs. 25,000";
    const asText = text(quote, LEASE, "text");
    const asNative = text(quote, LEASE, "native_document");
    expect(asText.status).toBe("verified");
    expect(asNative.status).toBe("approximate");
    expect([asNative.spanStart, asNative.spanEnd]).toEqual([asText.spanStart, asText.spanEnd]);
  });

  it("the whole transcription quoted verbatim is still only approximate", () => {
    expect(text(LEASE, LEASE, "native_document").status).toBe("approximate");
  });

  it("any inputMode value other than exactly 'text' is treated as capped", () => {
    const quote = "The Licensee shall pay";
    for (const mode of ["TEXT", "", "native", undefined, null]) {
      const r = verify({ quote, canonicalText: LEASE, inputMode: mode as unknown as InputMode });
      expect(r.status).toBe("approximate");
    }
  });

  it("verifyMany applies the same cap", () => {
    const results = verifyMany(["4. RENT.", "The Licensee shall pay"], LEASE, "native_document");
    expect(results.map((r) => r.status)).toEqual(["approximate", "approximate"]);
  });
});

describe("verify — input rules (never throws, documented not_found cases)", () => {
  it("empty or whitespace-only quote → not_found", () => {
    for (const quote of ["", " ", "\r\n\t\u00a0\u3000"]) expect(text(quote).status).toBe("not_found");
  });

  it("empty canonicalText → not_found", () => {
    expect(text("anything", "").status).toBe("not_found");
    expect(text("", "").status).toBe("not_found");
  });

  it("a quote longer than MAX_QUOTE_CHARS → not_found even though it is present", () => {
    const atCap = "ab ".repeat(1333) + "c"; // 4,000 chars, ends on a token boundary
    const overCap = atCap + " "; // 4,001 chars, same text once trimmed
    const doc = `${atCap} ${"ab ".repeat(10)}`;
    expect(atCap.length).toBe(MAX_QUOTE_CHARS);
    expect(verify({ quote: atCap, canonicalText: doc, inputMode: "text" }).status).toBe("verified");
    expect(verify({ quote: overCap, canonicalText: doc, inputMode: "text" }).status).toBe("not_found");
  });

  it("canonicalText longer than MAX_CANONICAL_TEXT_CHARS (= extract's MAX_EXTRACTED_CHARS) → not_found", () => {
    expect(MAX_CANONICAL_TEXT_CHARS).toBe(MAX_EXTRACTED_CHARS);
    const doc = "rent ".repeat(MAX_CANONICAL_TEXT_CHARS / 5) + "x";
    expect(doc.length).toBe(MAX_CANONICAL_TEXT_CHARS + 1);
    expect(verify({ quote: "rent rent", canonicalText: doc, inputMode: "text" }).status).toBe("not_found");
  });

  it("non-string values smuggled past the types → not_found, not a throw", () => {
    for (const bad of [undefined, null, 42, {}, ["rent"]]) {
      expect(text(bad as unknown as string).status).toBe("not_found");
      expect(verify({ quote: "rent", canonicalText: bad as unknown as string, inputMode: "text" }).status).toBe(
        "not_found",
      );
    }
  });
});

describe("VerifyResult — the brand", () => {
  it("results are frozen, carry the version, and pass isVerifyResult", () => {
    const r = text("4. RENT.");
    expect(Object.isFrozen(r)).toBe(true);
    expect(() => {
      (r as { status: string }).status = "not_found";
    }).toThrow(TypeError);
    expect(isVerifyResult(r)).toBe(true);
    expect(JSON.parse(JSON.stringify(r))).toEqual({
      status: "verified",
      spanStart: r.spanStart,
      spanEnd: r.spanEnd,
      quote: "4. RENT.",
      canonicalTextHash: sha256(LEASE),
      inputMode: "text",
      verifierVersion: VERIFIER_VERSION,
    });
  });

  it("isVerifyResult rejects anything verify() did not construct", () => {
    const r = text("fabricated words nowhere in the lease");
    const forged = { ...r, status: "verified", spanStart: 0, spanEnd: 5 };
    for (const value of [forged, JSON.parse(JSON.stringify(r)), "verified", null, undefined, Object.create(Object.getPrototypeOf(r))]) {
      expect(isVerifyResult(value)).toBe(false);
    }
  });

  it("cannot be forged at the type level (checked by tsc via @ts-expect-error)", () => {
    const real = text("4. RENT.");
    const persist = (result: VerifyResult) => result.status;

    // Every public field present, so the brand is the only thing that can reject the literals below.
    const fields = {
      spanStart: 0,
      spanEnd: 8,
      quote: real.quote,
      canonicalTextHash: real.canonicalTextHash,
      inputMode: real.inputMode,
    };
    // @ts-expect-error — an object literal lacks the #private brand
    const literal: VerifyResult = { status: "verified", ...fields, verifierVersion: VERIFIER_VERSION };
    // @ts-expect-error — spreading a real result drops the #private brand (spans
    // restated so the brand is the ONLY thing that can reject this line)
    const spread: VerifyResult = { ...real, status: "verified", spanStart: 0, spanEnd: 8 };
    // @ts-expect-error — a bare status string is not a result
    const bare: VerifyResult = "verified";
    // @ts-expect-error — persistence code requiring VerifyResult rejects a plain status object
    persist({ status: "verified", ...fields, verifierVersion: VERIFIER_VERSION });

    expect([literal, spread, bare].map(isVerifyResult)).toEqual([false, false, false]);
    expect(persist(real)).toBe("verified");
  });

  it("narrows: spans are numbers unless not_found", () => {
    const r = text("4. RENT.");
    if (r.status !== "not_found") {
      const width: number = r.spanEnd - r.spanStart;
      expect(width).toBe(8);
    }
  });
});

describe("verifyMany", () => {
  it("returns exactly what verify() returns per quote, in order", () => {
    const quotes = [
      "4. RENT.",
      "The Licensee shall pay the weekly license fee of Rs. 25,000",
      "nothing like this exists anywhere",
      "",
      'one (1) month\'s written notice - the "Notice Period".',
    ];
    const many = verifyMany(quotes, LEASE, "text");
    expect(many.map((r) => r.status)).toEqual(["verified", "approximate", "not_found", "not_found", "verified"]);
    quotes.forEach((quote, i) => expect({ ...many[i] }).toEqual({ ...text(quote) }));
    expect(many.every(isVerifyResult)).toBe(true);
  });

  it(`accepts ${MAX_QUOTES_PER_CALL} quotes and rejects one more with a typed error instead of a partial answer`, () => {
    const quotes = Array.from({ length: MAX_QUOTES_PER_CALL }, () => "4. RENT.");
    expect(verifyMany(quotes, LEASE, "text")).toHaveLength(MAX_QUOTES_PER_CALL);
    let thrown: unknown;
    try {
      verifyMany([...quotes, "4. RENT."], LEASE, "text");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("VALIDATION_FAILED");
  });
});

describe("verify — token boundaries: an exact match may not start or end mid-token", () => {
  const inText = (canonicalText: string, quote: string) => verify({ quote, canonicalText, inputMode: "text" });
  const devanagariWord = cp(0x92a, 0x930, 0x940, 0x915, 0x94d, 0x937, 0x93e); // an exam word ending in the conjunct "ksha" + aa

  it("highlights a true quote at its real occurrence, not inside a longer number", () => {
    const doc = "Rent within 130 days. Notice: 30 days.";
    const at = doc.lastIndexOf("30 days");
    expect(inText(doc, "30 days")).toMatchObject({ status: "verified", spanStart: at, spanEnd: at + 7 });
    expect(verify({ quote: "30 days", canonicalText: doc, inputMode: "native_document" })).toMatchObject({
      status: "approximate",
      spanStart: at,
    });
  });

  it.each([
    ["able to terminate", "The licensee is unable to terminate early."],
    ["lawful termination", "Any unlawful termination is void."],
    ["25,000 per month", "Rent is Rs. 1,25,000 per month."],
    ["60 days", `Notice of 30${cp(0x2013)}60 days applies.`],
    ["05/2024", "Payment is due on 12/05/2024."],
    ["refundable deposit", "A non-refundable deposit."],
    ["tenant", "The tenant's deposit."],
    [cp(0x937, 0x93e), devanagariWord],
    [cp(0x1f1f8, 0x1f1ee), cp(0x1f1fa, 0x1f1f8, 0x1f1ee, 0x1f1f3)],
    [cp(0x1f44d), `ok ${cp(0x1f44d, 0x1f3fd)} ok`],
    ["lawful termination", `Any un${cp(0x200b)}lawful termination is void.`],
  ])("%j is not verified inside %j", (quote, doc) => {
    expect(inText(doc, quote).status).not.toBe("verified");
  });

  it.each([
    ["30 days", "Notice: 30 days."],
    ["Clause 4", "See Clause 4, which governs."],
    ["30", "within 30 days"],
    ["non-refundable", "A non-refundable deposit."],
    ["12/05/2024", "Payment is due on 12/05/2024."],
    [cp(0x1f1ee, 0x1f1f3), cp(0x1f1fa, 0x1f1f8, 0x1f1ee, 0x1f1f3)],
    [cp(0x1f44d, 0x1f3fd), `ok ${cp(0x1f44d, 0x1f3fd)} ok`],
    [devanagariWord, `${devanagariWord} ${devanagariWord}`],
  ])("%j still verifies inside %j (boundary-valid, no minimum length)", (quote, doc) => {
    const r = inText(doc, quote);
    expect(r.status).toBe("verified");
    expect(highlighted(r, doc)).toBe(quote);
  });

  it("looks through at most 32 invisible characters, then fails safe", () => {
    const zwsp = (n: number) => cp(0x200b).repeat(n);
    expect(inText(`the ${zwsp(32)}lawful term applies`, "lawful term").status).toBe("verified");
    expect(inText(`the ${zwsp(33)}lawful term applies`, "lawful term").status).not.toBe("verified");
  });

  it("a quote that exists only mid-token falls through to the unchanged approximate path", () => {
    const r = inText("The licensee is unable to terminate the lease early.", "able to terminate the lease early");
    expect(r.status).toBe("approximate");
  });
});

describe("VerifyResult — construction token: runtime forgery throws", () => {
  type AnyConstructor = new (...args: unknown[]) => object;
  const real = verify({ quote: "4. RENT.", canonicalText: LEASE, inputMode: "text" });
  const Constructor = real.constructor as AnyConstructor;
  const args = ["verified", 0, 5, real.quote, real.canonicalTextHash, "text", VERIFIER_VERSION];

  it("calling the constructor reached through a result throws, with or without a look-alike token", () => {
    expect(() => new Constructor(...args)).toThrow();
    expect(() => new Constructor(Symbol("verify/issue"), ...args)).toThrow();
  });

  it("subclassing the constructor and instantiating the subclass throws", () => {
    class Forged extends Constructor {}
    expect(() => new Forged(...args)).toThrow();
    expect(() => new Forged(Symbol("verify/issue"), ...args)).toThrow();
  });

  it("spread, JSON and Object.create forgeries fail isVerifyResult and assertVerifyResultFor", () => {
    const expected = { quote: real.quote, canonicalTextHash: real.canonicalTextHash, inputMode: "text" as const };
    for (const forged of [{ ...real }, JSON.parse(JSON.stringify(real)), Object.create(Object.getPrototypeOf(real))]) {
      expect(isVerifyResult(forged)).toBe(false);
      expect(() => assertVerifyResultFor(forged, expected)).toThrow();
    }
    expect(() => assertVerifyResultFor(real, expected)).not.toThrow();
  });
});

describe("assertVerifyResultFor — a result is bound to its quote, document and input mode", () => {
  const otherDoc = "A different lease. The Licensee shall pay the monthly license fee of Rs. 25,000 in cash.";

  it("carries exactly the quote string it checked, the sha256 (hex, UTF-8) of exactly the text, and the input mode", () => {
    const quote = "  The Licensee shall pay  ";
    const r = verify({ quote, canonicalText: LEASE, inputMode: "text" });
    expect(r.status).toBe("verified");
    expect(r.quote).toBe(quote);
    expect(r.canonicalTextHash).toBe(sha256(LEASE));
    expect(r.canonicalTextHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.inputMode).toBe("text");
    expect(verify({ quote, canonicalText: LEASE, inputMode: "native_document" }).inputMode).toBe("native_document");
  });

  it("rejects a result zipped onto the wrong quote (verifyMany index drift)", () => {
    const quotes = ["4. RENT.", "The Licensee shall pay"];
    const [first, second] = verifyMany(quotes, LEASE, "text");
    const expected = { quote: quotes[0], canonicalTextHash: sha256(LEASE), inputMode: "text" as const };
    expect(() => assertVerifyResultFor(first, expected)).not.toThrow();
    expect(() => assertVerifyResultFor(second, expected)).toThrow(/different quote or document/);
  });

  it("rejects a result computed against the other document (Compare A/B swap)", () => {
    const quote = "The Licensee shall pay the monthly license fee of Rs. 25,000";
    const fromOther = verify({ quote, canonicalText: otherDoc, inputMode: "text" });
    expect(fromOther.status).toBe("verified");
    expect(() =>
      assertVerifyResultFor(fromOther, { quote, canonicalTextHash: sha256(otherDoc), inputMode: "text" }),
    ).not.toThrow();
    expect(() =>
      assertVerifyResultFor(fromOther, { quote, canonicalTextHash: sha256(LEASE), inputMode: "text" }),
    ).toThrow(/different quote or document/);
  });

  it("rejects a `verified` computed with inputMode 'text' for a document that is native_document", () => {
    const quote = "The Licensee shall pay";
    const claimedText = verify({ quote, canonicalText: LEASE, inputMode: "text" });
    expect(claimedText.status).toBe("verified");
    expect(() =>
      assertVerifyResultFor(claimedText, { quote, canonicalTextHash: sha256(LEASE), inputMode: "native_document" }),
    ).toThrow(/different quote or document/);

    const native = verify({ quote, canonicalText: LEASE, inputMode: "native_document" });
    expect(native.status).toBe("approximate");
    expect(() =>
      assertVerifyResultFor(native, { quote, canonicalTextHash: sha256(LEASE), inputMode: "native_document" }),
    ).not.toThrow();
    expect(() =>
      assertVerifyResultFor(native, { quote, canonicalTextHash: sha256(LEASE), inputMode: "text" }),
    ).toThrow(/different quote or document/);
  });

  it("verifyMany binds every result to the same document hash and input mode", () => {
    const results = verifyMany(["4. RENT.", "nothing like this", ""], LEASE, "native_document");
    expect(results.map((r) => r.canonicalTextHash)).toEqual([sha256(LEASE), sha256(LEASE), sha256(LEASE)]);
    expect(results.map((r) => r.quote)).toEqual(["4. RENT.", "nothing like this", ""]);
    expect(results.map((r) => r.inputMode)).toEqual(["native_document", "native_document", "native_document"]);
  });
});
