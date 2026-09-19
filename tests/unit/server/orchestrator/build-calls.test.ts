import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { boundedHistory, buildSpecialistCallInput, buildSynthesisCallInput } from "@/server/orchestrator/build-calls";
import { MAX_HISTORY_CHARS, MAX_HISTORY_TURNS } from "@/server/orchestrator/config";
import { specialistOutputSchema } from "@/server/orchestrator/schema";
import type { OrchestratorDocumentInput, OrchestratorHistoryMessage } from "@/server/orchestrator/types";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const doc: OrchestratorDocumentInput = {
  id: "doc-123",
  canonicalText: "The rent is 20000 per month.",
  canonicalTextHash: sha256("The rent is 20000 per month."),
  inputMode: "text",
  documentType: "leave_and_license",
};

describe("buildSpecialistCallInput", () => {
  it("grounded mode: embeds the document's id, type, and full canonical text between a hash-derived boundary", () => {
    const input = buildSpecialistCallInput("tenancy", "what is the rent?", undefined, [doc], "grounded");
    expect(input.userPrompt).toContain('id="doc-123"');
    expect(input.userPrompt).toContain('type="leave_and_license"');
    expect(input.userPrompt).toContain(doc.canonicalText);
    expect(input.userPrompt).toContain("User question: what is the rent?");
    expect(input.schema).toBe(specialistOutputSchema);
  });

  it("general mode: never embeds document text even if documents were somehow passed in", () => {
    const input = buildSpecialistCallInput("tenancy", "what is the rent?", undefined, [doc], "general");
    expect(input.userPrompt).not.toContain(doc.canonicalText);
    expect(input.userPrompt).not.toContain("doc-123");
  });

  it("includes conversation history when given, in role: content lines", () => {
    const input = buildSpecialistCallInput(
      "tenancy",
      "and the deposit?",
      [
        { role: "user", content: "what is the rent?" },
        { role: "assistant", content: "The rent is 20000 per month." },
      ],
      [],
      "general",
    );
    expect(input.userPrompt).toContain("user: what is the rent?");
    expect(input.userPrompt).toContain("assistant: The rent is 20000 per month.");
  });

  it("does not use LlmCompleteInput.documents at all — canonical text is embedded inline instead", () => {
    const input = buildSpecialistCallInput("tenancy", "what is the rent?", undefined, [doc], "grounded");
    expect(input.documents).toBeUndefined();
  });
});

describe("boundedHistory (context cap, config.ts)", () => {
  function turn(i: number, contentLength = 10): OrchestratorHistoryMessage {
    return { role: i % 2 === 0 ? "user" : "assistant", content: `msg-${i}-`.padEnd(contentLength, "x") };
  }

  it("keeps only the most recent MAX_HISTORY_TURNS messages", () => {
    const history = Array.from({ length: MAX_HISTORY_TURNS + 20 }, (_, i) => turn(i, 5));
    const bounded = boundedHistory(history);
    expect(bounded.length).toBeLessThanOrEqual(MAX_HISTORY_TURNS);
    // The kept turns are exactly the tail of the input (most recent), in order.
    expect(bounded[bounded.length - 1]).toEqual(history[history.length - 1]);
  });

  it("drops whole oldest turns (never truncates a turn's own content) until under MAX_HISTORY_CHARS", () => {
    // Few enough turns to stay under MAX_HISTORY_TURNS, but each large enough that the total
    // exceeds MAX_HISTORY_CHARS — forces the char-budget path, not the turn-count path.
    const bigTurn = (i: number): OrchestratorHistoryMessage => ({
      role: "user",
      content: `turn-${i}-`.padEnd(2_000, "x"),
    });
    const history = Array.from({ length: 5 }, (_, i) => bigTurn(i)); // 5 * 2000 = 10,000 > MAX_HISTORY_CHARS
    const bounded = boundedHistory(history);
    const totalChars = bounded.reduce((sum, m) => sum + m.content.length, 0);
    // Under budget (or down to the single most recent turn, which is never truncated even if
    // it alone exceeds the budget).
    expect(totalChars <= MAX_HISTORY_CHARS || bounded.length === 1).toBe(true);
    // Every kept turn's content is byte-for-byte one of the ORIGINAL turns' content — never a
    // truncated substring of one.
    for (const m of bounded) {
      expect(history.some((h) => h.content === m.content)).toBe(true);
    }
    // The most recent turn always survives (never dropped from the recent end).
    expect(bounded[bounded.length - 1]).toEqual(history[history.length - 1]);
  });

  it("2000 x 1KB history messages produce a bounded prompt, not a multi-megabyte one", () => {
    const history: OrchestratorHistoryMessage[] = Array.from({ length: 2000 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}: `.padEnd(1024, "x"),
    }));
    const input = buildSpecialistCallInput("tenancy", "and now?", history, [], "general");
    // Well under a naive "all 2000 * 1024 chars" (~2.05M-char) prompt — bounded by
    // MAX_HISTORY_TURNS * (a single ~1KB turn) plus a small fixed overhead.
    expect(input.userPrompt.length).toBeLessThan(MAX_HISTORY_TURNS * 1200);
  });

  it("returns [] for empty/undefined history", () => {
    expect(boundedHistory(undefined)).toEqual([]);
    expect(boundedHistory([])).toEqual([]);
  });
});

describe("buildSynthesisCallInput", () => {
  it("never embeds a document BEGIN/END block or raw canonical text — only the specialists' own JSON-encoded results, each in its own delimited block", () => {
    const specialistResults = [
      { id: "tenancy" as const, answer: "Tenancy answer.", citations: [{ quote: "20000", sourceDocumentId: "doc-123" }] },
      { id: "employment" as const, answer: "Employment answer.", citations: [] },
    ];
    const input = buildSynthesisCallInput(specialistResults, "what is the rent and my notice period?", "grounded");
    // Falsifiable: checks for the document-block marker itself, not just the sentence-level document
    // text (which is absent by construction regardless of implementation) — if a future change
    // re-introduced document-block embedding into synthesis, this marker would appear.
    expect(input.userPrompt).not.toContain("<<<DOCUMENT-");
    expect(input.userPrompt).toContain("<<<SPECIALIST-1-");
    expect(input.userPrompt).toContain("<<<SPECIALIST-2-");
    expect(input.userPrompt).toContain(JSON.stringify({ answer: specialistResults[0].answer, citations: specialistResults[0].citations }));
    expect(input.userPrompt).toContain(JSON.stringify({ answer: specialistResults[1].answer, citations: specialistResults[1].citations }));
    expect(input.documents).toBeUndefined();
  });
});
