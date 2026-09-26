/**
 * A proactive client-side import-caps counter: "Save this chat" disables itself, with an
 * explanatory message, the instant a local thread would exceed the server's own import caps —
 * before POST /api/threads is ever attempted, not only reacting to its 400 (which would otherwise
 * be the first the user hears of a limit they already blew past several messages ago).
 */

import { MAX_IMPORTED_CITATIONS } from "@/shared/contracts/threads";
import type { GuestThread } from "@/lib/guest-thread-store";
import { UNLINKED_SOURCE_DOCUMENT_ID } from "./citation";

export { MAX_IMPORTED_CITATIONS };

/**
 * Mirrors src/server/services/ask.ts's own MAX_IMPORTED_DOCUMENTS — a literal copy, not an import
 * (a client bundle may never pull in server code), pinned equal to the live server constant by
 * tests/unit/lib/guest-threads/caps.test.ts.
 */
export const MAX_IMPORTED_DOCUMENTS = 10;

export interface ImportCapsUsage {
  citations: number;
  documents: number;
}

/**
 * The same aggregate createThread() itself counts before persisting an import: total citations
 * across every message, and distinct documents across the thread's own attachments plus every
 * citation's linked source (the unlinked sentinel never counts as a document).
 */
export function importCapsUsage(thread: GuestThread): ImportCapsUsage {
  let citations = 0;
  const documents = new Set<string>(thread.documentIds);
  for (const message of thread.messages) {
    for (const citation of message.citations) {
      citations++;
      if (citation.sourceDocumentId !== UNLINKED_SOURCE_DOCUMENT_ID) documents.add(citation.sourceDocumentId);
    }
  }
  return { citations, documents: documents.size };
}

export function isWithinImportCaps(thread: GuestThread): boolean {
  const usage = importCapsUsage(thread);
  return usage.citations <= MAX_IMPORTED_CITATIONS && usage.documents <= MAX_IMPORTED_DOCUMENTS;
}
