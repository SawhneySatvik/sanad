import { AppError } from "@/server/core/errors";
import { MAX_EXTRACTED_CHARS, MIN_NON_WHITESPACE_CHARS_PER_PAGE } from "./constants";
import { normalizeText } from "./normalize";
import { parseInWorker } from "./sandbox";

/** The outcome of {@link extractPdfPages}. */
export type PdfPagesResult =
  | { kind: "extracted"; normalizedPages: string[] }
  // Most pages have no usable text layer (scanned/image-only) — the whole document routes to
  // needs_native_document rather than extracting its few typed pages alone.
  | { kind: "needs_native_document" };

/**
 * Extracts a PDF's text page by page — parsed in a worker thread under a deadline and memory budget
 * (see sandbox.ts), normalized here — and decides between text and native-document handling.
 * @throws AppError EXTRACTION_FAILED when the PDF can't be parsed or has no pages.
 * @throws AppError INVALID_DOCUMENT when the page count or extracted character count exceeds its cap,
 * or the parse overruns its deadline or memory budget.
 */
export async function extractPdfPages(bytes: Uint8Array): Promise<PdfPagesResult> {
  const { pages } = await parseInWorker("pdf", bytes);

  const normalizedPages: string[] = [];
  let cumulativeChars = 0;
  let textlessPages = 0;
  for (const rawPageText of pages) {
    const normalizedPage = normalizeText(rawPageText);
    cumulativeChars += normalizedPage.length;
    if (cumulativeChars > MAX_EXTRACTED_CHARS) {
      throw new AppError(
        "INVALID_DOCUMENT",
        `Extracted text exceeds the ${MAX_EXTRACTED_CHARS}-character size cap.`,
        { reason: "too_large" },
      );
    }
    if (normalizedPage.replace(/\s/g, "").length < MIN_NON_WHITESPACE_CHARS_PER_PAGE) textlessPages++;
    normalizedPages.push(normalizedPage);
  }

  // Native only when text-less pages are a strict majority. In text mode the canonical text is
  // exactly the text layer and verify() checks against exactly that, so a signature, stamp or blank
  // page contributes just its little text; routing a typed lease with one such page to native would
  // cap every finding in it below verified. The trade: a lone scanned page inside a mostly-typed
  // document is left out of its canonical text.
  if (textlessPages * 2 > normalizedPages.length) return { kind: "needs_native_document" };
  return { kind: "extracted", normalizedPages };
}
