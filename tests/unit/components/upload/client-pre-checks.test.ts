import { describe, expect, it } from "vitest";
import { runClientPreChecks } from "@/components/upload/client-pre-checks";
import { MAX_UPLOAD_SIZE_BYTES } from "@/components/upload/constants";

function fileOf(name: string, sizeBytes: number, type: string): File {
  const bytes = sizeBytes > 0 ? new Uint8Array(sizeBytes) : new Uint8Array(0);
  return new File([bytes], name, { type });
}

describe("runClientPreChecks", () => {
  it("rejects a zero-byte file as empty, using the server's own fixed copy", () => {
    const result = runClientPreChecks(fileOf("lease.pdf", 0, "application/pdf"));
    expect(result).toEqual({ ok: false, reason: "empty", message: "This file is empty." });
  });

  it("rejects a file over the 15 MB cap as too_large", () => {
    const result = runClientPreChecks(fileOf("lease.pdf", MAX_UPLOAD_SIZE_BYTES + 1, "application/pdf"));
    expect(result).toEqual({
      ok: false,
      reason: "too_large",
      message: "This file is too large. Saboot accepts files up to 15 MB.",
    });
  });

  it("accepts a file exactly at the cap", () => {
    const result = runClientPreChecks(fileOf("lease.pdf", MAX_UPLOAD_SIZE_BYTES, "application/pdf"));
    expect(result).toEqual({ ok: true, mimeType: "application/pdf" });
  });

  it("rejects a disallowed declared mime type as unsupported_type", () => {
    const result = runClientPreChecks(fileOf("photo.png", 100, "image/png"));
    expect(result).toEqual({
      ok: false,
      reason: "unsupported_type",
      message: "Saboot can't read this file type. Upload a PDF, DOCX, or plain-text file.",
    });
  });

  it("falls back to the filename's extension when File.type is blank (a real browser quirk for some .docx/.txt files)", () => {
    const docx = runClientPreChecks(fileOf("offer.docx", 100, ""));
    expect(docx).toEqual({
      ok: true,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    const txt = runClientPreChecks(fileOf("notes.txt", 100, ""));
    expect(txt).toEqual({ ok: true, mimeType: "text/plain" });
  });

  it("rejects a blank-type file whose extension doesn't resolve to an allowed type", () => {
    const result = runClientPreChecks(fileOf("archive.zip", 100, ""));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsupported_type");
  });

  it("rejects a filename over 255 characters as filename_too_long", () => {
    const longName = "a".repeat(252) + ".pdf"; // 256 chars total
    const result = runClientPreChecks(fileOf(longName, 100, "application/pdf"));
    expect(result).toEqual({
      ok: false,
      reason: "filename_too_long",
      message: "That filename is too long. Rename the file and try again.",
    });
  });

  it("accepts a filename at exactly the 255-character cap", () => {
    const exactName = "a".repeat(251) + ".pdf"; // 255 chars total
    const result = runClientPreChecks(fileOf(exactName, 100, "application/pdf"));
    expect(result).toEqual({ ok: true, mimeType: "application/pdf" });
  });

  it("checks size before type — an empty file with a bad type still reports empty (the doc's own listed order)", () => {
    const result = runClientPreChecks(fileOf("photo.png", 0, "image/png"));
    expect(result).toEqual({ ok: false, reason: "empty", message: "This file is empty." });
  });
});
