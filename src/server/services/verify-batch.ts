/**
 * verify-batch service. A reopened guest thread sends back its citations and gets a fresh
 * verify() result for each, in request order; the client's cached status is never an input.
 *
 * Principal-scoped, never a content oracle: ownership is checked before any text is read, and a
 * document the caller can't use gets verify() against empty text — not_found for every quote, with
 * no error and no reason. Every successful response takes at least MIN_RESPONSE_MS, so timing can't
 * tell the two cases apart either; a batch over a cap is rejected at once, before any read.
 */

import { createHash } from "node:crypto";
import { setImmediate as nextTurnOfEventLoop, setTimeout as sleep } from "node:timers/promises";
import type { Db } from "../../db/client";
import { AppError } from "../core/errors";
import type { InputMode, Principal } from "../core/types";
import { MAX_QUOTE_CHARS, MAX_QUOTES_PER_CALL, verifyMany, type VerifyResult } from "../deterministic/verify";
import { getDocument } from "../data/documents";

/**
 * Caps. src/shared/contracts/verify-batch.ts repeats these numbers (its own test pins them to
 * these): MAX_BATCH_CITATIONS is one verifyMany() call's worth, so no request blocks the event loop
 * for longer than one such call; MAX_BATCH_DOCUMENTS is the most documents one Ask turn can ground.
 * The costliest batches these caps allow are an adversarial caller's own large, periodic document
 * against near-miss quotes, forcing every boundary check to its cap — measured at about 1.3 s CPU
 * per request, about 1.3 cores per client IP at the IP tier's 60 requests/minute.
 */
export const MAX_BATCH_CITATIONS = MAX_QUOTES_PER_CALL;
/** The most documents one Ask turn can ground. */
export const MAX_BATCH_DOCUMENTS = 5;
export { MAX_QUOTE_CHARS };

/**
 * Ordinary citations measured 22-67 ms even at 100 quotes (twice the cap); this floor covers that
 * with margin, though not an adversarial batch, whose excess over the floor is the caller's own
 * work. Sleeping costs no CPU, unlike running verify() against a decoy text of matching size. A
 * residual timing difference remains (a foreign id's ownership lookup returns a row where a
 * missing id's returns none, ~0.2 ms in PGlite, below network jitter).
 */
export const MIN_RESPONSE_MS = 200;

/** Dependencies run() needs. */
export interface VerifyBatchDeps {
  db: Db;
}

/** One client-claimed citation to re-verify. */
export interface CitationToVerify {
  documentId: string;
  quote: string;
}

/** Input to run(): the batch of citations to re-verify, in request order. */
export interface VerifyBatchInput {
  citations: readonly CitationToVerify[];
}

/**
 * What a verification was computed against: the view binds the result to it and cuts spanText
 * from it (src/server/http/verification.ts).
 */
export interface VerifiedAgainstText {
  canonicalText: string;
  canonicalTextHash: string;
  inputMode: InputMode;
}

/** One citation's fresh verification result, with the text it was computed against. */
export interface BatchVerification {
  quote: string;
  verification: VerifyResult;
  source: VerifiedAgainstText;
}

/** run()'s return shape: results[i] answers input.citations[i]. */
export interface VerifyBatchResult {
  results: BatchVerification[];
}

// For a document the caller can't use. Its hash is computed here, not copied from a result, so the
// view's binding check still compares two independent values.
const NO_TEXT: VerifiedAgainstText = {
  canonicalText: "",
  canonicalTextHash: createHash("sha256").update("", "utf8").digest("hex"),
  inputMode: "text",
};

/** Re-verifies a batch of client-claimed citations against each cited document's live text, in request order. */
export async function run(deps: VerifyBatchDeps, principal: Principal, input: VerifyBatchInput): Promise<VerifyBatchResult> {
  assertWithinCaps(input.citations); // before any read or verify() — an oversized batch costs nothing
  const started = performance.now();

  // Grouped by document id in first-appearance order: each distinct id is read once and all of its
  // quotes are verified against that one read. Ids are compared as sent, so an id that repeats in a
  // different letter case is read (and capped) as a second document, with the same answers.
  const positionsByDocument = new Map<string, number[]>();
  input.citations.forEach(({ documentId }, i) => {
    positionsByDocument.set(documentId, [...(positionsByDocument.get(documentId) ?? []), i]);
  });

  const results: BatchVerification[] = new Array(input.citations.length);
  for (const [documentId, positions] of positionsByDocument) {
    const source = (await readUsableText(deps.db, principal, documentId)) ?? NO_TEXT;
    const quotes = positions.map((i) => input.citations[i].quote);
    // verifyMany blocks the event loop for its whole call. The read above is no guarantee of a
    // turn in between (in-process PGlite settles in microtasks; a malformed id makes no query), so
    // without this every document's verify would run back to back as one block for other requests.
    await nextTurnOfEventLoop();
    // One call per document: the batch cap is one call's worth. The document's own inputMode goes
    // in, so native_document text caps at approximate.
    const verifications = verifyMany(quotes, source.canonicalText, source.inputMode);
    positions.forEach((position, k) => {
      results[position] = { quote: quotes[k], verification: verifications[k], source };
    });
  }

  // Re-measured after each sleep: a timer can fire a millisecond or two early against
  // performance.now(), and the floor is a guarantee, not an approximation.
  let remaining = MIN_RESPONSE_MS - (performance.now() - started);
  while (remaining > 0) {
    await sleep(Math.ceil(remaining));
    remaining = MIN_RESPONSE_MS - (performance.now() - started);
  }
  return { results };
}

function assertWithinCaps(citations: readonly CitationToVerify[]): void {
  if (citations.length > MAX_BATCH_CITATIONS) {
    throw invalid(`A batch can verify at most ${MAX_BATCH_CITATIONS} citations.`);
  }
  if (citations.some(({ quote }) => quote.length > MAX_QUOTE_CHARS)) {
    throw invalid(`A quote is at most ${MAX_QUOTE_CHARS} characters.`);
  }
  if (new Set(citations.map(({ documentId }) => documentId)).size > MAX_BATCH_DOCUMENTS) {
    throw invalid(`A batch can cite at most ${MAX_BATCH_DOCUMENTS} documents.`);
  }
}

function invalid(message: string): AppError {
  return new AppError("VALIDATION_FAILED", message);
}

// The document's live text, or null when the caller can't use it. getDocument checks ownership on
// the summary before selecting canonical_text, so a foreign row's text is never read.
async function readUsableText(db: Db, principal: Principal, documentId: string): Promise<VerifiedAgainstText | null> {
  const document = await nullIfNotFound(getDocument(db, principal, documentId));
  if (document === null) return null;
  const { processingStatus, expiresAt, canonicalText, canonicalTextHash, inputMode } = document;
  // An expired document's citations are not_found, never a stale verified — even before the TTL
  // job has deleted the row.
  const expired = expiresAt !== null && expiresAt.getTime() <= Date.now();
  if (processingStatus !== "ready" || expired || canonicalText === null || canonicalTextHash === null || inputMode === null) {
    return null;
  }
  return { canonicalText, canonicalTextHash, inputMode };
}

// Missing, malformed and foreign ids are all the repository's NOT_FOUND; anything else is a real
// failure and propagates.
async function nullIfNotFound<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") return null;
    throw error;
  }
}
