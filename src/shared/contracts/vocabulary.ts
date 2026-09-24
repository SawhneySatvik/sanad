// Client contracts mirror these small enums without loading server modules into the browser bundle.
export const DOCUMENT_CATEGORIES = ["obligation", "deadline", "penalty", "ambiguity", "missing_clause"] as const;
export const INPUT_MODES = ["text", "native_document"] as const;
export const APP_ERROR_CODES = [
  "NOT_FOUND", "VALIDATION_FAILED", "RATE_LIMITED", "UPSTREAM_UNAVAILABLE", "TIMEOUT",
  "INVALID_DOCUMENT", "EXTRACTION_FAILED", "SCHEMA_FAILED",
] as const;
export const ERROR_REASONS = [
  "too_large", "unsupported_type", "type_mismatch", "unreadable", "empty", "document_not_ready",
  "grounding_not_ready", "grounding_too_long", "sample_readonly",
] as const;
