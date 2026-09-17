import { createHash } from "node:crypto";
import { AppError } from "@/server/core/errors";
import { EXTRACTOR_VERSION, MAX_EXTRACTED_CHARS, MAX_INPUT_BYTES } from "./constants";
import { extractDocxText } from "./docx";
import { normalizeText } from "./normalize";
import { extractPdfPages } from "./pdf";

/**
 * Extracts a document's canonical text from PDF/DOCX/plain-text bytes or pasted text — the entry
 * point for extract/.
 */

export { normalizeText } from "./normalize";
export { ExtractionAbortedError, type ExtractionAbortReason } from "./sandbox";
export { EXTRACTOR_VERSION, MAX_EXTRACTED_CHARS, MAX_INPUT_BYTES } from "./constants";
export {
  MAX_COMBINING_MARK_RUN,
  MAX_DOCX_DECOMPRESSED_BYTES,
  MAX_PDF_PAGES,
  MIN_NON_WHITESPACE_CHARS_PER_PAGE,
} from "./constants";

type SniffedFormat = "pdf" | "zip" | "other";

// What each supported declared type must sniff as; a DOCX's zip is confirmed to hold
// word/document.xml by docx-guard.ts, and plain text must also decode as UTF-8.
const FORMAT_BY_MIME_TYPE = new Map<string, SniffedFormat>([
  ["application/pdf", "pdf"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "zip"],
  ["text/plain", "other"],
]);

// PDF readers accept the header anywhere in the first KiB, and some producers prepend a few bytes.
const PDF_HEADER_WINDOW_BYTES = 1024;

/** A document to extract: raw bytes with a declared MIME type, or already-plain-text pasted input. */
export type ExtractInput = { bytes: Uint8Array; mimeType: string } | { pastedText: string };

/** The outcome of {@link extractDocument}. */
export type ExtractionResult =
  | {
      kind: "extracted";
      canonicalText: string;
      canonicalTextHash: string;
      extractorVersion: string;
      inputMode: "text";
      // Character offsets into canonicalText where each PDF page begins. Empty for DOCX/pasted-text
      // input (no page concept).
      pageAnchors: number[];
    }
  // A PDF most of whose pages have no usable text layer (scanned/image-only) — the caller routes this
  // to a multimodal transcription path instead of treating it as extracted text. Never an
  // empty/garbage canonicalText: a document must either extract to real text, or be flagged for that
  // path.
  | { kind: "needs_native_document" };

/**
 * Extracts and normalizes a document's text, or reports that it needs native-document (image/scan)
 * handling instead. The parser is picked by the file's own bytes, never by the declared type alone.
 * @throws AppError INVALID_DOCUMENT for an oversized, empty, or unsupported-type input, one whose
 * content doesn't match its declared type, or a parse that overran its deadline or memory budget
 * (an {@link ExtractionAbortedError}).
 * @throws AppError EXTRACTION_FAILED when the PDF or DOCX parser can't read the file, or its worker
 * thread dies (an {@link ExtractionAbortedError}).
 */
export async function extractDocument(input: ExtractInput): Promise<ExtractionResult> {
  if ("pastedText" in input) return extractText(input.pastedText);

  if (input.bytes.byteLength > MAX_INPUT_BYTES) {
    throw new AppError(
      "INVALID_DOCUMENT",
      `Document exceeds the ${MAX_INPUT_BYTES}-byte size cap.`,
      { reason: "too_large" },
    );
  }

  const expectedFormat = FORMAT_BY_MIME_TYPE.get(input.mimeType);
  if (expectedFormat === undefined) {
    throw new AppError("INVALID_DOCUMENT", `Unsupported document type: ${input.mimeType}`, { reason: "unsupported_type" });
  }
  if (sniffFormat(input.bytes) !== expectedFormat) {
    throw new AppError(
      "INVALID_DOCUMENT",
      `The file's content does not match its declared type ${input.mimeType}.`,
      { reason: "type_mismatch" },
    );
  }

  if (expectedFormat === "pdf") return extractFromPdf(input.bytes);
  if (expectedFormat === "zip") return finalizeText(normalizeText(await extractDocxText(input.bytes)), []);
  return extractText(decodeUtf8(input.bytes));
}

function sniffFormat(bytes: Uint8Array): SniffedFormat {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) return "zip"; // "PK\x03\x04"
  if (buffer.subarray(0, PDF_HEADER_WINDOW_BYTES).includes("%PDF-")) return "pdf";
  return "other";
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new AppError("INVALID_DOCUMENT", "The text file is not valid UTF-8.", { reason: "unreadable" });
  }
}

function extractText(text: string): ExtractionResult {
  // Cheap cap before any normalization work; normalizeText() also guards its own input length,
  // but checking here keeps the rejection reason specific.
  if (text.length > MAX_EXTRACTED_CHARS) {
    throw new AppError(
      "INVALID_DOCUMENT",
      `Pasted text exceeds the ${MAX_EXTRACTED_CHARS}-character size cap.`,
      { reason: "too_large" },
    );
  }
  return finalizeText(normalizeText(text), []);
}

async function extractFromPdf(bytes: Uint8Array): Promise<ExtractionResult> {
  const pagesResult = await extractPdfPages(bytes);
  if (pagesResult.kind === "needs_native_document") {
    return { kind: "needs_native_document" };
  }

  const { joined, pageAnchors } = joinNormalizedPages(pagesResult.normalizedPages);
  return finalizeText(joined, pageAnchors);
}

/**
 * Joins already-normalized pages with a "\n\n" separator between any two pages that both have
 * content, and records where each page begins. A text-mode PDF can contain blank pages (a signature
 * or e-stamp page — pdf.ts goes native only when most pages are text-less); skipping the separator
 * around one keeps the joined result already in normalized form, so a later normalizeText() pass
 * can't shift it and desync pageAnchors from what verify() matches against.
 */
export function joinNormalizedPages(pages: string[]): { joined: string; pageAnchors: number[] } {
  const pageAnchors: number[] = [];
  let joined = "";
  for (const pageText of pages) {
    if (joined.length > 0 && pageText.length > 0) joined += "\n\n";
    pageAnchors.push(joined.length);
    joined += pageText;
  }
  return { joined, pageAnchors };
}

function finalizeText(canonicalText: string, pageAnchors: number[]): ExtractionResult {
  if (canonicalText.length === 0) {
    throw new AppError("INVALID_DOCUMENT", "Document contains no extractable text.", { reason: "empty" });
  }
  if (canonicalText.length > MAX_EXTRACTED_CHARS) {
    throw new AppError(
      "INVALID_DOCUMENT",
      `Extracted text exceeds the ${MAX_EXTRACTED_CHARS}-character size cap.`,
      { reason: "too_large" },
    );
  }
  return {
    kind: "extracted",
    canonicalText,
    canonicalTextHash: createHash("sha256").update(canonicalText, "utf8").digest("hex"),
    extractorVersion: EXTRACTOR_VERSION,
    inputMode: "text",
    pageAnchors,
  };
}
