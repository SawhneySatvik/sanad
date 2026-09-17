import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { AppError } from "@/server/core/errors";
import { EXTRACTION_WORKER_LIMITS, MAX_CONCURRENT_EXTRACTIONS } from "@/server/deterministic/extract/constants";
import { ExtractionAbortedError, parseInWorker } from "@/server/deterministic/extract/sandbox";
import { buildPdfBomb } from "@tests/support/builders/pdf";
import { buildDocxBomb } from "@tests/support/builders/zip";

const FIXTURES_DIR = join(process.cwd(), "tests", "fixtures", "documents");

// Runs `work` while a 10 ms timer measures the longest gap between its ticks — how long this
// thread's event loop was blocked.
async function withEventLoopLag<T>(work: () => Promise<T>): Promise<{ outcome: T | unknown; maxLagMs: number; elapsedMs: number }> {
  let maxLagMs = 0;
  let last = performance.now();
  const ticker = setInterval(() => {
    const now = performance.now();
    maxLagMs = Math.max(maxLagMs, now - last - 10);
    last = now;
  }, 10);
  const t0 = performance.now();
  let outcome: T | unknown;
  try {
    outcome = await work();
  } catch (error) {
    outcome = error;
  }
  const elapsedMs = performance.now() - t0;
  clearInterval(ticker);
  return { outcome, maxLagMs, elapsedMs };
}

describe("parseInWorker — legitimate documents", () => {
  it("returns a real PDF's raw page text and a real DOCX's raw text, leaving the caller's bytes intact", async () => {
    const pdf = readFileSync(join(FIXTURES_DIR, "leave_and_license.pdf"));
    const pdfLength = pdf.byteLength;
    const { pages } = await parseInWorker("pdf", pdf);
    expect(pages).toHaveLength(2);
    expect(pages.join("")).toContain("Licensor");
    expect(pdf.byteLength).toBe(pdfLength);

    const { text } = await parseInWorker("docx", readFileSync(join(FIXTURES_DIR, "nda.docx")));
    expect(text).toContain("Disclosing Party");
  });

  it("a parser rejection is a plain AppError carrying the parser's reason, never an ExtractionAbortedError", async () => {
    const error = await parseInWorker("pdf", readFileSync(join(FIXTURES_DIR, "corrupt.pdf"))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).not.toBeInstanceOf(ExtractionAbortedError);
    expect(error).toMatchObject({ code: "EXTRACTION_FAILED", message: "The PDF could not be parsed." });
  });
});

describe("parseInWorker — a runtime that cannot watch a worker's buffer memory", () => {
  it("refuses to parse (EXTRACTION_FAILED) instead of parsing unwatched or crashing this thread", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Worker.prototype, "getHeapStatistics");
    expect(descriptor).toBeDefined();
    // As on Node before 22.16, where Worker#getHeapStatistics() does not exist.
    Object.defineProperty(Worker.prototype, "getHeapStatistics", { value: undefined, configurable: true });
    try {
      await expect(parseInWorker("pdf", readFileSync(join(FIXTURES_DIR, "leave_and_license.pdf")))).rejects.toMatchObject({
        code: "EXTRACTION_FAILED",
        abortReason: "worker_crash",
        reason: "unreadable",
      });
    } finally {
      Object.defineProperty(Worker.prototype, "getHeapStatistics", descriptor as PropertyDescriptor);
    }
  });
});

describe("parseInWorker — a hostile file exhausts only its worker's budget", () => {
  it("deadline: a 1-page PDF of 20 MB of save/restore operators is terminated at the deadline, and this thread keeps running", async () => {
    const bomb = buildPdfBomb("operators", 20 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(64 * 1024);

    const { outcome, maxLagMs, elapsedMs } = await withEventLoopLag(() =>
      parseInWorker("pdf", bomb, { ...EXTRACTION_WORKER_LIMITS, deadlineMs: 500 }),
    );
    expect(outcome).toBeInstanceOf(ExtractionAbortedError);
    expect(outcome).toMatchObject({ code: "INVALID_DOCUMENT", abortReason: "deadline", reason: "too_large" });
    expect(elapsedMs).toBeGreaterThanOrEqual(500);
    // Parsed on this thread, the same file blocked the event loop for 6 s or more.
    expect(maxLagMs).toBeLessThan(1000);
  });

  it("heap limit: mammoth building a DOM too large for the worker's heap ends as heap_limit, not a process crash", async () => {
    const bomb = buildDocxBomb(20 * 1024 * 1024);
    const { outcome, maxLagMs } = await withEventLoopLag(() =>
      parseInWorker("docx", bomb, { ...EXTRACTION_WORKER_LIMITS, maxOldGenerationSizeMb: 64 }),
    );
    expect(outcome).toBeInstanceOf(ExtractionAbortedError);
    expect(outcome).toMatchObject({ code: "INVALID_DOCUMENT", abortReason: "heap_limit", reason: "too_large" });
    expect(maxLagMs).toBeLessThan(1000);
  });

  it("external memory: a font program inflating into a buffer V8's heap limit never counts ends as memory_limit", async () => {
    const bomb = buildPdfBomb("font", 256 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(1024 * 1024);

    const { outcome } = await withEventLoopLag(() =>
      parseInWorker("pdf", bomb, { ...EXTRACTION_WORKER_LIMITS, maxExternalMemoryMb: 32 }),
    );
    expect(outcome).toBeInstanceOf(ExtractionAbortedError);
    expect(outcome).toMatchObject({ code: "INVALID_DOCUMENT", abortReason: "memory_limit", reason: "too_large" });
  });

  it("runs at most MAX_CONCURRENT_EXTRACTIONS parses at once — the rest wait for a slot", async () => {
    expect(MAX_CONCURRENT_EXTRACTIONS).toBe(2);
    const bomb = buildPdfBomb("operators", 20 * 1024 * 1024);
    const limits = { ...EXTRACTION_WORKER_LIMITS, deadlineMs: 600 };

    const t0 = performance.now();
    const outcomes = await Promise.all(
      Array.from({ length: 3 }, () => parseInWorker("pdf", bomb, limits).catch((e: unknown) => e)),
    );
    const elapsedMs = performance.now() - t0;
    for (const outcome of outcomes) expect(outcome).toMatchObject({ abortReason: "deadline", reason: "too_large" });
    // Three deadline-bound parses, two slots: the third starts only after one of the first two ends.
    expect(elapsedMs).toBeGreaterThanOrEqual(2 * 600);
  });
});
