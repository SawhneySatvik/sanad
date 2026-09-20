import { readFile } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError, type AppErrorCode } from "@/server/core/errors";
import type { Principal } from "@/server/core/types";
import { getDocument } from "@/server/data/documents";
import { ExtractionAbortedError, extractDocument } from "@/server/deterministic/extract";
import { EXTRACTION_WORKER_LIMITS } from "@/server/deterministic/extract/constants";
import { parseInWorker } from "@/server/deterministic/extract/sandbox";
import { analyze, analyzeDocument, DocumentAnalysisError } from "@/server/services/understand";
import type { StorageAdapter } from "@/server/storage/types";
import { buildPdfBomb, buildTextPdf } from "@tests/support/builders/pdf";
import { buildDocxBomb, buildZip, docxEntries } from "@tests/support/builders/zip";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { createHarness, FIXTURES_DIR, guestA, type Harness, leaseOutput, MIME } from "@tests/support/services/understand";

// A failure of the document itself — including the parse sandbox stopping it at its deadline, heap
// or memory budget — is terminal: the document is extraction_failed and a retry never re-reads or
// re-parses it. An unavailable or rate-limited dependency, or a parse worker that could not run at
// all, is retryable: the document stays pending and a retry extracts it.

// Fault injection at the storage boundary: the real adapter, with scripted read failures.
class FaultyStorage implements StorageAdapter {
  reads = 0;
  readonly readFailures: unknown[] = [];
  constructor(private readonly inner: StorageAdapter) {}
  createUploadTarget(principal: Principal, metadata: Parameters<StorageAdapter["createUploadTarget"]>[1]) {
    return this.inner.createUploadTarget(principal, metadata);
  }
  writeRelayed(principal: Principal, ref: string, bytes: Uint8Array) {
    return this.inner.writeRelayed(principal, ref, bytes);
  }
  confirmUpload(principal: Principal, ref: string) {
    return this.inner.confirmUpload(principal, ref);
  }
  async readObject(ref: string) {
    this.reads++;
    const failure = this.readFailures.shift();
    if (failure !== undefined) throw failure;
    return this.inner.readObject(ref);
  }
  getSignedUrl(principal: Principal, row: Parameters<StorageAdapter["getSignedUrl"]>[1]) {
    return this.inner.getSignedUrl(principal, row);
  }
  delete(principal: Principal, row: Parameters<StorageAdapter["delete"]>[1]) {
    return this.inner.delete(principal, row);
  }
}

let h: Harness;
let storage: FaultyStorage;
let llm: FakeLlmClient;
beforeEach(async () => {
  h = await createHarness();
  storage = new FaultyStorage(h.storage);
  llm = new FakeLlmClient({ defaultResponse: { data: leaseOutput() } });
});
afterEach(async () => {
  await h.close();
});

const deps = () => ({ ...h.deps(llm), storage });

async function failedAnalysis(mimeType: string, bytes: Uint8Array): Promise<DocumentAnalysisError> {
  const input = await h.uploadBytes(guestA, "upload", mimeType, bytes);
  const error = await analyze(deps(), guestA, input).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(DocumentAnalysisError);
  return error as DocumentAnalysisError;
}

async function lease(): Promise<Uint8Array> {
  return readFile(path.join(FIXTURES_DIR, "leave_and_license.txt"));
}

describe("analyze — transient failures leave the document pending", () => {
  it.each<AppErrorCode>(["UPSTREAM_UNAVAILABLE", "RATE_LIMITED", "TIMEOUT"])(
    "a %s storage read keeps the document pending, and the retry extracts and analyzes it",
    async (code) => {
      storage.readFailures.push(new AppError(code, "storage unavailable"));

      const error = await failedAnalysis(MIME.txt, await lease());

      expect(error.code).toBe(code);
      expect((await getDocument(h.t.db, guestA, error.documentId)).processingStatus).toBe("pending");
      const retried = await analyzeDocument(deps(), guestA, error.documentId);
      expect(retried.document.processingStatus).toBe("ready");
      expect(retried.analysisState).toBe("complete");
      expect(storage.reads).toBe(2);
    },
  );
});

