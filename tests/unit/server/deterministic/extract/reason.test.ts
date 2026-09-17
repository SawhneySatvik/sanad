// The extract-layer reason mapping, through the real extractDocument() entry point — one fixture
// per reason, exercising the same adversarial inputs a real upload can produce.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractDocument, MAX_EXTRACTED_CHARS, MAX_INPUT_BYTES } from "@/server/deterministic/extract/index";
import { buildZip } from "@tests/support/builders/zip";

const FIXTURES_DIR = join(process.cwd(), "tests", "fixtures", "documents");
const PDF = "application/pdf";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const TXT = "text/plain";

function loadFixture(name: string): Buffer {
  return readFileSync(join(FIXTURES_DIR, name));
}

describe("extractDocument — reason mapping", () => {
  it("too_large: a byte-count one over MAX_INPUT_BYTES", async () => {
    const oversized = Buffer.alloc(MAX_INPUT_BYTES + 1, 0x41);
    await expect(extractDocument({ bytes: oversized, mimeType: PDF })).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      reason: "too_large",
    });
  });

  it("too_large: pasted text over MAX_EXTRACTED_CHARS", async () => {
    await expect(extractDocument({ pastedText: "a".repeat(MAX_EXTRACTED_CHARS + 1) })).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      reason: "too_large",
    });
  });

  it("unsupported_type: a .zip that isn't a DOCX declared as one — sniffs as zip, not the declared PDF/DOCX/text bucket, so it's unsupported outright", async () => {
    await expect(extractDocument({ bytes: Buffer.from("plain text pretending to be a document"), mimeType: "application/zip" })).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      reason: "unsupported_type",
    });
  });

  it("type_mismatch: a PDF's bytes uploaded with mimeType: text/plain", async () => {
    const pdfBytes = loadFixture("leave_and_license.pdf");
    await expect(extractDocument({ bytes: pdfBytes, mimeType: TXT })).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      reason: "type_mismatch",
    });
  });

  it("unreadable: bytes declared as plain text that are not valid UTF-8", async () => {
    const bytes = Uint8Array.from([0x41, 0xff, 0xfe, 0x42]);
    await expect(extractDocument({ bytes, mimeType: TXT })).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      reason: "unreadable",
    });
  });

  it("unreadable: a corrupt PDF header — the parser itself fails", async () => {
    const bytes = loadFixture("corrupt.pdf");
    await expect(extractDocument({ bytes, mimeType: PDF })).rejects.toMatchObject({
      code: "EXTRACTION_FAILED",
      reason: "unreadable",
    });
  });

  it("unreadable: a zip declared as DOCX with no word/document.xml — well-formed zip, not a DOCX", async () => {
    const zip = buildZip([{ filename: "notes.txt", content: Buffer.from("just a zip") }]);
    await expect(extractDocument({ bytes: zip, mimeType: DOCX })).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      reason: "unreadable",
    });
  });

  it("empty: zero extractable characters after parsing", async () => {
    await expect(extractDocument({ pastedText: "   \n\n  " })).rejects.toMatchObject({
      code: "INVALID_DOCUMENT",
      reason: "empty",
    });
  });

  it("positive control: a real PDF extracts with no error", async () => {
    const bytes = loadFixture("leave_and_license.pdf");
    await expect(extractDocument({ bytes, mimeType: PDF })).resolves.toMatchObject({ kind: "extracted" });
  });
});
