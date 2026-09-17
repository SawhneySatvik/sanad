import { describe, expect, it } from "vitest";
import { MAX_RECENT_MESSAGES_LIMIT } from "@/server/data/messages";
import { MAX_QUOTE_CHARS as ASK_MAX_QUOTE_CHARS } from "@/server/deterministic/verify";
import * as askService from "@/server/services/ask";
import {
  AskCitationOutput,
  AskEventOutput,
  AskGuestInput,
  CreateThreadInput,
  GeneralAssistantMessageOutput,
  GENERAL_MODE_LABEL,
  GroundedAssistantMessageOutput,
  ImportedCitationInput,
  ImportedMessageInput,
  ListMessagesInput,
  MAX_CONTEXT_DOCUMENTS,
  MAX_HISTORY_CHARS,
  MAX_HISTORY_TURNS,
  MAX_IMPORTED_CITATIONS,
  MAX_IMPORTED_MESSAGES,
  MAX_IMPORTED_MESSAGE_CHARS,
  MAX_LIST_MESSAGES_LIMIT,
  MAX_QUERY_CHARS,
  MAX_QUOTE_CHARS,
  MAX_THREAD_TITLE_CHARS,
  AskMessageInput,
  ThreadMessageOutput,
} from "@/shared/contracts/threads";

describe("AskGuestInput — the unsaved-turn body (POST /api/ask)", () => {
  const base = { query: "What does my lease say about the deposit?" };

  it("accepts query alone, and query + documentIds + history", () => {
    expect(AskGuestInput.safeParse(base).success).toBe(true);
    expect(
      AskGuestInput.safeParse({ ...base, documentIds: ["d1"], history: [{ role: "user", content: "hi" }] }).success,
    ).toBe(true);
  });

  it("rejects an empty query, a query over the cap, and a threadId field (strict, no such key)", () => {
    expect(AskGuestInput.safeParse({ query: "" }).success).toBe(false);
    expect(AskGuestInput.safeParse({ query: "x".repeat(MAX_QUERY_CHARS + 1) }).success).toBe(false);
    expect(AskGuestInput.safeParse({ ...base, threadId: "anything" }).success).toBe(false);
  });

  it("caps documentIds and history length", () => {
    expect(AskGuestInput.safeParse({ ...base, documentIds: Array(MAX_CONTEXT_DOCUMENTS + 1).fill("d") }).success).toBe(false);
    expect(
      AskGuestInput.safeParse({ ...base, history: Array(MAX_HISTORY_TURNS + 1).fill({ role: "user", content: "hi" }) }).success,
    ).toBe(false);
  });

  it("a documentId is a bounded plain string, never guid-validated — a malformed id must reach the service to 404 the same way a foreign one does, not 400 here", () => {
    expect(AskGuestInput.safeParse({ ...base, documentIds: ["not-a-uuid", "' OR 1=1 --"] }).success).toBe(true);
    expect(AskGuestInput.safeParse({ ...base, documentIds: [""] }).success).toBe(false);
  });
});

describe("AskMessageInput — POST /api/threads/:id/messages", () => {
  it("accepts only a query; a client can't smuggle documentIds/history onto a saved thread's turn", () => {
    expect(AskMessageInput.safeParse({ query: "hi" }).success).toBe(true);
    expect(AskMessageInput.safeParse({ query: "hi", documentIds: ["d1"] }).success).toBe(false);
    expect(AskMessageInput.safeParse({ query: "hi", history: [] }).success).toBe(false);
  });
});

describe("Imported citations/messages — client statuses are DISCARDED, not rejected", () => {
  it("ImportedCitationInput strips a client-sent status/span/verified/unverifiedCachedStatus rather than 400ing the real client's payload", () => {
    const parsed = ImportedCitationInput.parse({
      quoteText: "the rent is 20000",
      sourceDocumentId: "doc-1",
      status: "verified",
      spanStart: 0,
      spanEnd: 5,
      verified: true,
      unverifiedCachedStatus: "cached_verified", // exactly what src/lib/guest-thread-store.ts's real client sends
    });
    expect(parsed).toEqual({ quoteText: "the rent is 20000", sourceDocumentId: "doc-1" });
  });

  it("sourceDocumentId is a bounded plain string, not guid-validated — a foreign/unknown id must reach the service to become unlinked/not_found, never a 400", () => {
    expect(ImportedCitationInput.safeParse({ quoteText: "x", sourceDocumentId: "not-a-uuid" }).success).toBe(true);
  });

  it("ImportedMessageInput strips extra client fields on a message (e.g. a client-side id/createdAtMs) and keeps only what ask.ts reads", () => {
    const parsed = ImportedMessageInput.parse({
      id: "client-local-id",
      role: "assistant",
      content: "The rent is 20000.",
      mode: "grounded",
      modelUsed: "gemini-2.5-flash",
      citations: [{ quoteText: "20000", sourceDocumentId: "doc-1", status: "verified" }],
      createdAtMs: 1234,
    });
    expect(Object.keys(parsed).sort()).toEqual(["citations", "content", "mode", "modelUsed", "role"]);
    expect(parsed.citations?.[0]).toEqual({ quoteText: "20000", sourceDocumentId: "doc-1" });
  });
});

