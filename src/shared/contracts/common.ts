/**
 * Conventions every route contract follows. Request schemas are z.strictObject, so a client-sent
 * `status`, span or `canonicalText` is rejected outright. Response schemas are z.object, stripping
 * undeclared keys, so a field reaches the client only if a contract names it. Path ids validated
 * with IdParams map a malformed id to the same 404 a missing or foreign one gets, never a 400.
 * Contracts import only dependency-free vocabulary — nothing that pulls in server code.
 */

import { z } from "zod";
import { APP_ERROR_CODES, ERROR_REASONS } from "./vocabulary";

/** Returned for any failure that is not a typed AppError. Never carries the underlying message. */
export const INTERNAL_ERROR_CODE = "INTERNAL_ERROR";

/**
 * Code for a cross-site state-changing request — refused before identity or resource is looked
 * at, so it says nothing about either.
 */
export const FORBIDDEN_CODE = "FORBIDDEN";

// `message` is a fixed, per-code string, never an Error#message. `documentId` is set only when
// POST /api/documents fails after the caller's document row exists — the id to retry with. `reason`
// is set only on INVALID_DOCUMENT/EXTRACTION_FAILED; `retryAfterSeconds` mirrors the Retry-After
// header, rounded up and omitted when it would be zero or negative.
/** The body of every JSON error response and SSE error frame. */
export const ErrorBody = z.object({
  error: z.object({
    code: z.enum([...APP_ERROR_CODES, INTERNAL_ERROR_CODE, FORBIDDEN_CODE]),
    message: z.string(),
    reason: z.enum(ERROR_REASONS).optional(),
    retryAfterSeconds: z.number().optional(),
    documentId: z.guid().optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

/** Path params for every `:id` route; a malformed id fails to parse, mapped to the same 404 a missing/foreign one gets. */
export const IdParams = z.strictObject({ id: z.guid() });
export type IdParams = z.infer<typeof IdParams>;

/** ISO 8601 datetime string, the wire format every timestamp uses. */
export const IsoDateTime = z.iso.datetime();

/**
 * How every route shows a quote's verification — findings, citations, comparison changes alike.
 * Never a VerifyResult serialized whole: build it with toVerificationOutput, which binds the result
 * to its document. spanText is cut server-side from the exact text verify() ran against — the only
 * text a client may display as the document's passage. The model's own claimed quote appears only
 * as claimedQuote, on approximate/not_found; a verified passage carries no model text at all.
 * textHash is the source document's canonical_text_hash on every branch — the caller's own usable
 * document's real hash, or the fixed sha256("") sentinel when there is no real document to bind to
 * (an unlinked citation, a foreign id, a deleted source) — so bindSpan() can refuse a mark bound
 * against the wrong document without a second, per-surface textHash field.
 */
export const VerificationOutput = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("verified"),
    spanStart: z.number().int().nonnegative(),
    spanEnd: z.number().int().nonnegative(),
    spanText: z.string(),
    verifierVersion: z.string(),
    textHash: z.string(),
  }),
  z.object({
    status: z.literal("approximate"),
    spanStart: z.number().int().nonnegative(),
    spanEnd: z.number().int().nonnegative(),
    spanText: z.string(),
    claimedQuote: z.string(),
    verifierVersion: z.string(),
    textHash: z.string(),
  }),
  z.object({
    status: z.literal("not_found"),
    spanStart: z.null(),
    spanEnd: z.null(),
    spanText: z.null(),
    claimedQuote: z.string(),
    verifierVersion: z.string(),
    textHash: z.string(),
  }),
]);
export type VerificationOutput = z.infer<typeof VerificationOutput>;
