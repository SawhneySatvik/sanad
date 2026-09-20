// Cross-principal access through the Ask service: another principal's thread or document is the same
// NOT_FOUND as a missing or malformed id, before any model call. Guest import is the exception: a
// foreign/missing/malformed citation source is stored unlinked and not_found instead of rejected.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listThreadDocumentIds } from "@/server/data/threads";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { ask, createThread, listRecentMessages, type AskEvent } from "@/server/services/ask";
import {
  answer,
  caught,
  collect,
  createAskHarness,
  finalMessage,
  GROUNDED_QUERY,
  guestA,
  guestB,
  QUOTES,
  userA,
  userB,
  type AskHarness,
} from "@tests/support/services/ask";

const MISSING_ID = "0190a000-0000-7000-8000-000000000000";

let h: AskHarness;

beforeEach(async () => {
  h = await createAskHarness();
});
afterEach(() => h.close());

function answeringLlm() {
  return new FakeLlmClient({ defaultResponse: answer("x") });
}

describe("ask", () => {
  it("on another user's thread is NOT_FOUND — identical to a missing or malformed thread id — with no model call and nothing written", async () => {
    const docB = await h.document(userB);
    const threadB = await h.thread(userB, [docB]);
    const llm = answeringLlm();

    const outcomes: AskEvent[][] = [];
    for (const threadId of [threadB.id, MISSING_ID, "not-a-uuid"]) {
      outcomes.push(await collect(ask(h.deps(llm), userA, { threadId, query: GROUNDED_QUERY })));
    }
    // A guest can never reach a user's saved thread either.
    outcomes.push(await collect(ask(h.deps(llm), guestA, { threadId: threadB.id, query: GROUNDED_QUERY })));
    for (const events of outcomes) expect(events).toEqual([{ type: "error", code: "NOT_FOUND" }]);
    expect(llm.callCount).toBe(0);
    expect(await h.counts()).toMatchObject({ messages: 0, citations: 0 });

    // Positive control: the owner asks in it.
    expect(finalMessage(await collect(ask(h.deps(llm), userB, { threadId: threadB.id, query: GROUNDED_QUERY }))).mode).toBe("grounded");
    expect(await h.counts()).toMatchObject({ messages: 2 });
  });

  it("with another principal's documentId is NOT_FOUND — identical to a missing or malformed id — with no model call", async () => {
    const docA = await h.document(guestA);
    const docB = await h.document(guestB);
    const pendingA = await h.pending(guestA);
    const llm = answeringLlm();

    // A foreign id is NOT_FOUND even next to the caller's own not-yet-extracted document.
    for (const documentIds of [[docB.id], [MISSING_ID], ["not-a-uuid"], [docA.id, docB.id], [pendingA.id, docB.id]]) {
      expect(await collect(ask(h.deps(llm), guestA, { query: GROUNDED_QUERY, documentIds }))).toEqual([
        { type: "error", code: "NOT_FOUND" },
      ]);
    }
    expect(llm.callCount).toBe(0);

    // Positive controls: the caller's own document grounds the answer, and the owner can use docB.
    expect(finalMessage(await collect(ask(h.deps(llm), guestA, { query: GROUNDED_QUERY, documentIds: [docA.id] }))).mode).toBe("grounded");
    expect(finalMessage(await collect(ask(h.deps(llm), guestB, { query: GROUNDED_QUERY, documentIds: [docB.id] }))).mode).toBe("grounded");
  });
});

describe("listThreadDocumentIds (data/threads.ts)", () => {
  it("on another user's thread is NOT_FOUND — identical to a missing or malformed thread id", async () => {
    const docB = await h.document(userB);
    const threadB = await h.thread(userB, [docB]);

    const shapes: { code: string; message: string }[] = [];
    for (const [principal, threadId] of [
      [userA, threadB.id],
      [userA, MISSING_ID],
      [userA, "not-a-uuid"],
      [guestA, threadB.id],
    ] as const) {
      const error = await caught(listThreadDocumentIds(h.t.db, principal, threadId));
      shapes.push({ code: error.code, message: error.message });
    }
    expect(shapes[0].code).toBe("NOT_FOUND");
    expect(shapes.every((shape) => shape.code === shapes[0].code && shape.message === shapes[0].message)).toBe(true);

    // Positive control: the owner gets the attached document.
    expect(await listThreadDocumentIds(h.t.db, userB, threadB.id)).toEqual([docB.id]);
  });
});

describe("listRecentMessages", () => {
  it("on another user's thread is NOT_FOUND — identical to a missing or malformed thread id", async () => {
    const threadB = await h.thread(userB);
    const deps = h.deps(answeringLlm());
    await collect(ask(deps, userB, { threadId: threadB.id, query: GROUNDED_QUERY }));

    const shapes = [];
    for (const [principal, threadId] of [
      [userA, threadB.id],
      [userA, MISSING_ID],
      [userA, "not-a-uuid"],
      [guestA, threadB.id],
    ] as const) {
      const error = await caught(listRecentMessages(deps, principal, threadId, { limit: 10 }));
      shapes.push({ code: error.code, message: error.message });
    }
    expect(new Set(shapes.map((s) => JSON.stringify(s)))).toEqual(new Set([JSON.stringify(shapes[0])]));
    expect(shapes[0].code).toBe("NOT_FOUND");

    // Positive control.
    expect((await listRecentMessages(deps, userB, threadB.id, { limit: 10 })).messages).toHaveLength(2);
  });
});

describe("createThread — guest import", () => {
  it("a citation of another user's document (which DOES contain the quote) is stored exactly like a missing or malformed one: unlinked, not_found", async () => {
    const docA = await h.document(userA);
    const docB = await h.document(userB);
    // verify() against docB's text would say verified — so a not_found below proves it was never used.
    expect(docB.canonicalText!.includes(QUOTES.deposit)).toBe(true);

    const cite = (sourceDocumentId: string) => ({ quoteText: QUOTES.deposit, sourceDocumentId });
    const out = await createThread(h.deps(answeringLlm()), userA, {
      title: "Imported",
      documentIds: [docB.id, MISSING_ID, "not-a-uuid", docA.id],
      importedMessages: [
        { role: "user", content: GROUNDED_QUERY },
        { role: "assistant", content: "a", mode: "grounded", citations: [cite(docB.id), cite(MISSING_ID), cite("not-a-uuid"), cite(docA.id)] },
      ],
    });

    // Only the principal's own document is attached.
    expect(out.documentIds).toEqual([docA.id]);
    const stored = await h.t.client.query<{ source_document_id: string | null; verification_status: string; quote_span_start: number | null }>(
      "SELECT source_document_id, verification_status, quote_span_start FROM message_citations ORDER BY id",
    );
    const unlinked = { source_document_id: null, verification_status: "not_found", quote_span_start: null };
    expect(stored.rows.slice(0, 3)).toEqual([unlinked, unlinked, unlinked]);

    const message = out.messages[1];
    if (message.role !== "assistant" || message.mode !== "grounded") throw new Error("expected grounded");
    const shapes = message.citations.map((c) => [c.sourceDocumentId, c.verification.status, c.verification.spanStart]);
    expect(shapes.slice(0, 3)).toEqual([
      [null, "not_found", null],
      [null, "not_found", null],
      [null, "not_found", null],
    ]);
    // Positive control: the same quote cited from the principal's own document is verified.
    expect(shapes[3].slice(0, 2)).toEqual([docA.id, "verified"]);
    expect(stored.rows[3]).toMatchObject({ source_document_id: docA.id, verification_status: "verified" });
  });
});