describe("CreateThreadInput", () => {
  it("accepts a title alone, and with documentIds/importedMessages", () => {
    expect(CreateThreadInput.safeParse({ title: "Lease questions" }).success).toBe(true);
    expect(
      CreateThreadInput.safeParse({
        title: "Lease questions",
        documentIds: ["d1"],
        importedMessages: [{ role: "user", content: "hi" }],
      }).success,
    ).toBe(true);
  });

  it("rejects a title over the cap and an unknown top-level key (strict)", () => {
    expect(CreateThreadInput.safeParse({ title: "x".repeat(MAX_THREAD_TITLE_CHARS + 1) }).success).toBe(false);
    expect(CreateThreadInput.safeParse({ title: "t", status: "verified" }).success).toBe(false);
  });

  // ask.ts's assertImportWithinCaps counts citations aggregated across the whole import
  // (MAX_IMPORTED_CITATIONS = 100 total), not per message — this contract must reject the same
  // total the service would, even split across multiple messages.
  it("caps total citations across ALL imported messages, not just per message", () => {
    const citation = { quoteText: "q", sourceDocumentId: "d1" };
    const messagesWith = (perMessage: number[]) =>
      perMessage.map((n) => ({ role: "assistant" as const, content: "c", mode: "grounded" as const, citations: Array(n).fill(citation) }));

    // Exactly the aggregate cap, split across two messages: accepted.
    expect(CreateThreadInput.safeParse({ title: "t", importedMessages: messagesWith([60, 40]) }).success).toBe(true);
    // One over the aggregate cap, split across two messages (neither alone exceeds the per-message
    // cap) — still rejected.
    expect(CreateThreadInput.safeParse({ title: "t", importedMessages: messagesWith([60, 41]) }).success).toBe(false);
    // The same one-over total on a single message.
    expect(CreateThreadInput.safeParse({ title: "t", importedMessages: messagesWith([101]) }).success).toBe(false);
  });
});

describe("ListMessagesInput", () => {
  it("coerces a query-string limit and caps it", () => {
    expect(ListMessagesInput.parse({ limit: "10" })).toEqual({ limit: 10 });
    expect(ListMessagesInput.safeParse({}).success).toBe(true);
    expect(ListMessagesInput.safeParse({ limit: "0" }).success).toBe(false);
    expect(ListMessagesInput.safeParse({ limit: "201" }).success).toBe(false);
    expect(ListMessagesInput.safeParse({ limit: "not-a-number" }).success).toBe(false);
  });
});

