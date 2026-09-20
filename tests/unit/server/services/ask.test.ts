import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Document } from "@/server/data/documents";
import { MAX_QUOTE_CHARS as MAX_QUOTE_CHARS_VERIFY } from "@/server/deterministic/verify";
import { appendMessage } from "@/server/data/messages";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { MAX_DOCUMENTS_TOTAL_CHARS } from "@/server/orchestrator";
import {
  ask,
  createThread,
  GENERAL_MODE_LABEL,
  listRecentMessages,
  MAX_CONTEXT_DOCUMENTS,
  MAX_HISTORY_CHARS,
  MAX_HISTORY_TURNS,
  MAX_IMPORTED_CITATIONS,
  MAX_IMPORTED_DOCUMENTS,
  MAX_IMPORTED_MESSAGE_CHARS,
  MAX_IMPORTED_MESSAGES,
  MAX_QUERY_CHARS,
  MAX_THREAD_TITLE_CHARS,
  type AskEvent,
  type AskHistoryMessage,
  type CreateThreadInput,
  type ImportedMessage,
} from "@/server/services/ask";
import {
  answer,
  caught,
  collect,
  createAskHarness,
  DbProbingLlmClient,
  finalMessage,
  HookedLlmClient,
  GENERAL_QUERY,
  GROUNDED_QUERY,
  guestA,
  NON_LEGAL_QUERY,
  QUOTES,
  USER_A_ID,
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

function groundedLlm(modelUsed?: string) {
  return new FakeLlmClient({
    defaultResponse: answer("Within 15 days of vacating.", [{ quote: QUOTES.deposit, sourceDocumentId: doc.id }], modelUsed),
  });
}

async function messageRows() {
  const result = await h.t.client.query<{ role: string; content: string; mode: string | null; model_used: string | null; routed_domain_array: string[] | null }>(
    "SELECT role, content, mode, model_used, routed_domain_array FROM messages ORDER BY created_at, id",
  );
  return result.rows;
}

describe("ask — saved thread", () => {
  it("streams tokens, then persists the user and assistant messages and citations in one turn, returning the persisted message", async () => {
    const thread = await h.thread(userA, [doc]);
    const events = await collect(ask(h.deps(groundedLlm()), userA, { threadId: thread.id, query: GROUNDED_QUERY }));

    expect(events.filter((e) => e.type === "token").length).toBeGreaterThan(0);
    const message = finalMessage(events);
    expect(message).toMatchObject({ role: "assistant", mode: "grounded", content: "Within 15 days of vacating.", modelUsed: "fake-model" });
    expect(message.routedDomains).toEqual(["tenancy"]);
    if (message.mode !== "grounded") throw new Error("expected grounded");
    expect(message.citations.map((c) => [c.quote, c.sourceDocumentId, c.verification.status])).toEqual([[QUOTES.deposit, doc.id, "verified"]]);

    expect(await messageRows()).toEqual([
      { role: "user", content: GROUNDED_QUERY, mode: null, model_used: null, routed_domain_array: null },
      { role: "assistant", content: "Within 15 days of vacating.", mode: "grounded", model_used: "fake-model", routed_domain_array: ["tenancy"] },
    ]);
    const [user, reloaded] = (await listRecentMessages(h.deps(groundedLlm()), userA, thread.id, { limit: 10 })).messages;
    expect(user).toMatchObject({ role: "user", content: GROUNDED_QUERY });
    expect(reloaded).toMatchObject({ id: message.id, createdAt: message.createdAt, mode: "grounded" });
    if (reloaded.role !== "assistant" || reloaded.mode !== "grounded") throw new Error("expected grounded");
    expect(reloaded.citations.map((c) => c.id)).toEqual(message.citations.map((c) => c.id));
  });

  it("sends the thread's recent messages as history, bounded to the latest MAX_HISTORY_TURNS", async () => {
    const thread = await h.thread(userA, [doc]);
    for (let i = 1; i <= MAX_HISTORY_TURNS + 3; i++) {
      await appendMessage(h.t.db, userA, thread.id, { role: "user", content: `earlier-question-${i}-end` });
    }
    const llm = groundedLlm();
    await collect(ask(h.deps(llm), userA, { threadId: thread.id, query: GROUNDED_QUERY }));
    const prompt = llm.calls[0].userPrompt;
    expect(prompt).toContain(`earlier-question-${MAX_HISTORY_TURNS + 3}-end`);
    expect(prompt).toContain("earlier-question-4-end");
    expect(prompt).not.toContain("earlier-question-3-end");
  });

  it("bounds a saved thread's history by characters too: an imported over-budget latest message is not sent", async () => {
    const huge = `imported-${"y".repeat(MAX_HISTORY_CHARS)}-end`;
    const { thread } = await createThread(h.deps(new FakeLlmClient()), userA, {
      title: "Imported",
      importedMessages: [
        { role: "user", content: "older-question-end" },
        { role: "assistant", content: huge, mode: "general" },
      ],
    });
    const llm = new FakeLlmClient({ defaultResponse: answer("Usually not.") });
    await collect(ask(h.deps(llm), userA, { threadId: thread.id, query: GENERAL_QUERY }));
    expect(llm.calls[0].userPrompt).not.toContain(huge);
    expect(llm.calls[0].userPrompt).not.toContain("older-question-end");
  });

  it("a thread with no attached document answers in general mode, labelled, with no citations persisted", async () => {
    const thread = await h.thread(userA);
    // The model returns a citation anyway; general mode never keeps one.
    const llm = new FakeLlmClient({ defaultResponse: answer("Usually not.", [{ quote: QUOTES.deposit, sourceDocumentId: doc.id }]) });
    const message = finalMessage(await collect(ask(h.deps(llm), userA, { threadId: thread.id, query: GENERAL_QUERY })));
    expect(message).toMatchObject({ mode: "general", redirect: false, label: GENERAL_MODE_LABEL, modelUsed: "fake-model" });
    expect(await h.counts()).toMatchObject({ messages: 2, citations: 0 });
  });

  it("persists the non-legal redirect as general mode with model_used none, with no model call", async () => {
    const thread = await h.thread(userA);
    const llm = new FakeLlmClient();
    const message = finalMessage(await collect(ask(h.deps(llm), userA, { threadId: thread.id, query: NON_LEGAL_QUERY })));
    expect(llm.callCount).toBe(0);
    expect(message).toMatchObject({ mode: "general", redirect: true, modelUsed: "none", label: GENERAL_MODE_LABEL });
    expect((await messageRows())[1]).toMatchObject({ role: "assistant", mode: "general", model_used: "none" });
    const [, reloaded] = (await listRecentMessages(h.deps(llm), userA, thread.id, { limit: 10 })).messages;
    expect(reloaded).toMatchObject({ mode: "general", redirect: true, modelUsed: "none" });
  });

  it("refuses documentIds or client history on a saved thread, before any model call", async () => {
    const thread = await h.thread(userA, [doc]);
    const llm = groundedLlm();
    const history: AskHistoryMessage[] = [{ role: "user", content: "hi" }];
    for (const extra of [{ documentIds: [doc.id] }, { history }]) {
      const events = await collect(ask(h.deps(llm), userA, { threadId: thread.id, query: GROUNDED_QUERY, ...extra }));
      expect(events).toEqual([{ type: "error", code: "VALIDATION_FAILED" }]);
    }
    expect(llm.callCount).toBe(0);
    // Empty arrays are no request at all.
    const ok = await collect(ask(h.deps(llm), userA, { threadId: thread.id, query: GROUNDED_QUERY, documentIds: [], history: [] }));
    expect(finalMessage(ok).mode).toBe("grounded");
  });

  it("holds no transaction or connection across the model call", async () => {
    const thread = await h.thread(userA, [doc]);
    const llm = new DbProbingLlmClient(groundedLlm(), h.t.client);
    const events = await collect(ask(h.deps(llm), userA, { threadId: thread.id, query: GROUNDED_QUERY }));
    expect(finalMessage(events).mode).toBe("grounded");
    expect(llm.probes).toEqual(["free", "free"]);
  });

  it("persists nothing when the consumer stops reading mid-stream", async () => {
    const thread = await h.thread(userA, [doc]);
    const iterator = ask(h.deps(groundedLlm()), userA, { threadId: thread.id, query: GROUNDED_QUERY });
    const first = await iterator.next();
    expect(first.value).toMatchObject({ type: "token" });
    await iterator.return(undefined);
    expect(await h.counts()).toMatchObject({ messages: 0, citations: 0 });
  });

  describe("client goes away: before completion nothing persists; after completion the turn persists", () => {
    // Drives ask() the way the SSE route does, with the client aborting and the stream being
    // closed (signal.abort() + return()) at the moment `when` picks in the model call.
    async function goAwayAt(when: "first token" | "model done") {
      const thread = await h.thread(userA, [doc]);
      const controller = new AbortController();
      let returned: Promise<unknown> | undefined;
      const llm = new HookedLlmClient(groundedLlm(), (event) => {
        if (returned || (when === "first token" ? event.type !== "token" : event.type !== "done")) return;
        controller.abort();
        returned = iterator.return(undefined);
      });
      const iterator = ask(h.deps(llm), userA, { threadId: thread.id, query: GROUNDED_QUERY, signal: controller.signal });
      const events: AskEvent[] = [];
      for (let next = await iterator.next(); !next.done; next = await iterator.next()) events.push(next.value);
      expect(returned).toBeDefined();
      expect(await returned).toEqual({ done: true, value: undefined });
      expect(controller.signal.aborted).toBe(true);
      return events;
    }

    it("before completion (at the first token): no final, nothing persisted", async () => {
      const events = await goAwayAt("first token");
      expect(events.map((e) => e.type)).toEqual(["token"]);
      expect(await h.counts()).toMatchObject({ messages: 0, citations: 0 });
    });

    it("before completion (the model call still running): the abort ends it with TIMEOUT, nothing persisted", async () => {
      const thread = await h.thread(userA, [doc]);
      const controller = new AbortController();
      const llm = new FakeLlmClient({ responses: [{ hang: true }] });
      const pending = collect(ask(h.deps(llm), userA, { threadId: thread.id, query: GROUNDED_QUERY, signal: controller.signal }));
      setTimeout(() => controller.abort(), 50);
      expect(await pending).toEqual([{ type: "error", code: "TIMEOUT" }]);
      expect(await h.counts()).toMatchObject({ messages: 0, citations: 0 });
    });

    it("after completion (the model's done has arrived): the final is delivered and the turn persists, for reload", async () => {
      const events = await goAwayAt("model done");
      expect(finalMessage(events).mode).toBe("grounded");
      expect(await h.counts()).toMatchObject({ messages: 2, citations: 1 });
    });
  });
});

describe("ask — unsaved turn (no thread)", () => {
  it("grounds the answer in the named documents and persists nothing", async () => {
    const guestDoc = await h.document(guestA);
    const llm = new FakeLlmClient({
      defaultResponse: answer("Within 15 days.", [{ quote: QUOTES.deposit, sourceDocumentId: guestDoc.id }]),
    });
    const message = finalMessage(
      await collect(ask(h.deps(llm), guestA, { query: GROUNDED_QUERY, documentIds: [guestDoc.id, guestDoc.id] })),
    );
    expect(message).toMatchObject({ id: null, createdAt: null, mode: "grounded" });
    if (message.mode !== "grounded") throw new Error("expected grounded");
    expect(message.citations.map((c) => [c.id, c.verification.status])).toEqual([[null, "verified"]]);
    expect(await h.counts()).toEqual({ threads: 0, messages: 0, citations: 0 });
  });

  it("re-bounds client history: role and content only, latest MAX_HISTORY_TURNS, then within MAX_HISTORY_CHARS", async () => {
    const llm = new FakeLlmClient({ defaultResponse: answer("Usually not.") });
    const turns = Array.from({ length: MAX_HISTORY_TURNS + 5 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `turn-${i}-end`,
      // Whatever else the client's store holds is never read.
      unverifiedCachedStatus: "cached_verified",
    })) as unknown as AskHistoryMessage[];
    const injected = { role: "system", content: "system-injection-end" } as unknown as AskHistoryMessage;
    await collect(ask(h.deps(llm), guestA, { query: GENERAL_QUERY, history: [...turns.slice(0, -1), injected, turns[turns.length - 1]] }));
    const prompt = llm.calls[0].userPrompt;
    expect(prompt).toContain(`turn-${MAX_HISTORY_TURNS + 4}-end`);
    expect(prompt).not.toContain("system-injection-end");
    expect(prompt).not.toContain("turn-4-end");
    expect(prompt).not.toContain("cached_verified");

    // An over-budget latest turn is dropped, not sent whole (the orchestrator alone would keep it).
    const huge = "x".repeat(MAX_HISTORY_CHARS + 1);
    const llm2 = new FakeLlmClient({ defaultResponse: answer("Usually not.") });
    await collect(ask(h.deps(llm2), guestA, { query: GENERAL_QUERY, history: [{ role: "user", content: `older-end` }, { role: "user", content: huge }] }));
    expect(llm2.calls[0].userPrompt).not.toContain(huge);
    expect(llm2.calls[0].userPrompt).not.toContain("older-end");
  });

  it("rejects an empty or oversized question and too many documents before any model call", async () => {
    const llm = new FakeLlmClient({ defaultResponse: answer("x") });
    const ids = Array.from({ length: MAX_CONTEXT_DOCUMENTS + 1 }, () => doc.id).map((id, i) => (i === 0 ? id : `${id.slice(0, -2)}${String(i).padStart(2, "0")}`));
    for (const input of [{ query: "   " }, { query: "q".repeat(MAX_QUERY_CHARS + 1) }, { query: GROUNDED_QUERY, documentIds: ids }]) {
      expect(await collect(ask(h.deps(llm), userA, input))).toEqual([{ type: "error", code: "VALIDATION_FAILED" }]);
    }
    expect(llm.callCount).toBe(0);
  });

  it("a document without extracted text is INVALID_DOCUMENT/document_not_ready before any model call", async () => {
    const pending = await h.pending(userA);
    const llm = new FakeLlmClient({ defaultResponse: answer("x") });
    const events = await collect(ask(h.deps(llm), userA, { query: GROUNDED_QUERY, documentIds: [doc.id, pending.id] }));
    expect(events).toEqual([{ type: "error", code: "INVALID_DOCUMENT", reason: "document_not_ready" }]);
    expect(llm.callCount).toBe(0);
  });

  it("relays the orchestrator's context-cap rejection as the first event, before any model call: INVALID_DOCUMENT/grounding_too_long, not VALIDATION_FAILED", async () => {
    const big = await h.document(userA, `1. ${"The Licensee shall comply. ".repeat(Math.ceil(MAX_DOCUMENTS_TOTAL_CHARS / 27) + 10)}`);
    const llm = new FakeLlmClient({ defaultResponse: answer("x") });
    const events = await collect(ask(h.deps(llm), userA, { query: GROUNDED_QUERY, documentIds: [big.id] }));
    expect(events).toEqual([{ type: "error", code: "INVALID_DOCUMENT", reason: "grounding_too_long" }]);
    expect(llm.callCount).toBe(0);
  });
});

