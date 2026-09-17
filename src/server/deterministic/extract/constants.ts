/**
 * Every size/count cap the extract/ module enforces, in one place, so its files check the same
 * numbers instead of drifting apart.
 */

/**
 * Bump whenever extraction/normalization logic changes in a way that could produce a different
 * canonical text for the same input bytes. Stored on each document row: a bump never re-extracts
 * existing rows, which keep the canonical text their spans were verified against.
 */
export const EXTRACTOR_VERSION = "1.2.0";

/**
 * Raw upload byte cap, checked before any parsing work runs — generous for a real document, but
 * bounds CPU cost from a pathological upload. Rejected with INVALID_DOCUMENT, never truncated.
 */
export const MAX_INPUT_BYTES = 15 * 1024 * 1024;

/**
 * Cap on extracted text length, checked before normalization and again on the final joined
 * canonical text — bounds LLM prompt size and verify()'s cost. Rejected with INVALID_DOCUMENT.
 */
export const MAX_EXTRACTED_CHARS = 500_000;

/**
 * Below this many non-whitespace characters, a PDF page counts as having no usable text layer
 * (scanned/image-only, or a signature or stamp page). Classified per page, so one dense cover page
 * can't average blank pages away; pdf.ts routes the whole document to native-document handling only
 * when most of its pages are text-less. Set above a scanner stamp's typical length — a genuinely
 * short one-page document under it is indistinguishable from a stamp, an accepted limitation.
 */
export const MIN_NON_WHITESPACE_CHARS_PER_PAGE = 200;

/**
 * Hard cap on PDF page count, checked against `pdf.numPages` before any page's content is
 * fetched — cheap even against a malicious file, since page count resolves from the xref/trailer
 * alone. A page-count bomb (thousands of /Page objects sharing one tiny /Contents stream) stays
 * small in bytes, so this cap is what rejects it before any per-page work runs.
 */
export const MAX_PDF_PAGES = 500;

/**
 * Hard cap on a DOCX's true decompressed size, summed across every zip entry — see docx-guard.ts
 * for why the claimed size can't be trusted.
 */
export const MAX_DOCX_DECOMPRESSED_BYTES = 50 * 1024 * 1024;

/**
 * Unicode's own mitigation for combining-mark reordering blowup — rejected before NFC
 * normalization, which is near-quadratic on a long combining-mark run.
 */
export const MAX_COMBINING_MARK_RUN = 30;

/**
 * In-worker cap on raw, pre-normalization text: bounds the parse's memory and the result posted
 * back to the main thread. Twice MAX_EXTRACTED_CHARS because raw PDF text carries whitespace that
 * normalization collapses — the exact MAX_EXTRACTED_CHARS check on the normalized text stays the
 * only acceptance rule.
 */
export const MAX_RAW_EXTRACTED_CHARS = 2 * MAX_EXTRACTED_CHARS;

/**
 * Budget for one PDF/DOCX parse in its worker thread; a breach terminates the worker. Measured
 * heaviest legitimate inputs: a 500k-character DOCX with Word-style per-run formatting (10.5 MB
 * document.xml) peaks at ~380 MB heap in ~1 s; a 15 MB 400-page PDF at ~45 MB heap and ~40 MB of
 * buffers in under 1 s; a 267-page PDF with an embedded TrueType font takes 2 s of CPU. External
 * (ArrayBuffer) memory needs its own cap: V8's heap limits don't count it, and pdf.js decodes a
 * compressed font or content stream into one growing buffer — a 1 MB PDF reached 1.3 GB that way.
 * 128 MB still passes a page whose vector-drawing content stream decodes to 40 MB and a fully
 * embedded 23 MB font; a single stream decoding to 64 MB is refused.
 */
export const EXTRACTION_WORKER_LIMITS = {
  // How long the worker may take to load its parser code and report ready; past it, the worker never
  // started (worker_crash, retryable). Generous: startup is not the document's cost, and several
  // busy processes on one machine stretched it past a second in tests.
  startupTimeoutMs: 15_000,
  // The parse's own budget, counted from ready, so a slow startup never eats into it.
  deadlineMs: 20_000,
  maxOldGenerationSizeMb: 512,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
  maxExternalMemoryMb: 128,
};

/**
 * Worker parses allowed at once per process, so the process's worst case is this many worker
 * budgets rather than one per concurrent upload; further parses wait for a free slot.
 */
export const MAX_CONCURRENT_EXTRACTIONS = 2;
