import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AppError } from "@/server/core/errors";
import {
  EXTRACTOR_VERSION,
  MAX_EXTRACTED_CHARS,
  MAX_INPUT_BYTES,
  extractDocument,
  joinNormalizedPages,
} from "@/server/deterministic/extract/index";
import { normalizeText } from "@/server/deterministic/extract/normalize";
import { buildZip } from "@tests/support/builders/zip";

const FIXTURES_DIR = join(process.cwd(), "tests", "fixtures", "documents");

function loadFixture(name: string): Buffer {
  return readFileSync(join(FIXTURES_DIR, name));
}

describe("extractDocument — PDF", () => {
  it("extracts known content from a real multi-page PDF, with page anchors", async () => {
    const bytes = loadFixture("leave_and_license.pdf");
    const result = await extractDocument({ bytes, mimeType: "application/pdf" });

    expect(result.kind).toBe("extracted");
    if (result.kind !== "extracted") throw new Error("unreachable");
    expect(result.canonicalText).toContain("Licensor");
    expect(result.canonicalText).toContain("security deposit");
    expect(result.inputMode).toBe("text");
    expect(result.extractorVersion).toBe(EXTRACTOR_VERSION);
    expect(result.canonicalTextHash).toMatch(/^[0-9a-f]{64}$/);
    // The fixture is 2 pages — one anchor per page, first at offset 0, and
    // the second page's anchor is preceded by exactly the "\n\n" page
    // separator (not just "greater than 0", which would pass even if the
    // separator were malformed).
    expect(result.pageAnchors.length).toBe(2);
    expect(result.pageAnchors[0]).toBe(0);
    const secondAnchor = result.pageAnchors[1];
    expect(secondAnchor).toBeGreaterThan(0);
    expect(result.canonicalText.slice(secondAnchor - 2, secondAnchor)).toBe("\n\n");
    // canonical_text must already be in normalized form (idempotent) — a
    // consumer re-normalizing it (e.g. verify() defensively) must not shift
    // any offset, including pageAnchors.
    expect(normalizeText(result.canonicalText)).toBe(result.canonicalText);
  });

  it("extracting the same PDF bytes twice yields the same hash, and does not mutate/detach the caller's buffer", async () => {
    const bytes = loadFixture("leave_and_license.pdf");
    const byteLengthBefore = bytes.byteLength;

    const first = await extractDocument({ bytes, mimeType: "application/pdf" });
    // The caller's buffer must survive a call unchanged — callers need to be able to reuse the same
    // bytes again (e.g. resending to Gemini on a later needs_native_document path for a different
    // document).
    expect(bytes.byteLength).toBe(byteLengthBefore);

    const second = await extractDocument({ bytes, mimeType: "application/pdf" });
    expect(first.kind).toBe("extracted");
    expect(second.kind).toBe("extracted");
    if (first.kind === "extracted" && second.kind === "extracted") {
      expect(second.canonicalTextHash).toBe(first.canonicalTextHash);
      expect(second.canonicalText).toBe(first.canonicalText);
    }
  });

  it("returns needs_native_document for a PDF with no usable text layer (scanned/image-only), never empty extracted text", async () => {
    const bytes = loadFixture("scanned_no_text_layer.pdf");
    const byteLengthBefore = bytes.byteLength;
    const result = await extractDocument({ bytes, mimeType: "application/pdf" });

    expect(result.kind).toBe("needs_native_document");
    expect(result).not.toHaveProperty("canonicalText");
    // Same buffer-survives-the-call requirement as the real-text PDF case — this is exactly the path
    // a caller needs to re-send the original bytes to Gemini's multimodal input afterward.
    expect(bytes.byteLength).toBe(byteLengthBefore);
  });

  it("throws EXTRACTION_FAILED for a corrupt/unparseable PDF, never a crash or empty string", async () => {
    const bytes = loadFixture("corrupt.pdf");

    await expect(extractDocument({ bytes, mimeType: "application/pdf" })).rejects.toMatchObject({
      code: "EXTRACTION_FAILED",
    });
  });
});

