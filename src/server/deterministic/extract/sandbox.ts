import { Worker } from "node:worker_threads";
import { AppError } from "@/server/core/errors";
import {
  EXTRACTION_WORKER_LIMITS,
  MAX_CONCURRENT_EXTRACTIONS,
  MAX_PDF_PAGES,
  MAX_RAW_EXTRACTED_CHARS,
} from "./constants";
import type { ExtractionWorkerMessage, ExtractionWorkerRequest, ExtractionWorkerResponse } from "./worker.mts";

/** Runs the PDF/DOCX parsers in worker threads, each under a deadline and memory budget. */

/**
 * Why the sandbox, rather than the parser, ended a parse. worker_crash: the worker never reported
 * ready — it could not start, so nothing about the document is known. Every other reason happened
 * after ready, while the document was being parsed: parser_crash is a worker that died or exited
 * with no result.
 */
export type ExtractionAbortReason = "deadline" | "heap_limit" | "memory_limit" | "parser_crash" | "worker_crash";

/**
 * A parse the sandbox stopped, its worker already terminated: over the deadline or a memory budget
 * is INVALID_DOCUMENT (the document is the cause); a worker that died any other way is
 * EXTRACTION_FAILED. The former is a size/resource problem (too_large); the latter means the file
 * itself could not be read (unreadable).
 */
export class ExtractionAbortedError extends AppError {
  // Named `abortReason`, never `reason`: AppError's own `reason` is the fixed app-wide enum this
  // constructor maps into via `super()` — a same-named field here would shadow it with the sandbox's
  // narrower vocabulary, and the wire would show "deadline" instead of "too_large".
  readonly abortReason: ExtractionAbortReason;

  constructor(abortReason: ExtractionAbortReason, message: string) {
    const terminal = abortReason === "worker_crash" || abortReason === "parser_crash";
    super(terminal ? "EXTRACTION_FAILED" : "INVALID_DOCUMENT", message, { reason: terminal ? "unreadable" : "too_large" });
    this.name = "ExtractionAbortedError";
    this.abortReason = abortReason;
  }
}

/** A parse's budget; see EXTRACTION_WORKER_LIMITS. */
export type ExtractionWorkerLimits = typeof EXTRACTION_WORKER_LIMITS;

type ParsedText = {
  pdf: Extract<ExtractionWorkerResponse, { kind: "pdf" }>;
  docx: Extract<ExtractionWorkerResponse, { kind: "docx" }>;
};

const BYTES_PER_MB = 1024 * 1024;

// pdf.js grows a decode buffer by doubling, so a breach is caught within about one doubling of the
// cap; polling costs one cross-thread message.
const MEMORY_POLL_MS = 25;

/**
 * Parses `bytes` as a PDF (raw text per page) or DOCX (raw text) in a worker thread, at most
 * MAX_CONCURRENT_EXTRACTIONS at once per process; further calls wait for a free slot. The calling
 * thread only waits — a hostile file can exhaust the worker's budget, never this thread. `bytes` is
 * copied, never detached.
 * @throws AppError INVALID_DOCUMENT or EXTRACTION_FAILED from the parser: page or raw-character cap
 * exceeded, or the file can't be parsed.
 * @throws ExtractionAbortedError when the deadline, heap or external-memory budget is breached, or
 * the worker dies.
 */
export async function parseInWorker<Format extends "pdf" | "docx">(
  format: Format,
  bytes: Uint8Array,
  limits: ExtractionWorkerLimits = EXTRACTION_WORKER_LIMITS,
): Promise<ParsedText[Format]> {
  await acquireSlot();
  try {
    const response = await runWorker(format, bytes, limits);
    if (response.kind === "rejected") throw new AppError(response.code, response.message, { reason: response.reason });
    // worker.mts answers a request with the response kind named by its format.
    return response as ParsedText[Format];
  } finally {
    releaseSlot();
  }
}

