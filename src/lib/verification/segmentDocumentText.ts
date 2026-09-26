/**
 * The rendering-only helper downstream of bindSpan(). Cuts a document's text at every distinct
 * boundary among a set of already-bound ranges — it never re-derives a span itself, only slices at
 * boundaries bindSpan() already decided were real. A segment covered by findings of mixed tone
 * renders "approximate", the more conservative of the two: a shape/underline-style distinction, not
 * a new colour, since the palette treats "approximate" as its own hue already.
 *
 * `Segment.text` carries the segment's own slice of the document text, not just its offsets — a
 * renderer needs the literal characters to draw, and re-deriving them from offsets at render time
 * would mean quietly re-slicing the document text a second time outside bindSpan()'s own result.
 */

export interface BoundEntry {
  findingId: string;
  range: { spanStart: number; spanEnd: number; spanText: string };
  tone: "default" | "approximate";
}

export interface Segment {
  start: number;
  end: number;
  text: string;
  findingIds: string[];
  tone: "default" | "approximate" | null;
}

export function segmentDocumentText(text: string, bound: BoundEntry[]): Segment[] {
  // Defence in depth: bindSpan() is the one place a span is supposed to have already been checked
  // against this exact text, but this function's own contract is "boundaries bindSpan() already
  // decided were real" — it never re-derives a span itself, so a forged or stale entry that slipped
  // past bindSpan() (a second caller building BoundEntry by hand, a future bindSpan() bug) still
  // never turns into a rendered mark here.
  const trusted = bound.filter((entry) => text.slice(entry.range.spanStart, entry.range.spanEnd) === entry.range.spanText);

  const boundaries = new Set<number>([0, text.length]);
  for (const { range } of trusted) {
    boundaries.add(range.spanStart);
    boundaries.add(range.spanEnd);
  }
  const sorted = [...boundaries].sort((a, b) => a - b);

  const segments: Segment[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    if (start === end) continue; // two boundaries can coincide (adjacent/zero-width ranges) — nothing to segment between them

    const covering = trusted.filter((entry) => entry.range.spanStart <= start && entry.range.spanEnd >= end);
    const findingIds = covering.map((entry) => entry.findingId);
    const tone: Segment["tone"] = covering.length === 0 ? null : covering.some((entry) => entry.tone === "approximate") ? "approximate" : "default";

    segments.push({ start, end, text: text.slice(start, end), findingIds, tone });
  }
  return segments;
}
