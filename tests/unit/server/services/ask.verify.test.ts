// One Guarantee through the Ask service: a document-attached question yields a grounded message
// whose citation statuses come from verify(); a no-document question yields a general message whose
// type has no status field; a rate-limited request yields a typed RATE_LIMITED error, not content.

import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { AppError } from "@/server/core/errors";
import type { Document } from "@/server/data/documents";
import { insertCitations, MAX_VERIFIED_CITATIONS_PER_READ } from "@/server/data/message-citations";
import { appendMessage } from "@/server/data/messages";
import { VERIFIER_VERSION, verifyMany } from "@/server/deterministic/verify";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { enforcePrincipalLimit } from "@/server/rate-limit/limiter";
import { createRateLimitedLlmClient } from "@/server/rate-limit/rate-limited-llm-client";
import {
  ask,
  createThread,
  GENERAL_MODE_LABEL,
  listRecentMessages,
  type GeneralAssistantMessage,
  type GroundedAssistantMessage,
  type HasStatusKey,
  type ImportedCitation,
} from "@/server/services/ask";
import {
  answer,
  collect,
  createAskHarness,
  finalMessage,
  GENERAL_QUERY,
  GROUNDED_QUERY,
  LEASE,
  QUOTES,
  TWO_SPECIALIST_QUERY,
  userA,
  type AskHarness,
} from "@tests/support/services/ask";

let h: AskHarness;
let doc: Document;

beforeEach(async () => {
  h = await createAskHarness();
  doc = await h.document(userA);
});
afterEach(() => h.close());

function citingLlm(quotes: readonly string[], modelUsed?: string) {
  return new FakeLlmClient({
    defaultResponse: answer(
      "Here is what the agreement says.",
      quotes.map((quote) => ({ quote, sourceDocumentId: doc.id })),
      modelUsed,
    ),
  });
}

async function storedCitations() {
  const result = await h.t.client.query<{ quote_text: string; verification_status: string; source_document_id: string | null; verifier_version: string }>(
    "SELECT quote_text, verification_status, source_document_id, verifier_version FROM message_citations ORDER BY id",
  );
  return result.rows;
}

function grounded(message: unknown): GroundedAssistantMessage {
  const m = message as GroundedAssistantMessage;
  if (m.mode !== "grounded") throw new Error(`expected a grounded message, got ${m.mode}`);
  return m;
}

// Every key anywhere inside a value (own enumerable keys, recursively through arrays and objects).
function hasKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasKeyDeep(item, key));
  if (typeof value !== "object" || value === null || value instanceof Date) return false;
  return Object.entries(value).some(([k, v]) => k === key || hasKeyDeep(v, key));
}

describe("grounded: citation statuses come from verify()", () => {
  it("a quote in the document is verified at exactly its text; a fabricated one is not_found — returned and persisted alike", async () => {
    const thread = await h.thread(userA, [doc]);
    const events = await collect(ask(h.deps(citingLlm([QUOTES.deposit, QUOTES.fabricated])), userA, { threadId: thread.id, query: GROUNDED_QUERY }));
    const message = grounded(finalMessage(events));

    const [present, absent] = message.citations;
    expect(present.verification.status).toBe("verified");
    expect(doc.canonicalText!.slice(present.verification.spanStart!, present.verification.spanEnd!)).toBe(QUOTES.deposit);
    expect([absent.verification.status, absent.verification.spanStart, absent.verification.spanEnd]).toEqual(["not_found", null, null]);
    expect(LEASE.includes(QUOTES.fabricated)).toBe(false);

    expect(await storedCitations()).toEqual([
      { quote_text: QUOTES.deposit, verification_status: "verified", source_document_id: doc.id, verifier_version: VERIFIER_VERSION },
      { quote_text: QUOTES.fabricated, verification_status: "not_found", source_document_id: doc.id, verifier_version: VERIFIER_VERSION },
    ]);
  });

  it("a citation naming a document outside the turn's context is dropped, never stored or returned", async () => {
    const other = await h.document(userA);
    const thread = await h.thread(userA, [doc]);
    const llm = new FakeLlmClient({
      defaultResponse: answer("x", [
        { quote: QUOTES.deposit, sourceDocumentId: other.id },
        { quote: QUOTES.lockIn, sourceDocumentId: doc.id },
      ]),
    });
    const message = grounded(finalMessage(await collect(ask(h.deps(llm), userA, { threadId: thread.id, query: GROUNDED_QUERY }))));
    expect(message.citations.map((c) => [c.quote, c.sourceDocumentId])).toEqual([[QUOTES.lockIn, doc.id]]);
    expect((await storedCitations()).map((row) => row.source_document_id)).toEqual([doc.id]);
  });
});

