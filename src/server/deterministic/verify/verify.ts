import { createHash } from "node:crypto";
import { AppError } from "@/server/core/errors";
import type { InputMode, VerificationStatus } from "@/server/core/types";
import { MAX_EXTRACTED_CHARS } from "@/server/deterministic/extract/constants";
import { findApproximate, indexTokens, quoteTokenIds, type TokenIndex } from "./approximate";
import { findExact } from "./exact";
import { buildMatchText, normalizeForMatch, type MatchText } from "./normalize";

/**
 * Deterministic quote verification: decides whether a quote occurs in a document's canonical text,
 * and where. Only this module can issue a VerifyResult; every persisted status must come from one.
 * Every status write path calls assertVerifyResultFor() with the row's own quote and the document's
 * canonical text hash and input mode before persisting, then reads status/spans/version only from
 * the result. Prefer verifyMany() for several quotes: it normalizes the document once (~0.16 s vs
 * ~1.9 s, 50 quotes, 500k chars).
 */

/** Stored with every status. Bump on any change to normalization, boundaries, thresholds or caps. */
export const VERIFIER_VERSION = "2.0.0";

/** Longer quotes are not_found without matching; the verify-batch route reuses it as its input limit. */
export const MAX_QUOTE_CHARS = 4_000;

/** The same cap extraction enforces, so every ingestible document is verifiable. */
export const MAX_CANONICAL_TEXT_CHARS = MAX_EXTRACTED_CHARS;

/**
 * verifyMany blocks the event loop for its whole batch: measured 13-25 ms per quote on adversarial
 * 500k-char text, so up to ~1.3 s for a full batch.
 */
export const MAX_QUOTES_PER_CALL = 50;

// Module-private: without it the constructor throws, so neither `new result.constructor(...)` nor
// `class extends result.constructor` can mint a result.
const ISSUE = Symbol("verify/issue");

// The brand: an ECMAScript #private field makes this class nominal to TypeScript, so an object
// literal or a spread of a real result is a compile error — a `unique symbol` property alone
// wouldn't stop the spread. Not exported; every construction site is in this file.
class IssuedVerifyResult {
  readonly #issuedByVerify = true;

  constructor(
    token: symbol,
    readonly status: VerificationStatus,
    readonly spanStart: number | null,
    readonly spanEnd: number | null,
    // The exact quote checked, the sha256 of the canonicalText it was checked against, and the
    // inputMode — what assertVerifyResultFor() binds the result to.
    readonly quote: string,
    readonly canonicalTextHash: string,
    readonly inputMode: InputMode,
    readonly verifierVersion: string,
  ) {
    if (token !== ISSUE) throw new Error("A VerifyResult can only be issued by verify()");
    Object.freeze(this);
  }

  static isIssued(value: unknown): boolean {
    return typeof value === "object" && value !== null && #issuedByVerify in value;
  }
}

/**
 * The result of a verify() call. `spanStart`/`spanEnd` are offsets into the original canonicalText;
 * always render canonicalText.slice(spanStart, spanEnd), never the quote itself.
 */
export type VerifyResult = IssuedVerifyResult &
  (
    | { readonly status: "verified" | "approximate"; readonly spanStart: number; readonly spanEnd: number }
    | { readonly status: "not_found"; readonly spanStart: null; readonly spanEnd: null }
  );

/**
 * Runtime backstop for a VerifyResult received across a cast (a DB row or JSON forced through `as
 * VerifyResult`): only objects this module constructed pass. Never replace with instanceof — a
 * subclass or Object.create(prototype) would pass that.
 */
export function isVerifyResult(value: unknown): value is VerifyResult {
  return IssuedVerifyResult.isIssued(value);
}

/**
 * Binds a VerifyResult to the row it may be persisted for — `canonicalTextHash` and `inputMode` must
 * be that row's own `canonical_text_hash` and `input_mode` — preventing a result from being attached
 * to the wrong finding or a `verified` computed for a different document from being persisted.
 * @throws Error when `result` wasn't issued by verify(), or for a different quote, text, or input mode.
 */
export function assertVerifyResultFor(
  result: unknown,
  expected: { quote: string; canonicalTextHash: string; inputMode: InputMode },
): asserts result is VerifyResult {
  if (!isVerifyResult(result)) throw new Error("Not a VerifyResult issued by verify()");
  if (
    result.quote !== expected.quote ||
    result.canonicalTextHash !== expected.canonicalTextHash ||
    result.inputMode !== expected.inputMode
  ) {
    throw new Error("VerifyResult was computed for a different quote or document");
  }
}

