import { BIDI_ISOLATE_STYLE } from "@/lib/verification/bidi-isolate";
import type { VerificationOutput } from "@/shared/contracts/common";
import { VerificationBadge } from "./verification-badge";

export interface QuoteBlockProps {
  verification: VerificationOutput;
  /** Omitted while the document's own text query hasn't resolved yet — defaults to the "text"
   * (no special-casing) behaviour below, never the native_document one, since an unresolved mode
   * is not evidence this is a scanned document. */
  inputMode?: "text" | "native_document";
}

// A native_document quote that comes back approximate because it EQUALS the displayed span is
// never really "approximate for a reason" — verify() caps every native_document match at
// approximate regardless of how exact the transcription is, so this is display only, telling the
// reader why the two lines they'd otherwise see would be identical, never a second status decision.
const SCANNED_EQUAL_QUOTE_NOTE = "Read from a scanned image, so exact matches show as approximate.";

/**
 * The quoted passage: spanText for verified/approximate, claimedQuote (labelled, never hidden) for
 * approximate/not_found. Plain text only — never dangerouslySetInnerHTML. spanText is cut from raw
 * canonical_text (never sanitizeModelText()'d, so bindSpan()'s slice check stays byte-exact) and so
 * may still carry a bidi control character the source document itself contained; isolating it here
 * keeps a hostile override from reordering this block's own siblings. Set in the reading face, with
 * a gold left rule matching its own highlight in the document.
 */
export function QuoteBlock({ verification, inputMode }: QuoteBlockProps) {
  const isScannedDuplicate =
    inputMode === "native_document" && verification.status === "approximate" && verification.claimedQuote === verification.spanText;

  return (
    <blockquote className="flex flex-col items-start gap-2 border-l-2 border-mark-underline pl-3 font-reading text-sm text-foreground">
      <VerificationBadge verification={verification} />
      {verification.status !== "not_found" && (
        <p>
          <bdi style={BIDI_ISOLATE_STYLE}>{verification.spanText}</bdi>
        </p>
      )}
      {verification.status === "approximate" && isScannedDuplicate && <p className="text-muted-foreground">{SCANNED_EQUAL_QUOTE_NOTE}</p>}
      {verification.status === "approximate" && !isScannedDuplicate && (
        <p className="text-muted-foreground">
          <span className="font-medium">{"The model's claimed quote: "}</span>
          {verification.claimedQuote}
        </p>
      )}
      {verification.status === "not_found" && (
        <p className="text-muted-foreground">
          <span className="font-medium">Not found in your document: </span>
          {verification.claimedQuote}
        </p>
      )}
    </blockquote>
  );
}