describe("general mode has no status anywhere, and carries the label", () => {
  it("type level: no key named status is reachable in a general message; one is in a grounded message", () => {
    expectTypeOf<HasStatusKey<GeneralAssistantMessage>>().toEqualTypeOf<false>();
    // The same check does see a status where there is one — it is not vacuous.
    expectTypeOf<HasStatusKey<GroundedAssistantMessage>>().toEqualTypeOf<true>();
  });

  it("runtime: the returned and the reloaded general message have no status and no citations, and carry the label", async () => {
    const thread = await h.thread(userA);
    const llm = new FakeLlmClient({ defaultResponse: answer("Usually not.", [{ quote: QUOTES.deposit, sourceDocumentId: doc.id }]) });
    const events = await collect(ask(h.deps(llm), userA, { threadId: thread.id, query: GENERAL_QUERY }));
    const message = finalMessage(events);
    const [, reloaded] = (await listRecentMessages(h.deps(llm), userA, thread.id, { limit: 10 })).messages;

    for (const general of [message, reloaded]) {
      expect(general).toMatchObject({ role: "assistant", mode: "general", label: GENERAL_MODE_LABEL });
      expect(hasKeyDeep(general, "status")).toBe(false);
      expect(hasKeyDeep(general, "verification")).toBe(false);
      expect("citations" in general).toBe(false);
    }
    expect(hasKeyDeep(events, "status")).toBe(false);
    expect(await storedCitations()).toEqual([]);
    // Positive control: the same runtime check finds the status in a grounded message.
    const groundedThread = await h.thread(userA, [doc]);
    const groundedEvents = await collect(ask(h.deps(citingLlm([QUOTES.deposit])), userA, { threadId: groundedThread.id, query: GROUNDED_QUERY }));
    expect(hasKeyDeep(finalMessage(groundedEvents), "status")).toBe(true);
  });
});

describe("tokens carry answer text only, and the badges come after the stream", () => {
  it("no token event has anything but text; the final event is last", async () => {
    const thread = await h.thread(userA, [doc]);
    const events = await collect(ask(h.deps(citingLlm([QUOTES.deposit])), userA, { threadId: thread.id, query: GROUNDED_QUERY }));
    const tokens = events.filter((e) => e.type === "token");
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((e) => Object.keys(e).sort().join() === "text,type")).toBe(true);
    expect(events.findIndex((e) => e.type === "final")).toBe(events.length - 1);
  });
});

describe("the model that answered is persisted and survives a reload", () => {
  it("a fallback model's name is stored, returned, and reloaded", async () => {
    const thread = await h.thread(userA, [doc]);
    const message = finalMessage(
      await collect(ask(h.deps(citingLlm([QUOTES.deposit], "gemma-3-27b-it")), userA, { threadId: thread.id, query: GROUNDED_QUERY })),
    );
    expect(message.modelUsed).toBe("gemma-3-27b-it");
    const [, reloaded] = (await listRecentMessages(h.deps(new FakeLlmClient()), userA, thread.id, { limit: 10 })).messages;
    expect(reloaded).toMatchObject({ role: "assistant", modelUsed: "gemma-3-27b-it" });
  });
});

describe("a rate-limited request is a typed error, first, with nothing produced", () => {
  const clock = { now: () => new Date("2026-09-23T10:00:30.000Z") };

  function limitedClient() {
    const primary = citingLlm([QUOTES.deposit], "gemini-fake");
    const secondary = citingLlm([QUOTES.deposit], "gemma-fake");
    const llm = createRateLimitedLlmClient({
      db: h.t.db,
      primary,
      secondary,
      primaryProvider: "gemini",
      secondaryProvider: "gemma",
      principal: userA,
      principalLimit: 1,
      primaryLimit: 100,
      secondaryLimit: 100,
      clock,
    });
    return { llm, primary, secondary };
  }

  it("with the principal's bucket already full: RATE_LIMITED is the first and only event, no model call, nothing persisted", async () => {
    const thread = await h.thread(userA, [doc]);
    await enforcePrincipalLimit(h.t.db, userA, { limit: 1, clock });
    const { llm, primary, secondary } = limitedClient();

    const events = await collect(ask(h.deps(llm), userA, { threadId: thread.id, query: GROUNDED_QUERY }));
    expect(events).toEqual([{ type: "error", code: "RATE_LIMITED", retryAfterSeconds: 30 }]);
    expect([primary.callCount, secondary.callCount]).toEqual([0, 0]);
    expect(await h.counts()).toMatchObject({ messages: 0, citations: 0 });
  });

  it("positive control: the same client under its limit answers", async () => {
    const thread = await h.thread(userA, [doc]);
    const { llm, primary } = limitedClient();
    const message = finalMessage(await collect(ask(h.deps(llm), userA, { threadId: thread.id, query: GROUNDED_QUERY })));
    expect(message).toMatchObject({ mode: "grounded", modelUsed: "gemini-fake" });
    expect(primary.callCount).toBe(1);
    expect(await h.counts()).toMatchObject({ messages: 2, citations: 1 });
  });
});