type PreparedText = {
  readonly original: string;
  readonly hash: string;
  readonly match: MatchText | null; // null → every quote is not_found
  tokens: TokenIndex | null; // built on the first quote that needs the approximate path
};

function prepare(canonicalText: string): PreparedText {
  if (typeof canonicalText !== "string") return { original: "", hash: "", match: null, tokens: null };
  const hash = createHash("sha256").update(canonicalText, "utf8").digest("hex");
  if (canonicalText.length === 0 || canonicalText.length > MAX_CANONICAL_TEXT_CHARS) {
    return { original: canonicalText, hash, match: null, tokens: null };
  }
  return { original: canonicalText, hash, match: buildMatchText(canonicalText), tokens: null };
}

function verifyPrepared(quote: string, doc: PreparedText, inputMode: InputMode): VerifyResult {
  const checkedQuote = typeof quote === "string" ? quote : "";
  const issue = (status: VerificationStatus, spanStart: number | null, spanEnd: number | null) =>
    new IssuedVerifyResult(ISSUE, status, spanStart, spanEnd, checkedQuote, doc.hash, inputMode, VERIFIER_VERSION) as VerifyResult;

  if (doc.match === null || typeof quote !== "string" || quote.length > MAX_QUOTE_CHARS) {
    return issue("not_found", null, null);
  }
  const needle = normalizeForMatch(quote);
  if (needle.length === 0) return issue("not_found", null, null);

  const exact = findExact(needle, doc.original, doc.match);
  if (exact !== null) {
    // Only exactly "text" may verify; a native_document (scanned/image) document — or any value a
    // caller smuggled past the type — caps at approximate, enforced here rather than trusted upstream.
    return issue(inputMode === "text" ? "verified" : "approximate", exact.spanStart, exact.spanEnd);
  }

  doc.tokens ??= indexTokens(doc.match.text);
  const { match } = findApproximate(quoteTokenIds(needle, doc.tokens.vocab), doc.tokens);
  if (match === null) return issue("not_found", null, null);
  const { unitOf, unitBoundary } = doc.match;
  const normStart = doc.tokens.normStart[match.startToken];
  const normEnd = doc.tokens.normEnd[match.endToken - 1];
  return issue("approximate", unitBoundary[unitOf[normStart]], unitBoundary[unitOf[normEnd - 1] + 1]);
}

/** Input to {@link verify}: the claimed quote, the document's canonical text, and its input mode. */
export type VerifyInput = {
  readonly quote: string;
  readonly canonicalText: string;
  readonly inputMode: InputMode;
};

/**
 * Checks whether `quote` occurs in `canonicalText`, and where. Never throws on string input. Rules,
 * in order: canonicalText empty, over MAX_CANONICAL_TEXT_CHARS, or not a string is not_found; quote
 * over MAX_QUOTE_CHARS, not a string, or empty after normalization is not_found; a normalized quote
 * found in normalized canonicalText, at the first occurrence that sits on token boundaries, is
 * verified (or approximate unless inputMode is exactly "text"); otherwise the bounded token matcher
 * in approximate.ts (3–200 word tokens, token similarity >= 0.8) yields approximate or not_found.
 * @example
 * const result = verify({ quote: "30 days notice", canonicalText, inputMode: "text" });
 * if (result.status === "verified") {
 *   render(canonicalText.slice(result.spanStart, result.spanEnd)); // never the claimed quote
 * }
 */
export function verify({ quote, canonicalText, inputMode }: VerifyInput): VerifyResult {
  return verifyPrepared(quote, prepare(canonicalText), inputMode);
}

/**
 * The same result as calling {@link verify} once per quote, but canonicalText is normalized, hashed
 * and tokenized only once.
 * @throws AppError VALIDATION_FAILED when `quotes.length` exceeds {@link MAX_QUOTES_PER_CALL}.
 */
export function verifyMany(
  quotes: readonly string[],
  canonicalText: string,
  inputMode: InputMode,
): VerifyResult[] {
  if (quotes.length > MAX_QUOTES_PER_CALL) {
    throw new AppError(
      "VALIDATION_FAILED",
      `verifyMany accepts at most ${MAX_QUOTES_PER_CALL} quotes per call; got ${quotes.length}.`,
    );
  }
  const doc = prepare(canonicalText);
  return quotes.map((quote) => verifyPrepared(quote, doc, inputMode));
}
