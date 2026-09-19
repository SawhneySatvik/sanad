// validateDocuments()'s two unrelated failures, kept distinct: duplicate document ids is a client
// bug, never a document problem, so it stays VALIDATION_FAILED; an over-budget document set is the
// document's own fault, so it's INVALID_DOCUMENT/grounding_too_long — the two must never collapse
// into one code, and the over-budget case must never lose its reason.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { runOrchestrator } from "@/server/orchestrator/run-orchestrator";
import { MAX_DOCUMENTS_TOTAL_CHARS } from "@/server/orchestrator/config";
import type { OrchestratorDocumentInput, OrchestratorErrorEvent, OrchestratorEvent } from "@/server/orchestrator/types";

// Compile-time proof, not a runtime one: constructing an INVALID_DOCUMENT error event with no
// `reason` must fail tsc on its own, before any test ever runs — never() is unreachable, so nothing
// here executes; the value only has to type-check.
function typeLevelProofs(): void {
  // @ts-expect-error — INVALID_DOCUMENT requires `reason`; this omits it.
  const missingReason: OrchestratorErrorEvent = { type: "error", code: "INVALID_DOCUMENT" };
  const withReason: OrchestratorErrorEvent = { type: "error", code: "INVALID_DOCUMENT", reason: "empty" };
  void missingReason;
  void withReason;
}
void typeLevelProofs;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function makeDoc(id: string, canonicalText: string): OrchestratorDocumentInput {
  return { id, canonicalText, canonicalTextHash: sha256(canonicalText), inputMode: "text" };
}

async function collect(events: AsyncIterable<OrchestratorEvent>): Promise<OrchestratorEvent[]> {
  const out: OrchestratorEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("validateDocuments — duplicate ids vs an over-budget document set", () => {
  it("duplicate document ids: VALIDATION_FAILED, no reason, zero LLM calls", async () => {
    const client = new FakeLlmClient({ defaultResponse: { data: { answer: "unused", citations: [] } } });
    const doc1 = makeDoc("dup-id", "First document text.");
    const doc2 = makeDoc("dup-id", "Second document text, different content.");

    const events = await collect(runOrchestrator({ query: "what does my lease say?", documents: [doc1, doc2], llmClient: client }));

    expect(events).toEqual([{ type: "error", code: "VALIDATION_FAILED" }]);
    expect(client.callCount).toBe(0);
  });

  it("an over-budget document set: INVALID_DOCUMENT with reason grounding_too_long, never VALIDATION_FAILED, zero LLM calls", async () => {
    const client = new FakeLlmClient({ defaultResponse: { data: { answer: "unused", citations: [] } } });
    const huge = makeDoc("doc-huge", "x".repeat(MAX_DOCUMENTS_TOTAL_CHARS + 1));

    const events = await collect(runOrchestrator({ query: "what does my lease say?", documents: [huge], llmClient: client }));

    expect(events).toEqual([{ type: "error", code: "INVALID_DOCUMENT", reason: "grounding_too_long" }]);
    expect(client.callCount).toBe(0);
  });

  it("both conditions at once: duplicate ids checked first, so it stays VALIDATION_FAILED even though the set is also over budget", async () => {
    const client = new FakeLlmClient({ defaultResponse: { data: { answer: "unused", citations: [] } } });
    const half = "x".repeat(Math.ceil(MAX_DOCUMENTS_TOTAL_CHARS / 2) + 1);
    const doc1 = makeDoc("dup-id", half);
    const doc2 = makeDoc("dup-id", half);

    const events = await collect(runOrchestrator({ query: "what does my lease say?", documents: [doc1, doc2], llmClient: client }));

    expect(events).toEqual([{ type: "error", code: "VALIDATION_FAILED" }]);
    expect(client.callCount).toBe(0);
  });
});
