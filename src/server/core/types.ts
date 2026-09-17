/** Shared, dependency-free vocabulary used across every layer; kept small and stable so any layer can import it freely. */

/** The one authorization principal shape. A future principal type (team member, API key) is added here, not re-derived at each call site. */
export type Principal =
  | { type: "user"; userId: string }
  | { type: "guest"; guestSessionId: string };

/**
 * How a document's canonical text was produced: `text` for server-side extraction, `native_document`
 * for a scanned/image PDF transcribed via multimodal OCR — verify() caps these at approximate/not_found,
 * never verified. Derived from this array so the type can never gain a member the array lacks.
 */
export const INPUT_MODES = ["text", "native_document"] as const;
/** One of INPUT_MODES. */
export type InputMode = (typeof INPUT_MODES)[number];

/**
 * verify()'s status vocabulary. A plain string union — persistence write paths accept only the
 * branded VerifyResult type, never this bare string, so a status can't be forged by constructing
 * the string directly.
 */
export const VERIFICATION_STATUSES = ["verified", "approximate", "not_found"] as const;
/** One of VERIFICATION_STATUSES. */
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** The finding categories used throughout the app. Deliberately no severity axis. */
export const DOCUMENT_CATEGORIES = [
  "obligation",
  "deadline",
  "penalty",
  "ambiguity",
  "missing_clause",
] as const;
/** One of DOCUMENT_CATEGORIES. */
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];
