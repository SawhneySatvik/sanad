import { readFileSync } from "node:fs";
import { join } from "node:path";
import mammoth from "mammoth";
import { describe, expect, it } from "vitest";
import { assertDocxSafeToParse, MAX_DOCX_DECOMPRESSED_BYTES } from "@/server/deterministic/extract/docx-guard";
import {
  buildDocxBomb,
  buildRebasingZip,
  buildZip,
  docxDocumentXml,
  docxEntries,
  type ZipEntryInput,
} from "@tests/support/builders/zip";
import { extractDocument } from "@/server/deterministic/extract/index";

const FIXTURES_DIR = join(process.cwd(), "tests", "fixtures", "documents");

describe("assertDocxSafeToParse", () => {
  it("passes a real, legitimate small DOCX", () => {
    const bytes = readFileSync(join(FIXTURES_DIR, "nda.docx"));
    expect(() => assertDocxSafeToParse(bytes)).not.toThrow();
  });

  it("rejects a small compressed file that decompresses to far past the budget, quickly and without OOM", () => {
    // A realistic zip-bomb shape: a ~270KB DOCX whose document.xml decompresses to ~80MB.
    const bomb = buildDocxBomb(80 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(1024 * 1024); // the FILE stays small

    const t0 = Date.now();
    expect(() => assertDocxSafeToParse(bomb)).toThrow(
      expect.objectContaining({ code: "INVALID_DOCUMENT" }),
    );
    const elapsedMs = Date.now() - t0;
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("the full extractDocument() path rejects the same DOCX bomb before ever calling mammoth", async () => {
    const bomb = buildDocxBomb(80 * 1024 * 1024);
    const t0 = Date.now();
    await expect(
      extractDocument({
        bytes: bomb,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("sums decompressed size across multiple entries, rejecting once the TOTAL crosses the budget even if no single entry does", () => {
    const perEntry = Math.floor(MAX_DOCX_DECOMPRESSED_BYTES / 3) + 1024; // 3 entries, each under the cap alone
    const zip = buildZip([
      ...docxEntries(docxDocumentXml(["A small main part."])),
      { filename: "a.xml", content: Buffer.alloc(perEntry, "A") },
      { filename: "b.xml", content: Buffer.alloc(perEntry, "B") },
      { filename: "c.xml", content: Buffer.alloc(perEntry, "C") },
    ]);
    expect(() => assertDocxSafeToParse(zip)).toThrow(
      expect.objectContaining({ code: "INVALID_DOCUMENT", message: expect.stringContaining("decompressed-size cap") }),
    );
  });

  it("never trusts the zip's OWN declared uncompressed-size header — a header that under-claims still gets the true (larger) size measured", () => {
    // buildZip always writes the entry's REAL content length as the
    // declared uncompressed size, so to prove we don't trust the header we
    // need a case where trusting it would hide a bomb: reuse buildDocxBomb,
    // which is exactly this (a tiny compressed size, a huge TRUE
    // decompressed size) — the guard measures via bounded inflate, not by
    // reading the header field at all.
    const bomb = buildDocxBomb(MAX_DOCX_DECOMPRESSED_BYTES * 2);
    expect(() => assertDocxSafeToParse(bomb)).toThrow(
      expect.objectContaining({ code: "INVALID_DOCUMENT" }),
    );
  });

  it("rejects a non-zip/garbage buffer with EXTRACTION_FAILED, never a crash", () => {
    expect(() => assertDocxSafeToParse(Buffer.from("not a zip file at all"))).toThrow(
      expect.objectContaining({ code: "EXTRACTION_FAILED" }),
    );
  });

  it("accepts a small zip well within budget with mixed stored/deflate entries", () => {
    const zip = buildZip([
      ...docxEntries(docxDocumentXml(["A small main part."])),
      { filename: "stored.txt", content: Buffer.from("hello"), method: "store" },
      { filename: "deflated.txt", content: Buffer.from("world".repeat(100)), method: "deflate" },
    ]);
    expect(() => assertDocxSafeToParse(zip)).not.toThrow();
  });

  it("accepts a zip whose end-of-central-directory record carries a comment", () => {
    const comment = Buffer.from("Created by a word processor", "latin1");
    const zip = buildZip(docxEntries(docxDocumentXml(["A small main part."])));
    zip.writeUInt16LE(comment.length, zip.length - 2);
    expect(() => assertDocxSafeToParse(Buffer.concat([zip, comment]))).not.toThrow();
  });

  it("rejects a well-formed zip with no word/document.xml as INVALID_DOCUMENT — it is not a DOCX", () => {
    const zip = buildZip([{ filename: "notes.txt", content: Buffer.from("just a zip") }]);
    expect(() => assertDocxSafeToParse(zip)).toThrow(
      expect.objectContaining({ code: "INVALID_DOCUMENT", message: expect.stringContaining("not a DOCX") }),
    );
  });
});

// mammoth's unzip (jszip) does not read the zip the way a naive central-directory walk does. Each
// case below first proves the differential is real — mammoth extracts text the guard never
// measured — then that the guard now rejects the file outright.
describe("assertDocxSafeToParse — mammoth may only read the entries the guard measured", () => {
  const overBudgetXml = (): Buffer => docxDocumentXml(["A".repeat(MAX_DOCX_DECOMPRESSED_BYTES + 1024 * 1024)]);
  const padding = (bytes: number): ZipEntryInput => ({
    filename: "customXml/padding.bin",
    content: Buffer.alloc(bytes, 0x20),
    method: "store",
  });

  it("an EOCD that under-counts the central directory: jszip reads every consecutive record, so a hidden main part replaces the visible one", async () => {
    const zip = buildZip(
      [...docxEntries(docxDocumentXml(["Visible text."])), docxEntries(docxDocumentXml(["Hidden text."]))[2]],
      { claimedEntryCount: 3 },
    );
    const { value } = await mammoth.extractRawText({ buffer: zip });
    expect(value).toContain("Hidden text.");

    expect(() => assertDocxSafeToParse(zip)).toThrow(expect.objectContaining({ code: "EXTRACTION_FAILED" }));
  });

  it("an EOCD that under-counts the central directory can no longer smuggle an over-budget part past the size budget", () => {
    const hiddenBomb = docxEntries(overBudgetXml())[2];
    const zip = buildZip([...docxEntries(docxDocumentXml(["Visible text."])), hiddenBomb], { claimedEntryCount: 3 });
    expect(zip.length).toBeLessThan(1024 * 1024);

    expect(() => assertDocxSafeToParse(zip)).toThrow(expect.objectContaining({ code: "EXTRACTION_FAILED" }));
  });

  it("a gap between the central directory's claimed end and the EOCD: jszip rebases every offset (reader.zero) and reads a different directory", async () => {
    const hidden = docxEntries(docxDocumentXml(["Hidden text."]));
    const zip = buildRebasingZip([...docxEntries(docxDocumentXml(["Visible text."])), padding(4096)], hidden);
    const { value } = await mammoth.extractRawText({ buffer: zip });
    expect(value).toContain("Hidden text.");
    expect(value).not.toContain("Visible text.");

    expect(() => assertDocxSafeToParse(zip)).toThrow(expect.objectContaining({ code: "EXTRACTION_FAILED" }));
  });

  it("the rebasing layout can no longer smuggle an over-budget part past the size budget", () => {
    const hidden = docxEntries(overBudgetXml());
    const zip = buildRebasingZip([...docxEntries(docxDocumentXml(["Visible text."])), padding(256 * 1024)], hidden);
    expect(zip.length).toBeLessThan(1024 * 1024);

    expect(() => assertDocxSafeToParse(zip)).toThrow(expect.objectContaining({ code: "EXTRACTION_FAILED" }));
  });

  it("rejects bytes after the end-of-central-directory record", () => {
    const zip = buildZip(docxEntries(docxDocumentXml(["Visible text."])));
    expect(() => assertDocxSafeToParse(Buffer.concat([zip, Buffer.from("trailing")]))).toThrow(
      expect.objectContaining({ code: "EXTRACTION_FAILED" }),
    );
  });

  it("rejects multi-disk markers, which switch jszip to ZIP64 records this guard does not read", () => {
    const zip = buildZip(docxEntries(docxDocumentXml(["Visible text."])));
    zip.writeUInt16LE(0xffff, zip.length - 22 + 4); // EOCD "number of this disk"
    expect(() => assertDocxSafeToParse(zip)).toThrow(expect.objectContaining({ code: "EXTRACTION_FAILED" }));
  });
});
