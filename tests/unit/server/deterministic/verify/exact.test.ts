import { describe, expect, it } from "vitest";
import { findExact } from "@/server/deterministic/verify/exact";
import { buildMatchText, normalizeForMatch } from "@/server/deterministic/verify/normalize";

// The runtime self-check in findExact never fires on a correct offset map, so
// black-box tests cannot see it. These feed findExact a deliberately corrupted
// map (fault injection through data, not a test hook) to pin what it must do
// when the map is wrong: stop, rather than return the wrong span or scan on to
// a later occurrence.
describe("findExact — the self-check stops a corrupted offset map", () => {
  const text = "Rent is due. X Rent is due.";
  const needle = normalizeForMatch("Rent is due.");

  it("control: the uncorrupted map finds the first occurrence", () => {
    expect(findExact(needle, text, buildMatchText(text))).toEqual({ spanStart: 0, spanEnd: 12 });
  });

  it("a map whose first occurrence ends one token too far yields null, not that span and not the second occurrence", () => {
    const match = buildMatchText(text);
    const unitBoundary = match.unitBoundary.slice();
    const lastUnitOfFirst = match.unitOf[11]; // the "." ending the first occurrence
    // Claims the "." unit runs to offset 14, swallowing " X". Offset 14 is
    // itself a token boundary, so only the self-check can catch it.
    unitBoundary[lastUnitOfFirst + 1] = 14;
    expect(normalizeForMatch(text.slice(0, 14))).not.toBe(needle);
    expect(findExact(needle, text, { ...match, unitBoundary })).toBeNull();
  });
});
