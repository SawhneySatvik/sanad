// Every Ask output that carries citations also carries its server-internal `sources` — once per
// cited document, exactly the text/hash/inputMode its VerifyResult was computed against, so
// toVerificationOutput can re-assert the binding and cut spanText server-side.

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Document } from "@/server/data/documents";
import { insertCitations, MAX_VERIFIED_CITATIONS_PER_READ, type ServerInternalCitationSources } from "@/server/data/message-citations";
import { appendMessage } from "@/server/data/messages";
import { verifyMany } from "@/server/deterministic/verify";
import { toVerificationOutput } from "@/server/http/verification";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { ask, createThread, listRecentMessages, type AskCitation, type AskEvent, type ThreadMessage } from "@/server/services/ask";
import { answer, collect, createAskHarness, GENERAL_QUERY, GROUNDED_QUERY, guestA, LEASE, QUOTES, userA, userB, type AskHarness } from "@tests/support/services/ask";

const PET_CLAUSE = "The Licensee shall keep a pet only with the Licensor's written consent";
// In LEASE's header, never quoted below: if a whole document were serialized, this would show.
const UNQUOTED_TEXT = "Anjali Deshmukh";
// verify() against no document at all (message-citations.ts's unlinked path).
const UNLINKED_SOURCE = { canonicalText: "", canonicalTextHash: createHash("sha256").update("", "utf8").digest("hex"), inputMode: "text" as const };

let h: AskHarness;
let docA: Document;
let docB: Document;

beforeEach(async () => {
  h = await createAskHarness();
  docA = await h.document(userA);
  docB = await h.document(userA, `${LEASE}\n5. ${PET_CLAUSE}.`);
});
afterEach(() => h.close());

function citationsOf(messages: readonly ThreadMessage[]): AskCitation[] {
  return messages.flatMap((m) => (m.role === "assistant" && m.mode === "grounded" ? m.citations : []));
}

function finalOf(events: readonly AskEvent[]) {
  const final = events.find((event) => event.type === "final");
  if (final?.type !== "final") throw new Error(`no final event: ${JSON.stringify(events.map((e) => e.type))}`);
  return final;
}

// `sources` has exactly the documents the linked citations cite, each equal to that document's
// stored text/hash/mode; every citation binds through the route's toVerificationOutput, and a span
// is cut from exactly that text. Returns the number of linked citations bound.
function assertBound(citations: readonly AskCitation[], sources: ServerInternalCitationSources, documents: readonly Document[]): number {
  const linked = citations.filter((c) => c.sourceDocumentId !== null);
  expect([...sources.keys()].sort()).toEqual([...new Set(linked.map((c) => c.sourceDocumentId!))].sort());
  for (const [id, source] of sources) {
    const document = documents.find((d) => d.id === id)!;
    expect(source).toEqual({ canonicalText: document.canonicalText, canonicalTextHash: document.canonicalTextHash, inputMode: document.inputMode });
  }
  for (const citation of citations) {
    const source = citation.sourceDocumentId === null ? UNLINKED_SOURCE : sources.get(citation.sourceDocumentId)!;
    const out = toVerificationOutput(citation.verification, { quote: citation.quote, ...source });
    expect(out.status).toBe(citation.verification.status);
    if (out.spanStart !== null) expect(out.spanText).toBe(source.canonicalText.slice(out.spanStart, out.spanEnd));
  }
  return linked.length;
}

function spanTextOf(citation: AskCitation, sources: ServerInternalCitationSources): string | null {
  return toVerificationOutput(citation.verification, { quote: citation.quote, ...sources.get(citation.sourceDocumentId!)! }).spanText;
}