function runWorker(
  format: ExtractionWorkerRequest["format"],
  bytes: Uint8Array,
  limits: ExtractionWorkerLimits,
): Promise<ExtractionWorkerResponse> {
  // Worker#getHeapStatistics() arrived in Node 22.16. Without it the memory watch below would throw
  // on this thread, and a parse's buffers would go unbounded — refuse instead.
  if (typeof Worker.prototype.getHeapStatistics !== "function") {
    return Promise.reject(
      new ExtractionAbortedError("worker_crash", "This Node.js runtime cannot watch a parse's buffer memory."),
    );
  }
  // Copied, then transferred rather than cloned: the worker owns the only other copy, and the
  // caller's buffer is never detached.
  const copy = new Uint8Array(bytes);
  const request: ExtractionWorkerRequest = {
    format,
    bytes: copy,
    maxPdfPages: MAX_PDF_PAGES,
    maxRawChars: MAX_RAW_EXTRACTED_CHARS,
  };
  // Keep this `new Worker(new URL("<literal>", import.meta.url))` shape inline: it is the pattern
  // bundlers recognize to emit worker.mts as its own entry, and what Node resolves unbundled.
  const worker = new Worker(new URL("./worker.mts", import.meta.url), {
    workerData: request,
    transferList: [copy.buffer],
    resourceLimits: {
      maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb,
      maxYoungGenerationSizeMb: limits.maxYoungGenerationSizeMb,
      stackSizeMb: limits.stackSizeMb,
    },
  });
  return superviseWorker(worker, limits);
}

/**
 * Waits for a started parse worker's response under `limits`, terminating it on any outcome. The
 * worker reports ready once its parser code has loaded and reads the document only once answered:
 * a failure before ready is worker_crash, one after it is the document's (see ExtractionAbortReason). Two
 * timers, so a slow start can never be charged to the document: startupTimeoutMs from spawn to
 * ready, then deadlineMs from ready. Time spent waiting for a slot counts toward neither.
 * Exported so its classification can be tested against scripted workers.
 */
export function superviseWorker(worker: Worker, limits: ExtractionWorkerLimits): Promise<ExtractionWorkerResponse> {
  return new Promise((resolve, reject) => {
    let ready = false;
    let settled = false;
    // Settles only after the worker has terminated, so its memory is gone before the slot frees.
    const settle = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(startup);
      clearTimeout(deadline);
      clearInterval(memoryWatch);
      void worker.terminate().then(outcome, outcome);
    };
    const abort = (reason: ExtractionAbortReason, message: string) =>
      settle(() => reject(new ExtractionAbortedError(reason, message)));

    const startup = setTimeout(
      () => abort("worker_crash", `The document parser did not start within ${limits.startupTimeoutMs} ms.`),
      limits.startupTimeoutMs,
    );
    let deadline: ReturnType<typeof setTimeout> | undefined;

    // resourceLimits bound only the V8 heap. ArrayBuffers — pdf.js's decode buffers — are external
    // memory it never counts, so they are watched from here, which stays free while the worker runs.
    let polling = false;
    const memoryWatch = setInterval(() => {
      if (polling) return;
      polling = true;
      worker.getHeapStatistics().then(
        (stats) => {
          polling = false;
          if (stats.external_memory > limits.maxExternalMemoryMb * BYTES_PER_MB) {
            abort(
              "memory_limit",
              `Document parsing exceeded the ${limits.maxExternalMemoryMb} MB buffer budget.`,
            );
          }
        },
        () => {
          polling = false;
        },
      );
    }, MEMORY_POLL_MS);

    worker.on("message", (message: ExtractionWorkerMessage) => {
      if (message.kind !== "ready") {
        settle(() => resolve(message));
        return;
      }
      ready = true;
      clearTimeout(startup);
      deadline = setTimeout(
        () => abort("deadline", `Document parsing exceeded the ${limits.deadlineMs} ms deadline.`),
        limits.deadlineMs,
      );
      // The worker starts parsing only on this answer, so every error or exit after it reaches this
      // thread after ready did.
      worker.postMessage({ kind: "parse" });
    });
    worker.once("error", (error: NodeJS.ErrnoException) => {
      if (!ready) abort("worker_crash", "The document parser could not start.");
      else if (error.code === "ERR_WORKER_OUT_OF_MEMORY") {
        abort("heap_limit", `Document parsing exceeded the ${limits.maxOldGenerationSizeMb} MB heap budget.`);
      } else abort("parser_crash", "The document parser stopped unexpectedly.");
    });
    // Exit 0 with no result is a parse whose promise never settled: the document's doing too.
    worker.once("exit", () =>
      ready
        ? abort("parser_crash", "The document parser exited without a result.")
        : abort("worker_crash", "The document parser exited before it started."),
    );
  });
}

let activeParses = 0;
const waitingForSlot: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (activeParses < MAX_CONCURRENT_EXTRACTIONS) {
    activeParses++;
    return;
  }
  await new Promise<void>((resolve) => waitingForSlot.push(resolve));
}

// A freed slot passes straight to the next waiter, so activeParses never undercounts.
function releaseSlot(): void {
  const next = waitingForSlot.shift();
  if (next) next();
  else activeParses--;
}