describe("createThread", () => {
  it("is user-only: a guest gets VALIDATION_FAILED and nothing is written", async () => {
    const error = await caught(createThread(h.deps(new FakeLlmClient()), guestA, { title: "t" }));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect((await h.counts()).threads).toBe(0);
  });

  it("creates a thread with its documents attached, then grounds the next turn in them", async () => {
    const out = await createThread(h.deps(new FakeLlmClient()), userA, { title: "Lease", documentIds: [doc.id] });
    expect(out).toMatchObject({ thread: { title: "Lease", ownerUserId: USER_A_ID }, documentIds: [doc.id], messages: [] });
    const message = finalMessage(await collect(ask(h.deps(groundedLlm()), userA, { threadId: out.thread.id, query: GROUNDED_QUERY })));
    expect(message.mode).toBe("grounded");
  });

  it("imports a guest thread in order, with model_used stored as visibly unattested", async () => {
    const imported: ImportedMessage[] = [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer", mode: "grounded", modelUsed: "gemini-2.5-flash", citations: [{ quoteText: QUOTES.deposit, sourceDocumentId: doc.id }] },
      { role: "user", content: "second question" },
      { role: "assistant", content: "second answer", mode: "general", modelUsed: "bad model; DROP TABLE", citations: [{ quoteText: QUOTES.deposit, sourceDocumentId: doc.id }] },
      { role: "assistant", content: "third answer", mode: null, modelUsed: "m".repeat(65) },
      { role: "assistant", content: "fourth answer", mode: "grounded" },
    ];
    const out = await createThread(h.deps(new FakeLlmClient()), userA, { title: "Imported", documentIds: [doc.id], importedMessages: imported });

    expect(out.messages.map((m) => [m.role, m.content, m.role === "assistant" ? m.mode : null, m.role === "assistant" ? m.modelUsed : null])).toEqual([
      ["user", "first question", null, null],
      ["assistant", "first answer", "grounded", "imported:gemini-2.5-flash"],
      ["user", "second question", null, null],
      // A general-mode answer keeps no citations; an unacceptable label becomes "unknown".
      ["assistant", "second answer", "general", "imported:unknown"],
      ["assistant", "third answer", "general", "imported:unknown"],
      ["assistant", "fourth answer", "grounded", "imported:unknown"],
    ]);
    expect(await h.counts()).toEqual({ threads: 1, messages: 6, citations: 1 });
    const first = out.messages[1];
    if (first.role !== "assistant" || first.mode !== "grounded") throw new Error("expected grounded");
    expect(first.citations.map((c) => [c.sourceDocumentId, c.verification.status])).toEqual([[doc.id, "verified"]]);
  });

  it("does not load documents cited only by user or general-mode messages — their citations are discarded", async () => {
    const many = Array.from({ length: MAX_IMPORTED_DOCUMENTS + 1 }, (_, i) => ({ quoteText: QUOTES.deposit, sourceDocumentId: `document-${i}` }));
    const out = await createThread(h.deps(new FakeLlmClient()), userA, {
      title: "Imported",
      importedMessages: [
        { role: "user", content: "q", citations: many } as ImportedMessage,
        { role: "assistant", content: "a", mode: "general", citations: many },
      ],
    });
    expect(out.messages).toHaveLength(2);
    expect(await h.counts()).toEqual({ threads: 1, messages: 2, citations: 0 });
  });

  it("enforces the import caps before writing anything", async () => {
    const citation = { quoteText: QUOTES.deposit, sourceDocumentId: doc.id };
    const grounded = (citations: ImportedMessage["citations"]): ImportedMessage[] => [
      { role: "assistant", content: "a", mode: "grounded", citations },
    ];
    const over: CreateThreadInput[] = [
      { title: "t".repeat(MAX_THREAD_TITLE_CHARS + 1) },
      { title: "t", documentIds: Array.from({ length: MAX_CONTEXT_DOCUMENTS + 1 }, () => doc.id) },
      { title: "t", importedMessages: Array.from({ length: MAX_IMPORTED_MESSAGES + 1 }, () => ({ role: "user" as const, content: "q" })) },
      { title: "t", importedMessages: [{ role: "user", content: "q".repeat(MAX_IMPORTED_MESSAGE_CHARS + 1) }] },
      { title: "t", importedMessages: grounded(Array.from({ length: MAX_IMPORTED_CITATIONS + 1 }, () => citation)) },
      { title: "t", importedMessages: grounded([{ ...citation, quoteText: "q".repeat(MAX_QUOTE_CHARS_VERIFY + 1) }]) },
      {
        title: "t",
        importedMessages: grounded(
          Array.from({ length: MAX_IMPORTED_DOCUMENTS + 1 }, (_, i) => ({ ...citation, sourceDocumentId: `document-${i}` })),
        ),
      },
    ];
    for (const input of over) {
      expect((await caught(createThread(h.deps(new FakeLlmClient()), userA, input))).code).toBe("VALIDATION_FAILED");
    }
    expect(await h.counts()).toEqual({ threads: 0, messages: 0, citations: 0 });
  });
});

describe("listRecentMessages", () => {
  it("returns the latest `limit` messages, oldest first", async () => {
    const thread = await h.thread(userA);
    for (let i = 1; i <= 5; i++) await appendMessage(h.t.db, userA, thread.id, { role: "user", content: `m${i}` });
    const messages = (await listRecentMessages(h.deps(new FakeLlmClient()), userA, thread.id, { limit: 3 })).messages;
    expect(messages.map((m) => m.content)).toEqual(["m3", "m4", "m5"]);
  });
});
