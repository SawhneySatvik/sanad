import { parentPort, workerData } from "node:worker_threads";
import mammoth from "mammoth";
import { getDocumentProxy } from "unpdf";

/**
 * Worker-thread entry that runs the third-party PDF (pdf.js, via unpdf) and DOCX (mammoth) parsers,
 * so a hostile file can exhaust only this thread's budget — sandbox.ts sets the limits and the
 * deadline and terminates the thread. Node runs this file unbundled (type-stripped) under vitest and
 * tsx, so it imports only `node:` builtins and packages — never an `@/` alias, an extensionless
 * relative path or AppError; a rejection travels back as a plain message. `.mts` so Node loads it as
 * an ES module outright; the package has no "type" field.
 */

/** A parse request, passed as workerData. */
export interface ExtractionWorkerRequest {
  format: "pdf" | "docx";
  bytes: Uint8Array;
  maxPdfPages: number;
  maxRawChars: number;
}

// This file never imports AppError (see the module doc above), so it mirrors the two reason values
// its own rejections ever need as plain string literals rather than importing errors.ts's ErrorReason
// — structurally the same values, kept in sync by sandbox.ts's mapping tests.
type WorkerRejectReason = "too_large" | "unreadable";

/** The parse's one result: raw, unnormalized text, or why the parse was refused. */
export type ExtractionWorkerResponse =
  | { kind: "pdf"; pages: string[] }
  | { kind: "docx"; text: string }
  | { kind: "rejected"; code: "INVALID_DOCUMENT" | "EXTRACTION_FAILED"; message: string; reason: WorkerRejectReason };

/**
 * Every message the worker posts: "ready" once its parser code has loaded, then — after the sandbox
 * answers with any message — the result.
 */
export type ExtractionWorkerMessage = { kind: "ready" } | ExtractionWorkerResponse;

// Derived from getDocumentProxy's own return type rather than unpdf's internal (unexported) paths —
// stays correct across an unpdf version bump.
type PdfProxy = Awaited<ReturnType<typeof getDocumentProxy>>;
type PdfTextContent = Awaited<ReturnType<Awaited<ReturnType<PdfProxy["getPage"]>>["getTextContent"]>>;

function rejected(code: "INVALID_DOCUMENT" | "EXTRACTION_FAILED", message: string, reason: WorkerRejectReason): ExtractionWorkerResponse {
  return { kind: "rejected", code, message, reason };
}

// Page by page, never unpdf's extractText(), which runs every page at once.
async function extractPdfPages({
  bytes,
  maxPdfPages,
  maxRawChars,
}: ExtractionWorkerRequest): Promise<ExtractionWorkerResponse> {
  let pdf: PdfProxy;
  try {
    pdf = await getDocumentProxy(bytes, { verbosity: 0 });
  } catch {
    return rejected("EXTRACTION_FAILED", "The PDF could not be parsed.", "unreadable");
  }
  // numPages resolves from the xref/trailer alone, so a page-count bomb is refused before any page
  // content is read.
  if (pdf.numPages === 0) return rejected("EXTRACTION_FAILED", "The PDF has no pages.", "unreadable");
  if (pdf.numPages > maxPdfPages) {
    return rejected("INVALID_DOCUMENT", `Document exceeds the ${maxPdfPages}-page cap.`, "too_large");
  }

  const pages: string[] = [];
  let rawChars = 0;
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      // Streamed, not getTextContent(): the cap below is checked per chunk, so a page packed with
      // text stops being read as soon as the running total trips it; the main thread then
      // terminates this worker, pdf.js included.
      const reader = page.streamTextContent().getReader();
      let pageText = "";
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        for (const item of (chunk.value as PdfTextContent).items) {
          if ("str" in item && item.str != null) pageText += item.hasEOL ? `${item.str}\n` : item.str;
        }
        if (rawChars + pageText.length > maxRawChars) {
          return rejected("INVALID_DOCUMENT", `Extracted text exceeds the ${maxRawChars}-character raw cap.`, "too_large");
        }
      }
      rawChars += pageText.length;
      pages.push(pageText);
    }
  } catch {
    return rejected("EXTRACTION_FAILED", "The PDF could not be parsed.", "unreadable");
  }
  return { kind: "pdf", pages };
}

async function extractDocxText({
  bytes,
  maxRawChars,
}: ExtractionWorkerRequest): Promise<ExtractionWorkerResponse> {
  let text: string;
  try {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    text = (await mammoth.extractRawText({ buffer })).value;
  } catch {
    return rejected("EXTRACTION_FAILED", "The DOCX file could not be parsed.", "unreadable");
  }
  // Checked before posting: an oversized string would otherwise be copied onto the main thread.
  if (text.length > maxRawChars) {
    return rejected("INVALID_DOCUMENT", `Extracted text exceeds the ${maxRawChars}-character raw cap.`, "too_large");
  }
  return { kind: "docx", text };
}

const request = workerData as ExtractionWorkerRequest;
// The parsers are loaded by now (static imports run first). The document is touched only once the
// sandbox answers, which it does after it has seen ready — so any failure it sees afterwards is
// ordered after ready, never racing it.
parentPort?.postMessage({ kind: "ready" } satisfies ExtractionWorkerMessage);
parentPort?.once("message", () => {
  void (request.format === "pdf" ? extractPdfPages(request) : extractDocxText(request)).then((response) =>
    parentPort?.postMessage(response),
  );
});