describe("analyze — non-transient failures are terminal", () => {
  it("a crash while reading the object (not an AppError) marks it extraction_failed; the retry never reads it again", async () => {
    storage.readFailures.push(new TypeError("socket hang up"));
    const input = await h.uploadBytes(guestA, "lease.txt", MIME.txt, await lease());

    await expect(analyze(deps(), guestA, input)).rejects.toThrow(TypeError);

    const [row] = await h.t.client.query<{ id: string; processing_status: string }>("SELECT id, processing_status FROM documents").then((r) => r.rows);
    expect(row.processing_status).toBe("extraction_failed");
    await expect(analyzeDocument(deps(), guestA, row.id)).rejects.toMatchObject({ code: "EXTRACTION_FAILED" });
    expect(storage.reads).toBe(1);
    expect(llm.callCount).toBe(0);
  });

  it("the parse sandbox stopping a PDF at its memory budget marks it extraction_failed; the retry never re-parses it", async () => {
    const bomb = buildPdfBomb("font", 256 * 1024 * 1024);

    const error = await failedAnalysis(MIME.pdf, bomb);

    expect(error.cause).toBeInstanceOf(ExtractionAbortedError);
    expect(error.cause).toMatchObject({ code: "INVALID_DOCUMENT", abortReason: "memory_limit" });
    // DocumentAnalysisError forwards the cause's own AppError.reason, not the sandbox's abortReason.
    expect(error).toMatchObject({ reason: "too_large" });
    expect((await getDocument(h.t.db, guestA, error.documentId)).processingStatus).toBe("extraction_failed");
    await expect(analyzeDocument(deps(), guestA, error.documentId)).rejects.toMatchObject({ code: "EXTRACTION_FAILED" });
    expect(storage.reads).toBe(1);
    expect(llm.callCount).toBe(0);
  });

  it("a text/plain upload whose bytes are a PDF is refused by the type check and marked extraction_failed", async () => {
    const pdf = buildTextPdf(["The Licensee shall pay the monthly license fee."]);

    const error = await failedAnalysis(MIME.txt, pdf);

    expect(error.code).toBe("INVALID_DOCUMENT");
    expect((await getDocument(h.t.db, guestA, error.documentId)).processingStatus).toBe("extraction_failed");
    expect(llm.callCount).toBe(0);
  });
});

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// A DOCX whose one run sits `depth` hyperlinks deep: mammoth walks the tree recursively.
function nestedDocx(depth: number): Buffer {
  const body = `<w:p>${"<w:hyperlink>".repeat(depth)}<w:r><w:t>Nested clause text.</w:t></w:r>${"</w:hyperlink>".repeat(depth)}</w:p>`;
  return buildZip(
    docxEntries(
      Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
      ),
    ),
  );
}

describe("analyze — a parse worker that could not run is retryable", () => {
  it("an unsupported runtime (worker_crash) keeps the document pending with its documentId; once fixed, the retry analyzes it", async () => {
    const pdf = await readFile(path.join(FIXTURES_DIR, "leave_and_license.pdf"));
    const descriptor = Object.getOwnPropertyDescriptor(Worker.prototype, "getHeapStatistics") as PropertyDescriptor;
    // As on Node before 22.16: the sandbox cannot watch a parse's memory, so it refuses to run one.
    Object.defineProperty(Worker.prototype, "getHeapStatistics", { value: undefined, configurable: true });
    let error: DocumentAnalysisError;
    try {
      error = await failedAnalysis(MIME.pdf, pdf);
    } finally {
      Object.defineProperty(Worker.prototype, "getHeapStatistics", descriptor);
    }

    expect(error.cause).toBeInstanceOf(ExtractionAbortedError);
    expect(error.cause).toMatchObject({ abortReason: "worker_crash" });
    expect(error).toMatchObject({ reason: "unreadable" });
    expect(error.documentId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await getDocument(h.t.db, guestA, error.documentId)).processingStatus).toBe("pending");
    const retried = await analyzeDocument(deps(), guestA, error.documentId);
    expect(retried.document.processingStatus).toBe("ready");
    expect(retried.analysisState).toBe("complete");
  });
});

describe("analyze — a crafted document at a resource limit is terminal, never a worker crash", () => {
  it("a DOCX nested deeper than the parser's stack can follow is refused as the document's fault; a shallow one parses", async () => {
    await expect(extractDocument({ bytes: nestedDocx(50), mimeType: DOCX })).resolves.toMatchObject({ kind: "extracted" });

    const error = await failedAnalysis(DOCX, nestedDocx(200_000));

    expect(error.code).toBe("EXTRACTION_FAILED");
    expect(error.cause).not.toBeInstanceOf(ExtractionAbortedError);
    expect((await getDocument(h.t.db, guestA, error.documentId)).processingStatus).toBe("extraction_failed");
    expect(llm.callCount).toBe(0);
  });

  it("a DOCX whose document tree outgrows the parse heap is stopped as the document's fault and marked extraction_failed", async () => {
    const error = await failedAnalysis(DOCX, buildDocxBomb(45 * 1024 * 1024));

    expect(error.cause).toBeInstanceOf(ExtractionAbortedError);
    expect(error.cause).toMatchObject({ code: "INVALID_DOCUMENT" });
    // heap_limit normally; on a heavily loaded machine the parse deadline can come first. Both are
    // after ready, so both are terminal — never worker_crash — and both map to the same reason.
    expect(["heap_limit", "deadline"]).toContain((error.cause as ExtractionAbortedError).abortReason);
    expect(error).toMatchObject({ reason: "too_large" });
    expect((await getDocument(h.t.db, guestA, error.documentId)).processingStatus).toBe("extraction_failed");
  });

  it("a PDF that keeps the parser busy past its deadline ends as deadline, never worker_crash", async () => {
    const outcome = await parseInWorker("pdf", buildPdfBomb("operators", 20 * 1024 * 1024), { ...EXTRACTION_WORKER_LIMITS, deadlineMs: 500 }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(outcome).toBeInstanceOf(ExtractionAbortedError);
    expect(outcome).toMatchObject({ code: "INVALID_DOCUMENT", abortReason: "deadline", reason: "too_large" });
  });
});