describe("a principal limit tripped mid-run is one typed error, nothing produced", () => {
  const clock = { now: () => new Date("2026-09-23T11:00:30.000Z") };

  async function twoSpecialistTurn(principalLimit: number) {
    const thread = await h.thread(userA, [doc]);
    const primary = citingLlm([QUOTES.deposit], "gemini-fake");
    const secondary = citingLlm([QUOTES.deposit], "gemma-fake");
    const llm = createRateLimitedLlmClient({
      db: h.t.db,
      primary,
      secondary,
      primaryProvider: "gemini",
      secondaryProvider: "gemma",
      principal: userA,
      principalLimit,
      primaryLimit: 100,
      secondaryLimit: 100,
      clock,
    });
    const events = await collect(ask(h.deps(llm), userA, { threadId: thread.id, query: TWO_SPECIALIST_QUERY }));
    return { events, primary, secondary };
  }

  it("limit 2: both specialists run, the synthesis call trips the limit — exactly one RATE_LIMITED, zero tokens, zero rows", async () => {
    const { events, primary, secondary } = await twoSpecialistTurn(2);
    expect(events).toEqual([{ type: "error", code: "RATE_LIMITED", retryAfterSeconds: 30 }]);
    // The two specialist calls reached the model; the synthesis call never did.
    expect([primary.callCount, secondary.callCount]).toEqual([2, 0]);
    expect(await h.counts()).toMatchObject({ messages: 0, citations: 0 });
  });

  it("positive control, limit 3: the same turn answers, grounded", async () => {
    const { events, primary } = await twoSpecialistTurn(3);
    const message = grounded(finalMessage(events));
    expect(message.routedDomains).toHaveLength(2);
    expect(primary.callCount).toBe(3);
    expect(await h.counts()).toMatchObject({ messages: 2, citations: 1 });
  });
});

describe("an error mid-stream persists nothing for the turn", () => {
  it("tokens, then the provider fails: an error event ends the stream, no final, no rows", async () => {
    const thread = await h.thread(userA, [doc]);
    const llm = new FakeLlmClient({
      responses: [{ rawText: '{"answer":"The deposit is refunded within fifteen days of' }, { error: new AppError("UPSTREAM_UNAVAILABLE", "down") }],
    });
    const events = await collect(ask(h.deps(llm), userA, { threadId: thread.id, query: GROUNDED_QUERY }));

    const firstError = events.findIndex((e) => e.type === "error");
    expect(events.slice(0, firstError).filter((e) => e.type === "token").length).toBeGreaterThan(0);
    expect(events.slice(firstError)).toEqual([{ type: "error", code: "UPSTREAM_UNAVAILABLE" }]);
    expect(events.some((e) => e.type === "final")).toBe(false);
    expect(await h.counts()).toMatchObject({ messages: 0, citations: 0 });
  });
});