describe("extractDocument — DOCX", () => {
  it("extracts known content from a real DOCX", async () => {
    const bytes = loadFixture("nda.docx");
    const result = await extractDocument({
      bytes,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    expect(result.kind).toBe("extracted");
    if (result.kind !== "extracted") throw new Error("unreachable");
    expect(result.canonicalText).toContain("Disclosing Party");
    expect(result.canonicalText).toContain("Confidential Information");
    expect(result.inputMode).toBe("text");
    // No page concept for DOCX.
    expect(result.pageAnchors).toEqual([]);
  });
});

describe("extractDocument — pasted text", () => {
  it("normalizes and returns pasted text with no page anchors", async () => {
    const result = await extractDocument({ pastedText: "Hello   world.\r\n\r\n\r\nSecond paragraph." });

    expect(result.kind).toBe("extracted");
    if (result.kind !== "extracted") throw new Error("unreachable");
    expect(result.canonicalText).toBe("Hello world.\n\nSecond paragraph.");
    expect(result.pageAnchors).toEqual([]);
  });
});

describe("extractDocument — invalid input", () => {
  it("rejects an unsupported mimeType with INVALID_DOCUMENT", async () => {
    const bytes = Buffer.from("plain text pretending to be a document");
    await expect(
      extractDocument({ bytes, mimeType: "image/png" }),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
  });

  it("rejects empty pasted text with INVALID_DOCUMENT (never returns an empty canonicalText)", async () => {
    await expect(extractDocument({ pastedText: "   \n\n  " })).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });
  });
});

describe("extractDocument — the file's magic bytes, not the declared type, pick the parser", () => {
  const PDF = "application/pdf";
  const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const TXT = "text/plain";
  const pdfBytes = () => loadFixture("leave_and_license.pdf");
  const docxBytes = () => loadFixture("nda.docx");
  const textBytes = () => loadFixture("leave_and_license.txt");

  it.each([
    ["DOCX bytes declared as PDF", docxBytes, PDF],
    ["plain text declared as PDF", textBytes, PDF],
    ["PDF bytes declared as DOCX", pdfBytes, DOCX],
    ["plain text declared as DOCX", textBytes, DOCX],
    ["PDF bytes declared as plain text", pdfBytes, TXT],
    ["DOCX bytes declared as plain text", docxBytes, TXT],
  ])("rejects %s with INVALID_DOCUMENT before any parser runs", async (_case, bytes, mimeType) => {
    await expect(extractDocument({ bytes: bytes(), mimeType })).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      message: expect.stringContaining("does not match"),
    });
  });

  it("rejects a zip declared as DOCX that has no word/document.xml", async () => {
    const zip = buildZip([{ filename: "notes.txt", content: Buffer.from("just a zip") }]);
    await expect(extractDocument({ bytes: zip, mimeType: DOCX })).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
  });

  it("rejects bytes declared as plain text that are not valid UTF-8", async () => {
    const bytes = Uint8Array.from([0x41, 0xff, 0xfe, 0x42]);
    await expect(extractDocument({ bytes, mimeType: TXT })).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
  });

  it("sniffs files shorter than any magic number without throwing", async () => {
    await expect(extractDocument({ bytes: Buffer.from("Hi"), mimeType: TXT })).resolves.toMatchObject({
      canonicalText: "Hi",
    });
    await expect(extractDocument({ bytes: new Uint8Array(0), mimeType: TXT })).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });
    await expect(extractDocument({ bytes: Buffer.from("PK"), mimeType: DOCX })).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });
  });

  it("extracts valid UTF-8 declared as plain text exactly as the same text pasted", async () => {
    const fromBytes = await extractDocument({ bytes: textBytes(), mimeType: TXT });
    const fromPaste = await extractDocument({ pastedText: textBytes().toString("utf8") });
    expect(fromBytes).toEqual(fromPaste);
  });

  it("accepts a PDF header a few bytes into the file, as PDF readers do, but not one past the first KiB", async () => {
    const shifted = Buffer.concat([Buffer.from("\r\n"), pdfBytes()]);
    await expect(extractDocument({ bytes: shifted, mimeType: PDF })).resolves.toMatchObject({ kind: "extracted" });

    const buried = Buffer.concat([Buffer.alloc(2048, 0x20), pdfBytes()]);
    await expect(extractDocument({ bytes: buried, mimeType: PDF })).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
  });
});

