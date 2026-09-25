/**
 * ask.ts's ThreadMessage/AssistantMessage/AskEvent -> the threads contract's wire shape. Every
 * citation's VerifyResult becomes a VerificationOutput bound to its source document — never a raw
 * VerifyResult, never a spanText built here. Every ask.ts output that carries citations also
 * carries a `sources` map (the exact document text/hash/inputMode each linked citation was verified
 * against); `sources` is server-internal and must never reach the wire itself. Model-authored
 * content is sanitized at this output boundary — both a saved message's replayed content and a
 * streamed token's text — since neither passes through toVerificationOutput.
 */

import { sanitizeModelText } from "@/server/deterministic/sanitize/model-text";
import type { ServerInternalCitationSources } from "@/server/data/message-citations";
import type { AskCitation, AskEvent, AssistantMessage, ThreadMessage } from "@/server/services/ask";
import { toVerificationOutput, type VerifiedAgainst } from "../verification";

// sha256("") — the canonicalTextHash a VerifyResult carries when verify() ran against no document
// at all. Any citation whose wire sourceDocumentId is null took that path, so this fixed source is
// always correct for it — never a guess. Only for binding verify() against; the wire's own
// `inputMode` is null for an unlinked citation (there is no real document's mode to report), never
// this fixed "text" — see citationView below.
const UNLINKED_SOURCE: Omit<VerifiedAgainst, "quote"> = {
  canonicalText: "",
  canonicalTextHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  inputMode: "text",
};

// No top-level `quote`/model-text field: `citation.quote` is used only to compute `verification`,
// never returned itself. The model's own phrasing is reachable only through `claimedQuote`.
function citationView(citation: AskCitation, sources: ServerInternalCitationSources) {
  const resolved = citation.sourceDocumentId !== null ? sources.get(citation.sourceDocumentId) : undefined;
  const source = resolved ?? UNLINKED_SOURCE;
  return {
    id: citation.id,
    sourceDocumentId: citation.sourceDocumentId,
    inputMode: resolved?.inputMode ?? null,
    verification: toVerificationOutput(citation.verification, { quote: citation.quote, ...source }),
  };
}

/** Maps an AssistantMessage to the wire shape; every assistant message's content is model-produced. */
export function assistantMessageView(message: AssistantMessage, sources: ServerInternalCitationSources) {
  const base = {
    id: message.id,
    role: "assistant" as const,
    content: sanitizeModelText(message.content),
    provenance: "ai_generated" as const,
    modelUsed: message.modelUsed,
    routedDomains: message.routedDomains,
    createdAt: message.createdAt,
  };
  if (message.mode === "general") {
    return { ...base, mode: "general" as const, redirect: message.redirect, label: message.label };
  }
  return { ...base, mode: "grounded" as const, citations: message.citations.map((citation) => citationView(citation, sources)) };
}

/** Maps one thread message (user or assistant) to the wire shape. */
export function threadMessageView(message: ThreadMessage, sources: ServerInternalCitationSources) {
  if (message.role === "user") {
    return { id: message.id, role: "user" as const, content: message.content, createdAt: message.createdAt };
  }
  return assistantMessageView(message, sources);
}

// True for a lone UTF-16 high surrogate at the very end of a chunk — the boundary a provider's own
// token split can land a badge glyph across (several BADGE_GLYPHS are astral, so a two-code-unit
// pair). Sanitizing each chunk in isolation would miss a glyph split this way, since neither half
// alone matches the sanitizer's pattern.
function endsWithLoneHighSurrogate(text: string): boolean {
  const code = text.charCodeAt(text.length - 1);
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Relays an ask() stream through the wire's event shape: an error event passes through unchanged
 * (sse.ts intercepts one before any event contract sees it); a token event's text is sanitized the
 * same as a saved message's content — the client renders it as it arrives, before any final
 * sanitizing pass exists to catch it. A trailing lone high surrogate is held back to the next token
 * rather than sanitized (and possibly emitted) mid-pair, and — since a stream never sends a token
 * after its final event — is flushed before `final` itself, never after. A token whose sanitized
 * text is empty is never emitted at all, held-surrogate-only chunks included.
 */
export async function* askEventView(events: AsyncGenerator<AskEvent>) {
  let heldHighSurrogate = "";
  for await (const event of events) {
    if (event.type === "token") {
      const text = heldHighSurrogate + event.text;
      let sanitized: string;
      if (endsWithLoneHighSurrogate(text)) {
        heldHighSurrogate = text.slice(-1);
        sanitized = sanitizeModelText(text.slice(0, -1));
      } else {
        heldHighSurrogate = "";
        sanitized = sanitizeModelText(text);
      }
      if (sanitized) yield { type: "token" as const, text: sanitized };
    } else if (event.type === "final") {
      if (heldHighSurrogate) {
        yield { type: "token" as const, text: heldHighSurrogate };
        heldHighSurrogate = "";
      }
      yield { type: "final" as const, message: assistantMessageView(event.message, event.sources) };
    } else {
      yield event;
    }
  }
  // The stream ended mid-pair with no final event at all (an abort): a bare surrogate is not a real
  // badge glyph either way, so it is safe to flush rather than silently drop.
  if (heldHighSurrogate) yield { type: "token" as const, text: heldHighSurrogate };
}
