import { readFileSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { EXTRACTION_WORKER_LIMITS, MAX_PDF_PAGES, MAX_RAW_EXTRACTED_CHARS } from "@/server/deterministic/extract/constants";
import { ExtractionAbortedError, superviseWorker } from "@/server/deterministic/extract/sandbox";

// The worker posts "ready" once its parser code has loaded, before it touches the document. Only a
// worker that never got that far failed for a reason outside the document (it could not start):
// worker_crash, which leaves the upload retryable. Anything that goes wrong after ready happened
// while parsing the document, so it is terminal. Scripted workers drive the real supervisor. Only
// the startup test shortens the startup timeout: under load, starting a worker can take seconds.

const SCRIPTED_WORKER = new URL("../../../../support/fakes/extraction-worker.mts", import.meta.url);
const LIMITS = { ...EXTRACTION_WORKER_LIMITS, deadlineMs: 1_000 };

function supervise(behavior: string, limits = LIMITS): Promise<unknown> {
  return superviseWorker(new Worker(SCRIPTED_WORKER, { workerData: { behavior } }), limits).then(
    (response) => response,
    (error: unknown) => error,
  );
}

describe("superviseWorker — before ready: the worker could not start, so the upload stays retryable", () => {
  it.each(["exit-before-ready", "throw-before-ready"])("%s is worker_crash", async (behavior) => {
    const outcome = await supervise(behavior);

    expect(outcome).toBeInstanceOf(ExtractionAbortedError);
    expect(outcome).toMatchObject({ abortReason: "worker_crash", reason: "unreadable" });
  });

  it("a worker that never reports ready is worker_crash once the startup timeout passes", async () => {
    const outcome = await supervise("hang-before-ready", { ...LIMITS, startupTimeoutMs: 500 });

    expect(outcome).toBeInstanceOf(ExtractionAbortedError);
    expect(outcome).toMatchObject({ abortReason: "worker_crash", reason: "unreadable" });
  });
});

describe("superviseWorker — after ready: the parse itself failed, so the upload is terminal", () => {
  it.each([
    ["ready-then-exit", "parser_crash", "unreadable"],
    ["ready-then-throw", "parser_crash", "unreadable"],
    ["ready-then-hang", "deadline", "too_large"],
  ])("%s ends as %s, never worker_crash", async (behavior, abortReason, reason) => {
    const outcome = await supervise(behavior);

    expect(outcome).toBeInstanceOf(ExtractionAbortedError);
    expect(outcome).toMatchObject({ abortReason, reason });
  });

  it("positive control: a result after ready is returned as the parse's response", async () => {
    expect(await supervise("ready-then-result")).toEqual({ kind: "docx", text: "Clause text." });
  });
});

describe("superviseWorker — startup time is never charged to the document", () => {
  it("a worker that starts slower than the parse deadline still gets the whole deadline, and parses a real PDF", { timeout: 60_000 }, async () => {
    const pdf = new Uint8Array(readFileSync(path.join(process.cwd(), "tests", "fixtures", "documents", "leave_and_license.pdf")));
    const request = { format: "pdf", bytes: pdf, maxPdfPages: MAX_PDF_PAGES, maxRawChars: MAX_RAW_EXTRACTED_CHARS };
    // Startup outlasts the whole parse deadline; the deadline is still roomy enough for this small
    // PDF on a loaded machine.
    const worker = new Worker(SCRIPTED_WORKER, { workerData: { behavior: "slow-start", startDelayMs: 9_000, ...request } });

    const outcome = await superviseWorker(worker, { ...EXTRACTION_WORKER_LIMITS, deadlineMs: 8_000 }).catch((error: unknown) => error);

    expect(outcome).toMatchObject({ kind: "pdf" });
    expect((outcome as { pages: string[] }).pages).toHaveLength(2);
  });
});