describe("extractDocument — size caps (never silently truncate)", () => {
  it("rejects raw bytes over MAX_INPUT_BYTES with INVALID_DOCUMENT, before any parsing", async () => {
    const oversized = Buffer.alloc(MAX_INPUT_BYTES + 1, 0x41);
    await expect(
      extractDocument({ bytes: oversized, mimeType: "application/pdf" }),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
  });

  it("rejects extracted text over MAX_EXTRACTED_CHARS with INVALID_DOCUMENT — no truncated result returned", async () => {
    const oversizedText = "a".repeat(MAX_EXTRACTED_CHARS + 1);
    let thrown: unknown;
    let resolved: unknown;
    try {
      resolved = await extractDocument({ pastedText: oversizedText });
    } catch (err) {
      thrown = err;
    }
    expect(resolved).toBeUndefined();
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe("INVALID_DOCUMENT");
  });

  it("accepts extracted text exactly at MAX_EXTRACTED_CHARS", async () => {
    const exactText = "a".repeat(MAX_EXTRACTED_CHARS);
    const result = await extractDocument({ pastedText: exactText });
    expect(result.kind).toBe("extracted");
  });
});

describe("joinNormalizedPages — property", () => {
  it("stays in normalized form, and every non-empty page's text is recoverable at its own anchor, for any array of already-normalized pages (including blank pages)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ maxLength: 50 }).map(normalizeText), { maxLength: 10 }),
        (pages) => {
          const { joined, pageAnchors } = joinNormalizedPages(pages);

          if (joined.length > 0) {
            expect(normalizeText(joined)).toBe(joined);
          }

          expect(pageAnchors.length).toBe(pages.length);
          for (let i = 0; i < pages.length; i++) {
            if (pages[i].length > 0) {
              expect(joined.slice(pageAnchors[i], pageAnchors[i] + pages[i].length)).toBe(pages[i]);
            }
          }
          for (let i = 0; i < pageAnchors.length - 1; i++) {
            expect(pageAnchors[i]).toBeLessThanOrEqual(pageAnchors[i + 1]);
          }
        },
      ),
    );
  });
});

describe("extractDocument — same bytes/text in, same hash out, across every input path", () => {
  // Calling a pure function twice with the SAME input and asserting the same result holds for any
  // deterministic function, buggy or not — it doesn't test idempotency in any meaningful sense. The
  // property that matters is normalizeText(canonicalText) === canonicalText, the no-op verify() depends on.
  it("re-normalizing the canonicalText produced by a real PDF, a real DOCX, and pasted text is a no-op in every case", async () => {
    const pdfBytes = loadFixture("leave_and_license.pdf");
    const docxBytes = loadFixture("nda.docx");

    const pdfResult = await extractDocument({ bytes: pdfBytes, mimeType: "application/pdf" });
    const docxResult = await extractDocument({
      bytes: docxBytes,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    const pastedResult = await extractDocument({
      pastedText: "Rent   is due\r\n\r\n\r\non the 5th of every month.",
    });

    for (const result of [pdfResult, docxResult, pastedResult]) {
      expect(result.kind).toBe("extracted");
      if (result.kind === "extracted") {
        expect(normalizeText(result.canonicalText)).toBe(result.canonicalText);
      }
    }
  });

  it("extracting the identical pasted-text input twice produces the same canonicalTextHash, for arbitrary normalizable input", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 1, maxLength: 500 })
          .filter((s) => normalizeText(s).length > 0),
        async (input) => {
          const first = await extractDocument({ pastedText: input });
          const second = await extractDocument({ pastedText: input });
          expect(first.kind).toBe(second.kind);
          if (first.kind === "extracted" && second.kind === "extracted") {
            expect(second.canonicalText).toBe(first.canonicalText);
            expect(second.canonicalTextHash).toBe(first.canonicalTextHash);
          }
        },
      ),
    );
  });
});

describe("extractDocument — pasted text has its own explicit raw-length cap", () => {
  it("rejects raw pasted text over MAX_EXTRACTED_CHARS with INVALID_DOCUMENT before normalizing", async () => {
    const oversized = "a".repeat(MAX_EXTRACTED_CHARS + 1);
    await expect(extractDocument({ pastedText: oversized })).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
    });
  });
});
