import { describe, expect, it } from "vitest";
import { MAX_EXTRACTED_CHARS, MAX_PDF_PAGES, MIN_NON_WHITESPACE_CHARS_PER_PAGE } from "@/server/deterministic/extract/constants";
import { extractDocument } from "@/server/deterministic/extract/index";
import { buildManyPagePdf, buildMixedPagesPdf, buildTextPdf } from "@tests/support/builders/pdf";

// A one-line notice ("Notice: rent due.") is ~15 non-whitespace characters —
// far too short to clear MIN_NON_WHITESPACE_CHARS_PER_PAGE (200) on its own,
// and indistinguishable from a scanner stamp under this heuristic. This
// helper builds text comfortably ABOVE the threshold, for tests that need a
// genuinely realistic (not artificially tiny) short document.
function realShortNoticeText(): string {
  return (
    "This is a short one-page legal notice. It informs the recipient that rent " +
    "for the current month remains unpaid as of the date below, and requests " +
    "prompt settlement within seven days to avoid further action. Failure to " +
    "comply may result in additional legal steps being taken."
  );
}

describe("PDF page-count bomb", () => {
  it("rejects a PDF over MAX_PDF_PAGES with INVALID_DOCUMENT, quickly and without OOM", async () => {
    // Thousands of /Page objects sharing ONE tiny content stream — the file
    // itself stays well under a megabyte, so the byte cap alone would not
    // catch this; only the page-count check does.
    const bombBytes = buildManyPagePdf(6000, "Hi");
    expect(bombBytes.length).toBeLessThan(2 * 1024 * 1024);

    const t0 = Date.now();
    await expect(
      extractDocument({ bytes: bombBytes, mimeType: "application/pdf" }),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT", reason: "too_large" });
    const elapsedMs = Date.now() - t0;

    // Stated bound: rejecting a 6000-page bomb must be fast — pdf.numPages resolves from the
    // xref/trailer alone, before any page's content is touched. Far below what "extract every page
    // first, then notice the count" would cost: measured at 11s+ for a similarly-shaped file. The
    // wall clock also covers starting the parse worker, which a loaded machine stretches past 2 s.
    expect(elapsedMs).toBeLessThan(5000);
  });

  it("accepts a PDF at exactly MAX_PDF_PAGES pages (each with real, distinct content clearing the per-page threshold)", async () => {
    const pages = Array.from(
      { length: MAX_PDF_PAGES },
      (_, i) =>
        `Page number ${i + 1} of this document. ${realShortNoticeText()}`,
    );
    const bytes = buildTextPdf(pages);
    const result = await extractDocument({ bytes, mimeType: "application/pdf" });
    expect(result.kind).toBe("extracted");
  });
});

describe("PDF running character budget during extraction", () => {
  it("aborts with INVALID_DOCUMENT during extraction once the cumulative character budget is exceeded, without buffering the whole document first", async () => {
    // Stays under MAX_PDF_PAGES, but the running total crosses MAX_EXTRACTED_CHARS before the last
    // page — the page-count cap alone does not catch this. The per-page estimate below (3,000) is
    // well under the ~4,000 characters build-test-pdf.ts's content stream actually fits per page.
    const chunk = "Real prose content repeated to build up the character budget. ".repeat(200);
    const CONSERVATIVE_CHARS_EXTRACTED_PER_PAGE = 3000;
    const pagesNeeded = Math.ceil((MAX_EXTRACTED_CHARS * 1.1) / CONSERVATIVE_CHARS_EXTRACTED_PER_PAGE);
    expect(pagesNeeded).toBeLessThan(MAX_PDF_PAGES);
    const bytes = buildTextPdf(Array.from({ length: pagesNeeded }, () => chunk));

    const t0 = Date.now();
    await expect(
      extractDocument({ bytes, mimeType: "application/pdf" }),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT", reason: "too_large" });
    const elapsedMs = Date.now() - t0;
    // Generous bound: ~180 sequential page-fetches worth of real pdf.js overhead, but "bounded and
    // nowhere near an unguarded failure mode" — measured at 11s+ for an input that buffers every
    // page before checking the total.
    expect(elapsedMs).toBeLessThan(10_000);
  });
});

describe("PDF native-document routing: a document goes native only when most of its pages lack a text layer", () => {
  it("a single image page with only a short scanner-stamp-length text layer routes to needs_native_document, never treats the stamp as the whole document", async () => {
    const stampBytes = buildMixedPagesPdf([{ kind: "text", text: "Scanned with CamScanner" }]);
    const result = await extractDocument({ bytes: stampBytes, mimeType: "application/pdf" });
    expect(result.kind).toBe("needs_native_document");
  });

  it("a typed cover page followed by image-only pages routes the WHOLE document to needs_native_document — the image pages are never silently dropped", async () => {
    // The cover page's content is deliberately STRONG (4x repeated) so a whole-document AVERAGE
    // would clear the per-page threshold and misclassify this as real text — the per-page check
    // must catch each blank image page on its own, regardless of how strong the cover page is.
    const strongCoverText = Array.from({ length: 4 }, () => realShortNoticeText()).join(" ");
    expect(strongCoverText.replace(/\s/g, "").length).toBeGreaterThan(
      MIN_NON_WHITESPACE_CHARS_PER_PAGE * 4,
    );

    const mixedBytes = buildMixedPagesPdf([
      { kind: "text", text: strongCoverText },
      { kind: "image" },
      { kind: "image" },
      { kind: "image" },
    ]);
    const result = await extractDocument({ bytes: mixedBytes, mimeType: "application/pdf" });
    expect(result.kind).toBe("needs_native_document");
  });

  it("a mostly-scanned document routes to needs_native_document wherever its typed page sits", async () => {
    for (const pages of [
      [{ kind: "image" as const }, { kind: "image" as const }, { kind: "text" as const, text: realShortNoticeText() }],
      [{ kind: "image" as const }, { kind: "text" as const, text: realShortNoticeText() }, { kind: "image" as const }],
    ]) {
      const result = await extractDocument({ bytes: buildMixedPagesPdf(pages), mimeType: "application/pdf" });
      expect(result.kind).toBe("needs_native_document");
    }
  });

  it("a text lease whose last page is a scanned signature stays in text mode, with every typed page's text", async () => {
    const bytes = buildMixedPagesPdf([
      { kind: "text", text: `Clause one. ${realShortNoticeText()}` },
      { kind: "text", text: `Clause two. ${realShortNoticeText()}` },
      { kind: "text", text: `Clause three. ${realShortNoticeText()}` },
      { kind: "image" },
    ]);
    const result = await extractDocument({ bytes, mimeType: "application/pdf" });
    expect(result.kind).toBe("extracted");
    if (result.kind !== "extracted") throw new Error("unreachable");
    expect(result.inputMode).toBe("text");
    for (const clause of ["Clause one.", "Clause two.", "Clause three."]) {
      expect(result.canonicalText).toContain(clause);
    }
    expect(result.pageAnchors).toHaveLength(4);
  });

  it("a text lease with a near-empty typed signature page stays in text mode, keeping that page's text too", async () => {
    const signaturePage = "Signed by the Licensor and the Licensee.";
    expect(signaturePage.replace(/\s/g, "").length).toBeLessThan(MIN_NON_WHITESPACE_CHARS_PER_PAGE);

    const bytes = buildTextPdf([`Clause one. ${realShortNoticeText()}`, signaturePage]);
    const result = await extractDocument({ bytes, mimeType: "application/pdf" });
    expect(result.kind).toBe("extracted");
    if (result.kind !== "extracted") throw new Error("unreachable");
    expect(result.canonicalText.endsWith(signaturePage)).toBe(true);
    expect(result.canonicalText.slice(result.pageAnchors[1])).toBe(signaturePage);
  });

  it("exactly half the pages text-less is not a majority — the document stays in text mode", async () => {
    const result = await extractDocument({
      bytes: buildMixedPagesPdf([{ kind: "image" }, { kind: "text", text: realShortNoticeText() }]),
      mimeType: "application/pdf",
    });
    expect(result.kind).toBe("extracted");
  });

  it("a genuinely short but REAL single-page text document (just over the per-page threshold) still extracts as text", async () => {
    const text = realShortNoticeText();
    expect(text.replace(/\s/g, "").length).toBeGreaterThan(MIN_NON_WHITESPACE_CHARS_PER_PAGE);

    const bytes = buildTextPdf([text]);
    const result = await extractDocument({ bytes, mimeType: "application/pdf" });
    expect(result.kind).toBe("extracted");
    if (result.kind === "extracted") {
      expect(result.canonicalText).toContain("rent");
    }
  });

  it("KNOWN, STATED LIMITATION: an artificially tiny real document (well under the threshold) is indistinguishable from a scanner stamp and is misclassified — this is documented, not silently promised away", async () => {
    const tinyRealNotice = "Notice: rent due.";
    expect(tinyRealNotice.replace(/\s/g, "").length).toBeLessThan(MIN_NON_WHITESPACE_CHARS_PER_PAGE);

    const bytes = buildTextPdf([tinyRealNotice]);
    const result = await extractDocument({ bytes, mimeType: "application/pdf" });
    // Documented limitation, not a bug: this heuristic cannot tell a bare
    // one-line note apart from a scanner stamp. Real target documents in
    // this app are never realistically this short (see constants.ts).
    expect(result.kind).toBe("needs_native_document");
  });
});
