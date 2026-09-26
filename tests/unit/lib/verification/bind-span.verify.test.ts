// @vitest-environment jsdom
//
// bindSpan() is the one place a span binds to text anywhere in the client. Every negative case here
// is a forged/stale/foreign input that must suppress the mark, never render it.
// The last case renders the real pipeline end to end (bindSpan -> segmentDocumentText ->
// DocumentViewer) rather than just re-asserting the offsets bindSpan already returned, hence the
// jsdom environment override on this one .ts file — no JSX needed, so it stays a .ts file.

import { createElement } from "react";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { bindSpan, type BindSpanTarget } from "@/lib/verification/bindSpan";
import { segmentDocumentText } from "@/lib/verification/segmentDocumentText";
import { LiveRegionProvider } from "@/components/layout-primitives/live-region";
import { DocumentViewer } from "@/components/document/document-viewer";
import type { VerificationOutput } from "@/shared/contracts/common";

const DOC_A = "abc";
const DOC_B = "xyz";

function target(overrides: Partial<BindSpanTarget> = {}): BindSpanTarget {
  return { documentId: "doc-a", text: "The rent is due on the first of every month.", textHash: "hash-a", ...overrides };
}

function verified(overrides: Partial<Extract<VerificationOutput, { status: "verified" }>> = {}): VerificationOutput {
  return {
    status: "verified",
    spanStart: 4,
    spanEnd: 12,
    spanText: "rent is ",
    verifierVersion: "v1",
    textHash: "hash-a",
    ...overrides,
  };
}

