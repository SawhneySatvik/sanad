// DocumentOutput.sampleId is on the wire so the UI can honestly label a recorded analysis. Pinned
// separately from documents.test.ts's broader fixture so a dropped or reoptionalized field fails a
// test whose name says exactly what broke.

import { describe, expect, it } from "vitest";
import { DocumentOutput } from "@/shared/contracts/documents";
import { DocumentListRowOutput } from "@/shared/contracts/library";

const base = {
  id: "0a0a0a0a-0000-4000-8000-00000000000a",
  title: "lease.txt",
  projectId: null,
  filename: "lease.txt",
  mimeType: "text/plain",
  processingStatus: "ready",
  inputMode: "text",
  documentType: "leave_and_license",
  jurisdiction: "IN",
  detectionConfidence: "0.90",
  uploadedAt: "2026-09-23T10:00:00.000Z",
  expiresAt: null,
};

describe("DocumentOutput.sampleId", () => {
  it("is required — omitting it fails to parse", () => {
    expect(DocumentOutput.safeParse(base).success).toBe(false);
  });

  it("accepts null (an ordinary upload) and a sample's registry id", () => {
    expect(DocumentOutput.safeParse({ ...base, sampleId: null }).success).toBe(true);
    expect(DocumentOutput.safeParse({ ...base, sampleId: "lease" }).success).toBe(true);
  });
});

describe("DocumentListRowOutput.sampleId", () => {
  const row = {
    id: base.id,
    title: base.title,
    filename: base.filename,
    documentType: base.documentType,
    processingStatus: base.processingStatus,
    analysisState: "complete",
    inputMode: base.inputMode,
    projectId: null,
    uploadedAt: base.uploadedAt,
    updatedAt: base.uploadedAt,
    expiresAt: base.expiresAt,
  };

  it("is required on the list row too, so a library listing can label a sample without a second fetch", () => {
    expect(DocumentListRowOutput.safeParse(row).success).toBe(false);
    expect(DocumentListRowOutput.safeParse({ ...row, sampleId: null }).success).toBe(true);
    expect(DocumentListRowOutput.safeParse({ ...row, sampleId: "lease" }).success).toBe(true);
  });
});