describe("ask() final event", () => {
  it("unsaved turn: sources = only the cited document (an attached, uncited one is absent); every citation binds", async () => {
    const guestDocA = await h.document(guestA);
    const guestDocB = await h.document(guestA, `${LEASE}\n5. ${PET_CLAUSE}.`);
    const llm = new FakeLlmClient({
      defaultResponse: answer("x", [
        { quote: QUOTES.deposit, sourceDocumentId: guestDocA.id },
        { quote: QUOTES.fabricated, sourceDocumentId: guestDocA.id },
      ]),
    });
    const final = finalOf(await collect(ask(h.deps(llm), guestA, { query: GROUNDED_QUERY, documentIds: [guestDocA.id, guestDocB.id] })));
    if (final.message.mode !== "grounded") throw new Error("expected grounded");

    expect(assertBound(final.message.citations, final.sources, [guestDocA, guestDocB])).toBe(2);
    expect([...final.sources.keys()]).toEqual([guestDocA.id]);
    expect(spanTextOf(final.message.citations[0], final.sources)).toBe(QUOTES.deposit);
    // Never serialized: a Map stringifies as {}, so no document text rides along.
    expect(JSON.stringify(final)).not.toContain(UNQUOTED_TEXT);
  });

  it("saved thread: two documents cited three times give two entries (per document, not per citation)", async () => {
    const thread = await h.thread(userA, [docA, docB]);
    const llm = new FakeLlmClient({
      defaultResponse: answer("x", [
        { quote: QUOTES.deposit, sourceDocumentId: docA.id },
        { quote: QUOTES.lockIn, sourceDocumentId: docA.id },
        { quote: PET_CLAUSE, sourceDocumentId: docB.id },
      ]),
    });
    const final = finalOf(await collect(ask(h.deps(llm), userA, { threadId: thread.id, query: GROUNDED_QUERY })));
    if (final.message.mode !== "grounded") throw new Error("expected grounded");

    expect(assertBound(final.message.citations, final.sources, [docA, docB])).toBe(3);
    expect(final.sources.size).toBe(2);
    expect(spanTextOf(final.message.citations[2], final.sources)).toBe(PET_CLAUSE);
  });

  it("general mode: empty sources", async () => {
    const final = finalOf(await collect(ask(h.deps(new FakeLlmClient({ defaultResponse: answer("Usually not.") })), guestA, { query: GENERAL_QUERY })));
    expect(final.message.mode).toBe("general");
    expect(final.sources.size).toBe(0);
  });
});

describe("createThread result", () => {
  it("sources = the cited own document only: not the attached-uncited one, not the foreign (unlinked) one", async () => {
    const foreign = await h.document(userB);
    const out = await createThread(h.deps(new FakeLlmClient()), userA, {
      title: "Imported",
      documentIds: [docA.id, docB.id],
      importedMessages: [
        { role: "user", content: GROUNDED_QUERY },
        {
          role: "assistant",
          content: "a",
          mode: "grounded",
          citations: [
            { quoteText: QUOTES.deposit, sourceDocumentId: docA.id },
            { quoteText: QUOTES.fabricated, sourceDocumentId: docA.id },
            { quoteText: QUOTES.deposit, sourceDocumentId: foreign.id },
          ],
        },
      ],
    });
    const citations = citationsOf(out.messages);
    expect(citations.map((c) => c.sourceDocumentId)).toEqual([docA.id, docA.id, null]);
    expect(assertBound(citations, out.sources, [docA, docB])).toBe(2);
    expect([...out.sources.keys()]).toEqual([docA.id]);
    expect(spanTextOf(citations[0], out.sources)).toBe(QUOTES.deposit);
  });
});

describe("listRecentMessages", () => {
  it("under the 100-citation read cap: sources cover only documents cited by RETURNED messages", async () => {
    const thread = await h.thread(userA, [docA, docB]);
    const perMessage = 10;
    async function groundedTurn(document: Document, quote: string) {
      const [result] = verifyMany([quote], document.canonicalText!, "text");
      await appendMessage(h.t.db, userA, thread.id, { role: "user", content: "q" });
      const reply = await appendMessage(h.t.db, userA, thread.id, { role: "assistant", content: "a", mode: "grounded", modelUsed: "m" });
      await insertCitations(
        h.t.db,
        userA,
        reply.id,
        Array.from({ length: perMessage }, () => ({ quote, source: { documentId: document.id, verification: result } })),
      );
    }
    // The oldest turn cites docB; the newest turns fill the whole budget citing docA.
    await groundedTurn(docB, PET_CLAUSE);
    for (let i = 0; i < MAX_VERIFIED_CITATIONS_PER_READ / perMessage; i++) await groundedTurn(docA, QUOTES.deposit);

    const { messages, sources } = await listRecentMessages(h.deps(new FakeLlmClient()), userA, thread.id, { limit: 200 });
    const citations = citationsOf(messages);
    expect(citations).toHaveLength(MAX_VERIFIED_CITATIONS_PER_READ);
    expect(assertBound(citations, sources, [docA, docB])).toBe(MAX_VERIFIED_CITATIONS_PER_READ);
    expect([...sources.keys()]).toEqual([docA.id]);
    expect(citations.every((c) => spanTextOf(c, sources) === QUOTES.deposit)).toBe(true);

    // Positive control: a NEWEST turn citing docB is inside the window, so docB is in sources (and the
    // oldest docA turn now drops out to keep the total at the cap).
    await groundedTurn(docB, PET_CLAUSE);
    const after = await listRecentMessages(h.deps(new FakeLlmClient()), userA, thread.id, { limit: 200 });
    const afterCitations = citationsOf(after.messages);
    expect(afterCitations).toHaveLength(MAX_VERIFIED_CITATIONS_PER_READ);
    expect(assertBound(afterCitations, after.sources, [docA, docB])).toBe(MAX_VERIFIED_CITATIONS_PER_READ);
    expect([...after.sources.keys()].sort()).toEqual([docA.id, docB.id].sort());
  });
});