describe("bindSpan", () => {
  it("positive: a matching verification against its own document binds the exact range", () => {
    const result = bindSpan(verified(), target(), { documentId: "doc-a" });
    expect(result).toEqual({ spanStart: 4, spanEnd: 12, spanText: "rent is " });
  });

  it("negative: not_found carries no span, so it never binds — status has no span to bind", () => {
    const verification: VerificationOutput = {
      status: "not_found",
      spanStart: null,
      spanEnd: null,
      spanText: null,
      claimedQuote: "a fabricated quote",
      verifierVersion: "v1",
      textHash: "hash-a",
    };
    expect(bindSpan(verification, target(), { documentId: "doc-a" })).toBeNull();
  });

  it("negative: a not_found status is refused even when every other field would otherwise pass — the schema never lets this shape through in typed code, but the runtime check must not rely on that alone", () => {
    // Every field here — hash, offsets, slice — matches target()/verified()'s own defaults exactly;
    // only the status disagrees. Deleting the not_found guard alone (leaving every other check
    // untouched) would bind this and render a mark, since nothing else here is wrong.
    const malformed = {
      status: "not_found",
      spanStart: 4,
      spanEnd: 12,
      spanText: "rent is ",
      claimedQuote: "a fabricated quote",
      verifierVersion: "v1",
      textHash: "hash-a",
    } as unknown as VerificationOutput;
    expect(bindSpan(malformed, target(), { documentId: "doc-a" })).toBeNull();
  });

  it("negative: a stale hash (one character off) suppresses the mark", () => {
    const stale = verified({ textHash: "hash-a-stale" });
    expect(bindSpan(stale, target({ textHash: "hash-a" }), { documentId: "doc-a" })).toBeNull();
  });

  it("negative: a matching hash with a mismatched slice suppresses the mark", () => {
    // Same hash, same document — but the offsets no longer slice back to spanText (the document
    // text changed underneath a stale span, or the span was simply forged).
    const mismatched = verified({ spanStart: 0, spanEnd: 8, spanText: "rent is " });
    expect(bindSpan(mismatched, target(), { documentId: "doc-a" })).toBeNull();
  });

  it("negative: a wrong-document pairing suppresses the mark, even with an identical hash — two documents can share byte-identical text", () => {
    const verification = verified({ textHash: "shared-hash" });
    const wrongDocTarget = target({ documentId: "doc-b", textHash: "shared-hash" });
    // expected.documentId ("doc-a") does not match the target's own documentId ("doc-b").
    expect(bindSpan(verification, wrongDocTarget, { documentId: "doc-a" })).toBeNull();
  });

  it("positive: two documents sharing identical text and hash still bind correctly when the ids agree", () => {
    const sharedText = "Both documents happen to say exactly this.";
    const verification = verified({ textHash: "shared-hash", spanStart: 0, spanEnd: 4, spanText: "Both" });
    const result = bindSpan(verification, target({ documentId: "doc-b", text: sharedText, textHash: "shared-hash" }), { documentId: "doc-b" });
    expect(result).toEqual({ spanStart: 0, spanEnd: 4, spanText: "Both" });
  });

  it("negative: an out-of-range spanEnd is suppressed rather than silently clamped by String.slice", () => {
    // Without an explicit bounds check, `"abc".slice(0, 999)` still equals a padded spanText only if
    // spanText itself was truncated to fit — here spanText claims 6 chars past a 3-char document, a
    // slice that .slice() alone would clamp to "abc" and (if spanText also happened to be "abc")
    // would wrongly pass. Asserting spanEnd stays in range closes that gap independently of spanText.
    const verification = verified({ spanStart: 0, spanEnd: 999, spanText: DOC_A, textHash: "hash-short" });
    expect(bindSpan(verification, target({ text: DOC_A, textHash: "hash-short" }), { documentId: "doc-a" })).toBeNull();
  });

  it("negative: spanEnd <= spanStart (a zero-width or inverted span) is suppressed", () => {
    const verification = verified({ spanStart: 4, spanEnd: 4, spanText: "", textHash: "hash-a" });
    expect(bindSpan(verification, target(), { documentId: "doc-a" })).toBeNull();
  });

  it("negative: a negative spanStart is suppressed, even though String.slice's own negative-index wraparound would otherwise slice back to the exact spanText — only the explicit spanStart < 0 guard catches this, since the mismatched-slice check alone would not", () => {
    // "xyz".slice(-1, 3) is "z" (a negative start counts from the end) — spanText is set to that
    // same "z" on purpose, so the slice-equality check would incorrectly agree with a spanStart < 0
    // guard that had been deleted; this fixture only fails because of that guard.
    const verification = verified({ spanStart: -1, spanEnd: 3, spanText: "z" });
    expect(bindSpan(verification, target({ text: DOC_B, textHash: "hash-a" }), { documentId: "doc-a" })).toBeNull();
  });

  it("negative: a fractional spanStart is suppressed — String.slice truncates a non-integer index toward zero, so the mismatched-slice check alone would not catch this", () => {
    // target().text.slice(4.5, 12) truncates to slice(4, 12), which is exactly "rent is " —
    // the same default spanText verified() already carries — so only Number.isInteger(spanStart)
    // rejects this fixture.
    const verification = verified({ spanStart: 4.5, spanEnd: 12 });
    expect(bindSpan(verification, target(), { documentId: "doc-a" })).toBeNull();
  });

  it("negative: a fractional spanEnd is suppressed — same truncation trick, on the other offset", () => {
    // target().text.slice(4, 12.5) truncates to slice(4, 12), again "rent is ".
    const verification = verified({ spanStart: 4, spanEnd: 12.5 });
    expect(bindSpan(verification, target(), { documentId: "doc-a" })).toBeNull();
  });

  it("a matched mark's textContent equals spanText exactly, through the real render pipeline (bindSpan -> segmentDocumentText -> DocumentViewer) — not merely re-asserting the offsets bindSpan itself returned", () => {
    // A spanText with a run of internal whitespace and a line break, so an off-by-one slice
    // (caught below) or a whitespace-collapsing render bug would both show up as a mismatch.
    const t = target({ text: "Rent:\n  the   rent is due on the first of every month." });
    const spanText = "the   rent is due";
    const spanStart = t.text.indexOf(spanText);
    const spanEnd = spanStart + spanText.length;
    const verification = verified({ spanStart, spanEnd, spanText });

    const bound = bindSpan(verification, t, { documentId: "doc-a" });
    expect(bound).not.toBeNull();

    const jump = { findingId: "f1", seq: 1, announcement: "x", returnFocusTo: null };
    const segments = segmentDocumentText(t.text, [{ findingId: "f1", range: bound!, tone: "default" as const }]);
    const { container } = render(
      createElement(LiveRegionProvider, null, createElement(DocumentViewer, { documentId: "doc-a", inputMode: "text", segments, jump })),
    );

    const mark = container.querySelector("mark");
    expect(mark).not.toBeNull();
    expect(mark!.textContent).toBe(spanText);
  });
});