describe("response shapes — general mode and citation spanText", () => {
  const citation = {
    id: "0c0c0c0c-0000-4000-8000-00000000000c",
    sourceDocumentId: "0d0d0d0d-0000-4000-8000-00000000000d",
    verification: { status: "verified", spanStart: 0, spanEnd: 10, spanText: "Rs. 32,000", verifierVersion: "2.0.0" },
  };

  it("AskCitationOutput requires the shared VerificationOutput, never a raw status string, and has no top-level quote/model-text field", () => {
    expect(AskCitationOutput.safeParse(citation).success).toBe(true);
    expect(AskCitationOutput.safeParse({ ...citation, verification: "verified" }).success).toBe(false);
    // A top-level `quote` is stripped, never round-tripped — a verified citation must show only the
    // server-cut spanText, never raw model text beside it.
    const parsed = AskCitationOutput.parse({ ...citation, quote: "the model's own (possibly different) phrasing" });
    expect(Object.keys(parsed)).not.toContain("quote");
  });

  const groundedBase = {
    id: "0e0e0e0e-0000-4000-8000-00000000000e",
    role: "assistant",
    content: "The fee is Rs. 32,000.",
    provenance: "ai_generated",
    modelUsed: "gemini-2.5-flash",
    routedDomains: ["tenancy"],
    createdAt: "2026-09-23T10:00:00.000Z",
    mode: "grounded",
    citations: [citation],
  };
  const generalBase = {
    id: null,
    role: "assistant",
    content: "General information.",
    provenance: "ai_generated",
    modelUsed: "none",
    routedDomains: [],
    createdAt: null,
    mode: "general",
    redirect: true,
    label: GENERAL_MODE_LABEL,
  };

  it("GroundedAssistantMessageOutput and GeneralAssistantMessageOutput both parse, and ThreadMessageOutput admits either plus a user message", () => {
    expect(GroundedAssistantMessageOutput.safeParse(groundedBase).success).toBe(true);
    expect(GeneralAssistantMessageOutput.safeParse(generalBase).success).toBe(true);
    expect(ThreadMessageOutput.safeParse(groundedBase).success).toBe(true);
    expect(ThreadMessageOutput.safeParse(generalBase).success).toBe(true);
    expect(
      ThreadMessageOutput.safeParse({
        id: "0f0f0f0f-0000-4000-8000-00000000000f",
        role: "user",
        content: "hi",
        createdAt: "2026-09-23T10:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  it("general mode has no status/citations/verification key anywhere — a spread carrying one is stripped, never round-tripped", () => {
    const forged = { ...generalBase, citations: [citation], status: "verified", verification: citation.verification };
    const parsed = GeneralAssistantMessageOutput.parse(forged);
    expect(Object.keys(parsed).sort()).toEqual([
      "content",
      "createdAt",
      "id",
      "label",
      "mode",
      "modelUsed",
      "provenance",
      "redirect",
      "role",
      "routedDomains",
    ]);
    expect(JSON.stringify(parsed)).not.toContain("status");
    expect(JSON.stringify(parsed)).not.toContain("verification");
  });

  it("label only accepts the exact fixed string", () => {
    expect(GeneralAssistantMessageOutput.safeParse({ ...generalBase, label: "trust me" }).success).toBe(false);
  });

  it("AskEventOutput admits token and final only — the error variant is handled by sse.ts before this schema ever runs", () => {
    expect(AskEventOutput.safeParse({ type: "token", text: "Hello" }).success).toBe(true);
    expect(AskEventOutput.safeParse({ type: "final", message: generalBase }).success).toBe(true);
    expect(AskEventOutput.safeParse({ type: "error", code: "RATE_LIMITED" }).success).toBe(false);
  });

  it("a token event carries no status key even if one is smuggled in — stripped, never round-tripped", () => {
    const parsed = AskEventOutput.parse({ type: "token", text: "Hello", status: "verified" });
    expect(Object.keys(parsed).sort()).toEqual(["text", "type"]);
  });
});

// These caps are hand-copied literals: contracts import nothing from @/server/services, so nothing
// server-only can be bundled for an isomorphic client alongside. This test catches drift a bare
// hand-copy can't: if ask.ts ever changes a cap without this file being updated too, it fails loudly.
describe("caps mirror the service's own exported constants exactly", () => {
  it("every mirrored constant equals its source", () => {
    expect(MAX_QUERY_CHARS).toBe(askService.MAX_QUERY_CHARS);
    expect(MAX_CONTEXT_DOCUMENTS).toBe(askService.MAX_CONTEXT_DOCUMENTS);
    expect(MAX_THREAD_TITLE_CHARS).toBe(askService.MAX_THREAD_TITLE_CHARS);
    expect(MAX_IMPORTED_MESSAGES).toBe(askService.MAX_IMPORTED_MESSAGES);
    expect(MAX_IMPORTED_MESSAGE_CHARS).toBe(askService.MAX_IMPORTED_MESSAGE_CHARS);
    expect(MAX_IMPORTED_CITATIONS).toBe(askService.MAX_IMPORTED_CITATIONS);
    expect(MAX_HISTORY_TURNS).toBe(askService.MAX_HISTORY_TURNS);
    expect(MAX_HISTORY_CHARS).toBe(askService.MAX_HISTORY_CHARS);
    // MAX_QUOTE_CHARS mirrors src/server/deterministic/verify's own constant (the same one ask.ts
    // itself imports and re-checks against) — not an ask.ts export directly.
    expect(MAX_QUOTE_CHARS).toBe(ASK_MAX_QUOTE_CHARS);
    // MAX_LIST_MESSAGES_LIMIT mirrors data/messages.ts's MAX_RECENT_MESSAGES_LIMIT — the real cap
    // listRecentMessages/askService.listRecentMessages clamp `limit` to.
    expect(MAX_LIST_MESSAGES_LIMIT).toBe(MAX_RECENT_MESSAGES_LIMIT);
    // ask.ts's own MAX_IMPORTED_MESSAGES is itself defined as `= MAX_RECENT_MESSAGES_LIMIT` (its
    // file header states this) — pinned here too, so a future divergence between the two service-
    // side constants themselves would also be caught.
    expect(askService.MAX_IMPORTED_MESSAGES).toBe(MAX_RECENT_MESSAGES_LIMIT);
  });
});
