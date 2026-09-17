import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { clauseMarker, segmentClauses } from "@/server/deterministic/segment";

describe("segmentClauses", () => {
  it("returns an empty array for empty input", () => {
    expect(segmentClauses("")).toEqual([]);
  });

  it("does not treat a 4-digit year followed by a period as a clause number", () => {
    // Reproduced on this project's own leave_and_license.txt fixture: a
    // statute citation ("...the Maharashtra Rent Control Act,\n1999.")
    // wraps so "1999." lands at the start of its own line — a bare
    // `\d+[.)]` marker regex treats that exactly like a clause number.
    const text = "1.2 This clause cites the Maharashtra Rent Control Act,\n1999.\n\n2. NEXT CLAUSE\nBody text.";
    const clauses = segmentClauses(text);

    // "1999." must NOT start its own clause — it should remain part of
    // clause 1.2's own text (or at minimum never appear as a clause's own
    // heading/start), and the document should segment into exactly the 2
    // REAL clauses (1.2 and 2), not 3.
    expect(clauses.some((c) => c.text.startsWith("1999."))).toBe(false);
    expect(clauses.length).toBe(2);
    expect(clauses[0].text.startsWith("1.2")).toBe(true);
    expect(clauses[0].text).toContain("1999.");
    expect(clauses[1].text.startsWith("2. NEXT CLAUSE")).toBe(true);
  });

  it("the project's own leave_and_license fixture never produces a clause equal to a bare year", () => {
    const fixtureText = readFileSync(
      join(process.cwd(), "tests", "fixtures", "documents", "leave_and_license.txt"),
      "utf8",
    );
    expect(fixtureText).toContain("1999.");

    const clauses = segmentClauses(fixtureText);
    for (const clause of clauses) {
      expect(clause.text.trim()).not.toBe("1999.");
      expect(clause.text.trim()).not.toMatch(/^\d{4}\.$/);
    }
  });

  it("still recognizes ordinary 1-3 digit clause numbers, including a triple-digit edge case", () => {
    const text = "999. A clause numbered in the high hundreds.\n\nBody text for it here.";
    const clauses = segmentClauses(text);
    expect(clauses[0].text.startsWith("999.")).toBe(true);
  });

  it("segments numbered clauses (1., 1.1) into separate entries", () => {
    const text = "1. TERM\nThis is the term clause.\n\n1.1 Sub-term detail here.\n\n2. FEES\nFee details.";
    const clauses = segmentClauses(text);

    expect(clauses.length).toBe(3);
    expect(clauses[0].text.startsWith("1. TERM")).toBe(true);
    expect(clauses[1].text.startsWith("1.1 Sub-term")).toBe(true);
    expect(clauses[2].text.startsWith("2. FEES")).toBe(true);
    for (const clause of clauses) {
      expect(text.slice(clause.start, clause.end)).toBe(clause.text);
    }
  });

  it("segments lettered sub-clauses like (a), (b)", () => {
    const text = "3. EXCLUSIONS\n(a) known before disclosure;\n(b) publicly available.";
    const clauses = segmentClauses(text);

    expect(clauses.length).toBe(3);
    expect(clauses[0].text.startsWith("3. EXCLUSIONS")).toBe(true);
    expect(clauses[1].text.startsWith("(a)")).toBe(true);
    expect(clauses[2].text.startsWith("(b)")).toBe(true);
  });

  it("recognizes 'Clause N', 'Section N', and 'ARTICLE <roman>' markers", () => {
    const text = "Clause 3\nSome text.\n\nSection 4\nMore text.\n\nARTICLE II\nEven more text.";
    const clauses = segmentClauses(text);

    expect(clauses.length).toBe(3);
    expect(clauses[0].text.startsWith("Clause 3")).toBe(true);
    expect(clauses[1].text.startsWith("Section 4")).toBe(true);
    expect(clauses[2].text.startsWith("ARTICLE II")).toBe(true);
  });

  it("splits unnumbered paragraphs on blank lines", () => {
    const text = "First unnumbered paragraph of prose.\n\nSecond unnumbered paragraph of prose.";
    const clauses = segmentClauses(text);

    expect(clauses.length).toBe(2);
    expect(clauses[0].text).toBe("First unnumbered paragraph of prose.");
    expect(clauses[1].text).toBe("Second unnumbered paragraph of prose.");
  });

  it("captures a preamble before the first numbered clause as its own clause(s)", () => {
    const text = "PREAMBLE TEXT ABOUT THE PARTIES.\n\n1. TERM\nBody of the term clause.";
    const clauses = segmentClauses(text);

    expect(clauses.length).toBe(2);
    expect(clauses[0].text).toBe("PREAMBLE TEXT ABOUT THE PARTIES.");
    expect(clauses[1].text.startsWith("1. TERM")).toBe(true);
  });

  it("sets a heading for a multi-line clause with a short first line, omits it for single-line clauses", () => {
    const text = "1. DEFINITIONS\nThis clause defines terms used throughout.\n\n2. Short one-liner clause.";
    const clauses = segmentClauses(text);

    expect(clauses[0].heading).toBe("1. DEFINITIONS");
    expect(clauses[1].heading).toBeUndefined();
  });

  it("assigns sequential zero-based indices", () => {
    const text = "1. A\nBody.\n\n2. B\nBody.\n\n3. C\nBody.";
    const clauses = segmentClauses(text);
    expect(clauses.map((c) => c.index)).toEqual([0, 1, 2]);
  });

  it("every clause satisfies text === canonicalText.slice(start, end) on a realistic fixture", () => {
    const text = [
      "LEAVE AND LICENSE AGREEMENT",
      "",
      "This Agreement is made between the parties below.",
      "",
      "1. TERM",
      "1.1 This agreement runs for eleven months.",
      "1.2 It may be renewed by mutual consent.",
      "",
      "2. FEES",
      "(a) Monthly fee of Rs. 32,000.",
      "(b) Security deposit of Rs. 1,60,000.",
    ].join("\n");

    const clauses = segmentClauses(text);
    expect(clauses.length).toBeGreaterThan(0);
    for (const clause of clauses) {
      expect(text.slice(clause.start, clause.end)).toBe(clause.text);
    }
  });
});

