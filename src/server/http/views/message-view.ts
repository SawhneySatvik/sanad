/**
 * ask.ts's ThreadMessage/AssistantMessage/AskEvent -> the threads contract's wire shape. Every
 * citation's VerifyResult becomes a VerificationOutput bound to its source document — never a raw
 * VerifyResult, never a spanText built here. Every ask.ts output that carries citations also
 * carries a `sources` map (the exact document text/hash/inputMode each linked citation was verified
 * against); `sources` is server-internal and must never reach the wire itself.
 */

import type { ServerInternalCitationSources } from "@/server/data/message-citations";
import type { AskCitation, AskEvent, AssistantMessage, ThreadMessage } from "@/server/services/ask";
import { toVerificationOutput, type VerifiedAgainst } from "../verification";

// sha256("") — the canonicalTextHash a VerifyResult carries when verify() ran against no document
// at all. Any citation whose wire sourceDocumentId is null took that path, so this fixed source is
// always correct for it — never a guess.
const UNLINKED_SOURCE: Omit<VerifiedAgainst, "quote"> = {
  canonicalText: "",
  canonicalTextHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  inputMode: "text",
};

// No top-level `quote`/model-text field: `citation.quote` is used only to compute `verification`,
// never returned itself. The model's own phrasing is reachable only through `claimedQuote`.
function citationView(citation: AskCitation, sources: ServerInternalCitationSources) {
  const source = (citation.sourceDocumentId !== null ? sources.get(citation.sourceDocumentId) : undefined) ?? UNLINKED_SOURCE;
  return {
    id: citation.id,
    sourceDocumentId: citation.sourceDocumentId,
    verification: toVerificationOutput(citation.verification, { quote: citation.quote, ...source }),
  };
}

/** Maps an AssistantMessage to the wire shape; every assistant message's content is model-produced. */
export function assistantMessageView(message: AssistantMessage, sources: ServerInternalCitationSources) {
  const base = {
    id: message.id,
    role: "assistant" as const,
    content: message.content,
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

/**
 * Relays an ask() stream through the wire's event shape: token and error events pass through
 * unchanged (sse.ts intercepts an error event before any event contract sees it); only the final
 * event's AssistantMessage is mapped, bound to that same event's own `sources`.
 */
export async function* askEventView(events: AsyncGenerator<AskEvent>) {
  for await (const event of events) {
    yield event.type === "final" ? { type: "final" as const, message: assistantMessageView(event.message, event.sources) } : event;
  }
}
