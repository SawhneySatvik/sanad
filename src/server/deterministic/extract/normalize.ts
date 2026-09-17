import { AppError } from "@/server/core/errors";
import { MAX_COMBINING_MARK_RUN, MAX_EXTRACTED_CHARS } from "./constants";

// Vertical tab, form feed, NEL, LINE/PARAGRAPH SEPARATOR — mapped to a newline below. Built from
// code points so the source never contains U+2028/U+2029 raw (a syntax error inside a regex literal).
const LINE_BREAK_LIKE_CODEPOINTS = [0x0b, 0x0c, 0x85, 0x2028, 0x2029];
const LINE_BREAK_LIKE_RE = new RegExp(
  `[${LINE_BREAK_LIKE_CODEPOINTS.map((codePoint) => String.fromCharCode(codePoint)).join("")}]`,
  "g",
);

// Bidi embeddings, overrides, isolates and directional marks (U+202A-202E, U+2066-2069,
// U+200E/200F, U+061C) — stripped below. Rendered, each can reorder the characters around it, so a
// UI would display something other than the text verify() matched (an override turns a verified "03"
// into a displayed "30"). Built from code points so the source never contains one raw.
const BIDI_CONTROL_CODEPOINTS = [
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x061c,
];
const BIDI_CONTROL_RE = new RegExp(
  `[${BIDI_CONTROL_CODEPOINTS.map((codePoint) => String.fromCharCode(codePoint)).join("")}]`,
  "g",
);

/**
 * Normalizes extracted or pasted text into canonical text: strips a leading BOM, unifies line
 * endings, removes stray control and bidi-control characters, applies Unicode NFC, and collapses
 * horizontal whitespace and blank-line runs. Idempotent: normalizeText(normalizeText(x)) ===
 * normalizeText(x).
 * Left untouched on purpose — verify()'s own independent normalization folds these when matching a
 * quote — are non-ASCII Unicode space separators and single newlines, which stay real line breaks.
 * @throws AppError INVALID_DOCUMENT for oversized input or an excessively long combining-mark run.
 */
export function normalizeText(input: string): string {
  // Runs first: makes the text well-formed UTF-16 before the cap checks below, so two inputs
  // differing only in which lone surrogate they contain can't share a hash while their text still differs.
  let text = input.toWellFormed();

  // Cheap pre-check before any expensive normalization step; extract/index.ts's finalizeText
  // re-checks the final joined text.
  if (text.length > MAX_EXTRACTED_CHARS) {
    throw new AppError(
      "INVALID_DOCUMENT",
      `Document exceeds the ${MAX_EXTRACTED_CHARS}-character size cap.`,
      { reason: "too_large" },
    );
  }

  // Strip a leading BOM (U+FEFF) some extractors/editors emit at file start.
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  // Line endings: CRLF and lone CR both become LF.
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Must run before the control-character strip below: stripping vertical-tab/form-feed outright,
  // rather than mapping them to a line break first, glues adjacent words together across the break.
  text = text.replace(LINE_BREAK_LIKE_RE, "\n");

  // Strip stray C0 control characters (keep \n and \t), DEL and bidi controls. Must run before NFC
  // below: a control character between a base letter and a combining mark blocks composition,
  // breaking idempotency if stripped after.
  text = text.replace(/[\x00-\x08\x0E-\x1F\x7F]/g, "").replace(BIDI_CONTROL_RE, "");

  // Must run before .normalize("NFC") below, which is near-quadratic on a single combining-mark run
  // (a 400,001-character run took over a minute; this guard rejects it in single-digit milliseconds),
  // and after the strip above, which would otherwise rejoin runs a control character had split.
  if (new RegExp(`\\p{M}{${MAX_COMBINING_MARK_RUN + 1},}`, "u").test(text)) {
    // Same resource-abuse shape as the char cap above (a near-quadratic .normalize("NFC") cost),
    // so it shares that reason rather than a new one.
    throw new AppError(
      "INVALID_DOCUMENT",
      "Document contains an excessively long run of combining characters.",
      { reason: "too_large" },
    );
  }

  // Unicode NFC: a fixed point (re-normalizing already-NFC text is a no-op) — load-bearing for idempotency.
  text = text.normalize("NFC");

  // Collapses runs of spaces/tabs to one space; ASCII-only, NBSP and the rest of the Unicode
  // space-separator class are left as-is (see the module doc comment above).
  text = text.replace(/[ \t]+/g, " ");

  // Trim trailing horizontal whitespace at each line end.
  text = text.replace(/[ \t]+\n/g, "\n");

  // Collapses 3+ consecutive newlines to one blank line — preserves the paragraph/clause breaks
  // segment.ts relies on.
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}
