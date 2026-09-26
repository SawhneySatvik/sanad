import { describe, expect, it } from "vitest";
import { segmentDocumentText, type BoundEntry } from "@/lib/verification/segmentDocumentText";

const TEXT = "The rent is due on the first of every month, and the deposit is refundable.";

function entry(findingId: string, spanStart: number, spanEnd: number, tone: BoundEntry["tone"] = "default"): BoundEntry {
  return { findingId, range: { spanStart, spanEnd, spanText: TEXT.slice(spanStart, spanEnd) }, tone };
}

// Every case here is checked against the same invariant: the segments' own text, concatenated in
// order, reproduces the input exactly, and they cover it with no gap and no overlap.
function assertPartitions(text: string, segments: ReturnType<typeof segmentDocumentText>) {
  expect(segments.map((s) => s.text).join("")).toBe(text);
  let cursor = 0;
  for (const segment of segments) {
    expect(segment.start).toBe(cursor);
    expect(segment.end).toBeGreaterThan(segment.start);
    cursor = segment.end;
  }
  expect(cursor).toBe(text.length);
}

describe("segmentDocumentText", () => {
  it("no bound ranges: one segment, tone null, spanning the whole text", () => {
    const segments = segmentDocumentText(TEXT, []);
    expect(segments).toEqual([{ start: 0, end: TEXT.length, text: TEXT, findingIds: [], tone: null }]);
    assertPartitions(TEXT, segments);
  });

  it("empty text: no segments", () => {
    expect(segmentDocumentText("", [])).toEqual([]);
  });

  it("a single bound range in the middle: three segments, only the middle one toned", () => {
    const rent = entry("f1", 4, 8); // "rent"
    const segments = segmentDocumentText(TEXT, [rent]);
    assertPartitions(TEXT, segments);
    expect(segments.map((s) => ({ text: s.text, findingIds: s.findingIds, tone: s.tone }))).toEqual([
      { text: "The ", findingIds: [], tone: null },
      { text: "rent", findingIds: ["f1"], tone: "default" },
      { text: TEXT.slice(8), findingIds: [], tone: null },
    ]);
  });

  it("adjacent ranges (one ends exactly where the next begins) stay distinct segments", () => {
    const the = entry("f1", 0, 3); // "The"
    const rent = entry("f2", 4, 8); // "rent" (a space separates them, so this also covers the plain-gap case)
    const segments = segmentDocumentText(TEXT, [the, rent]);
    assertPartitions(TEXT, segments);
    expect(segments[0]).toMatchObject({ text: "The", findingIds: ["f1"] });
    expect(segments[1]).toMatchObject({ text: " ", findingIds: [] });
    expect(segments[2]).toMatchObject({ text: "rent", findingIds: ["f2"] });
  });

  it("overlapping ranges from two findings: the overlap segment lists both finding ids", () => {
    // "rent is" (4..11) and "is due" (9..15) overlap on "is" (9..11).
    const rentIs = entry("f1", 4, 11);
    const isDue = entry("f2", 9, 15);
    const segments = segmentDocumentText(TEXT, [rentIs, isDue]);
    assertPartitions(TEXT, segments);
    const overlap = segments.find((s) => s.start === 9 && s.end === 11)!;
    expect(overlap.findingIds.sort()).toEqual(["f1", "f2"]);
  });

  it("a nested range (one finding's quote fully inside another's) produces three sub-segments, the middle one covered by both", () => {
    const outer = entry("f1", 0, 20);
    const inner = entry("f2", 4, 8); // "rent", strictly inside f1's range
    const segments = segmentDocumentText(TEXT, [outer, inner]);
    assertPartitions(TEXT, segments);
    expect(segments.map((s) => ({ start: s.start, end: s.end, findingIds: s.findingIds.sort() }))).toEqual([
      { start: 0, end: 4, findingIds: ["f1"] },
      { start: 4, end: 8, findingIds: ["f1", "f2"] },
      { start: 8, end: 20, findingIds: ["f1"] },
      { start: 20, end: TEXT.length, findingIds: [] },
    ]);
  });

  it("mixed tone on an overlap renders the more conservative 'approximate', never a new hue", () => {
    const defaultRange = entry("f1", 4, 11, "default");
    const approximateRange = entry("f2", 9, 15, "approximate");
    const segments = segmentDocumentText(TEXT, [defaultRange, approximateRange]);
    const overlap = segments.find((s) => s.start === 9 && s.end === 11)!;
    expect(overlap.tone).toBe("approximate");
    const defaultOnly = segments.find((s) => s.start === 4 && s.end === 9)!;
    expect(defaultOnly.tone).toBe("default");
  });

  it("an entry whose slice doesn't match its own spanText (a forged or stale range bindSpan() itself would have refused) contributes nothing — defence in depth even though bindSpan() should already have filtered it out", () => {
    const forged: BoundEntry = { findingId: "f1", range: { spanStart: 4, spanEnd: 8, spanText: "WRONG" }, tone: "default" };
    const segments = segmentDocumentText(TEXT, [forged]);
    assertPartitions(TEXT, segments);
    expect(segments).toEqual([{ start: 0, end: TEXT.length, text: TEXT, findingIds: [], tone: null }]);
  });

  it("a forged entry sitting alongside a legitimate one: the legitimate one still segments correctly and the forged one contributes no boundary at all", () => {
    const rent = entry("f1", 4, 8); // "rent" — a genuine, slice-matching range
    const forged: BoundEntry = { findingId: "f2", range: { spanStart: 20, spanEnd: 25, spanText: "WRONG" }, tone: "default" };
    const segments = segmentDocumentText(TEXT, [rent, forged]);
    assertPartitions(TEXT, segments);
    expect(segments.some((s) => s.findingIds.includes("f2"))).toBe(false);
    expect(segments.find((s) => s.start === 4 && s.end === 8)).toMatchObject({ findingIds: ["f1"] });
  });

  it("a zero-width range (spanStart === spanEnd) contributes no segment of its own and does not break partitioning", () => {
    const zeroWidth: BoundEntry = { findingId: "f1", range: { spanStart: 5, spanEnd: 5, spanText: "" }, tone: "default" };
    const segments = segmentDocumentText(TEXT, [zeroWidth]);
    assertPartitions(TEXT, segments);
    expect(segments.some((s) => s.findingIds.includes("f1"))).toBe(false);
  });
});