describe("stored statuses are audit-only; imports discard every client status", () => {
  it("listRecentMessages re-verifies: a stored status tampered either way reads its fresh status", async () => {
    const thread = await h.thread(userA, [doc]);
    await collect(ask(h.deps(citingLlm([QUOTES.deposit, QUOTES.fabricated])), userA, { threadId: thread.id, query: GROUNDED_QUERY }));
    await h.t.client.query(
      "UPDATE message_citations SET verification_status = 'verified', quote_span_start = 0, quote_span_end = 20 WHERE quote_text = $1",
      [QUOTES.fabricated],
    );
    await h.t.client.query(
      "UPDATE message_citations SET verification_status = 'not_found', quote_span_start = NULL, quote_span_end = NULL WHERE quote_text = $1",
      [QUOTES.deposit],
    );
    expect((await storedCitations()).map((row) => row.verification_status)).toEqual(["not_found", "verified"]);

    const [, reloaded] = (await listRecentMessages(h.deps(new FakeLlmClient()), userA, thread.id, { limit: 10 })).messages;
    const [deposit, fabricated] = grounded(reloaded).citations;
    expect(deposit.verification.status).toBe("verified");
    expect(doc.canonicalText!.slice(deposit.verification.spanStart!, deposit.verification.spanEnd!)).toBe(QUOTES.deposit);
    expect([fabricated.verification.status, fabricated.verification.spanStart]).toEqual(["not_found", null]);
  });

  it("a read never re-verifies more than MAX_VERIFIED_CITATIONS_PER_READ: the oldest messages drop out, every returned citation is fresh", async () => {
    const thread = await h.thread(userA, [doc]);
    const perMessage = 10;
    const pairs = MAX_VERIFIED_CITATIONS_PER_READ / perMessage + 2; // 20 citations over the budget
    const quotes = Array.from({ length: perMessage }, (_, i) => (i % 2 === 0 ? QUOTES.deposit : QUOTES.fabricated));
    const results = verifyMany(quotes, doc.canonicalText!, "text");
    for (let i = 1; i <= pairs; i++) {
      await appendMessage(h.t.db, userA, thread.id, { role: "user", content: `question-${i}` });
      const reply = await appendMessage(h.t.db, userA, thread.id, {
        role: "assistant",
        content: `answer-${i}`,
        mode: "grounded",
        modelUsed: "fake-model",
      });
      await insertCitations(
        h.t.db,
        userA,
        reply.id,
        quotes.map((quote, k) => ({ quote, source: { documentId: doc.id, verification: results[k] } })),
      );
    }
    // Every stored status flipped: a read that returned any stored status would be caught below.
    await h.t.client.query(
      `UPDATE message_citations SET
         verification_status = CASE verification_status WHEN 'verified' THEN 'not_found'::verification_status ELSE 'verified'::verification_status END,
         quote_span_start = CASE verification_status WHEN 'verified' THEN NULL ELSE 0 END,
         quote_span_end = CASE verification_status WHEN 'verified' THEN NULL ELSE 10 END`,
    );

    const messages = (await listRecentMessages(h.deps(new FakeLlmClient()), userA, thread.id, { limit: 200 })).messages;
    const citations = messages.flatMap((m) => (m.role === "assistant" && m.mode === "grounded" ? m.citations : []));
    expect(citations).toHaveLength(MAX_VERIFIED_CITATIONS_PER_READ);
    // A contiguous newest window: pairs 3..12 (and question-3, which carries no citations).
    expect(messages[0].content).toBe("question-3");
    expect(messages[messages.length - 1].content).toBe(`answer-${pairs}`);
    expect(messages.some((m) => m.content === "answer-2" || m.content === "question-2")).toBe(false);
    for (const citation of citations) {
      if (citation.quote === QUOTES.deposit) {
        expect(citation.verification.status).toBe("verified");
        expect(doc.canonicalText!.slice(citation.verification.spanStart!, citation.verification.spanEnd!)).toBe(QUOTES.deposit);
      } else {
        expect([citation.verification.status, citation.verification.spanStart]).toEqual(["not_found", null]);
      }
    }
  });

  it("import: a forged verified / cached_verified citation for an absent quote is stored and returned not_found; a forged cached_not_found on a present quote is verified", async () => {
    const forged = (quoteText: string, claims: Record<string, unknown>) =>
      ({ quoteText, sourceDocumentId: doc.id, ...claims }) as ImportedCitation;
    const out = await createThread(h.deps(new FakeLlmClient()), userA, {
      title: "Imported",
      documentIds: [doc.id],
      importedMessages: [
        { role: "user", content: GROUNDED_QUERY },
        {
          role: "assistant",
          content: "Forged answer.",
          mode: "grounded",
          citations: [
            forged(QUOTES.fabricated, { unverifiedCachedStatus: "cached_verified", status: "verified", verified: true, quoteSpanStart: 0, quoteSpanEnd: 40 }),
            forged(QUOTES.lockIn, { verificationStatus: "verified", spanStart: 0, spanEnd: 40 }),
            forged(QUOTES.deposit, { unverifiedCachedStatus: "cached_not_found", status: "not_found" }),
          ],
        },
      ],
    });

    expect((await storedCitations()).map((row) => [row.quote_text, row.verification_status])).toEqual([
      [QUOTES.fabricated, "not_found"],
      [QUOTES.lockIn, "verified"],
      [QUOTES.deposit, "verified"],
    ]);
    const [fabricated, lockIn, deposit] = grounded(out.messages[1]).citations;
    expect([fabricated.verification.status, fabricated.verification.spanStart]).toEqual(["not_found", null]);
    // A forged span is never used: the span is verify()'s, and it slices to the quote.
    expect(doc.canonicalText!.slice(lockIn.verification.spanStart!, lockIn.verification.spanEnd!)).toBe(QUOTES.lockIn);
    expect(lockIn.verification.spanStart).not.toBe(0);
    expect(deposit.verification.status).toBe("verified");
  });
});

describe("a native_document grounds an answer but never verifies it", () => {
  it("an exact quote from a scanned document is approximate, returned and persisted", async () => {
    const scanned = await h.document(userA, LEASE, "native_document");
    const thread = await h.thread(userA, [scanned]);
    const llm = new FakeLlmClient({ defaultResponse: answer("x", [{ quote: QUOTES.deposit, sourceDocumentId: scanned.id }]) });
    const message = grounded(finalMessage(await collect(ask(h.deps(llm), userA, { threadId: thread.id, query: GROUNDED_QUERY }))));
    expect(message.citations[0].verification.status).toBe("approximate");
    expect((await storedCitations())[0].verification_status).toBe("approximate");
  });
});