describe("segmentClauses — property: slice invariant and non-overlap", () => {
  it("every clause's text equals canonicalText.slice(start, end), and clauses never overlap", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.string({ minLength: 0, maxLength: 40 }),
            fc.constantFrom(
              "1. Clause text here.",
              "1.1 Sub-clause text.",
              "(a) Lettered sub-clause.",
              "Section 4",
              "ARTICLE II",
              "",
            ),
          ),
          { minLength: 0, maxLength: 15 },
        ),
        (lines) => {
          const canonicalText = lines.join("\n");
          const clauses = segmentClauses(canonicalText);

          for (const clause of clauses) {
            // The load-bearing invariant: text is exactly the slice at [start, end).
            expect(canonicalText.slice(clause.start, clause.end)).toBe(clause.text);
            expect(clause.start).toBeGreaterThanOrEqual(0);
            expect(clause.end).toBeLessThanOrEqual(canonicalText.length);
            expect(clause.start).toBeLessThan(clause.end);
          }

          for (let i = 0; i < clauses.length - 1; i++) {
            expect(clauses[i].end).toBeLessThanOrEqual(clauses[i + 1].start);
          }

          expect(clauses.map((c) => c.index)).toEqual(clauses.map((_, i) => i));
        },
      ),
    );
  });
});

describe("clauseMarker", () => {
  it.each([
    ["1. Rent is due monthly", "1."],
    ["  2.3.4 Notice period", "2.3.4"],
    ["(a) the Licensee shall", "(a)"],
    ["(iv) any sub-letting", "(iv)"],
    ["Clause 3 Termination", "Clause 3"],
    ["ARTICLE II Definitions", "ARTICLE II"],
  ])("returns the marker %j opens with", (line, marker) => {
    expect(clauseMarker(line)).toBe(marker);
  });

  it.each(["30 days notice is required", "1999. Maharashtra Rent Control Act", "Rent is due", ""])(
    "returns null for a line that opens no clause: %j",
    (line) => {
      expect(clauseMarker(line)).toBeNull();
    },
  );

  it("agrees with segmentClauses: every clause after the preamble starts with a marker", () => {
    const text = "Preamble text.\n\n1. First clause.\n(a) Sub clause.\nClause 2 Second.";
    const clauses = segmentClauses(text);
    expect(clauses.slice(1).map((c) => clauseMarker(c.text))).toEqual(["1.", "(a)", "Clause 2"]);
  });
});
