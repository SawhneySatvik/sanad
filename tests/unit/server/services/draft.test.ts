// Cross-principal cases live in draft.idor.test.ts (collected by `npm test -- idor`).

import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { Db } from "@/db/client";
import { AppError } from "@/server/core/errors";
import { aiSectionKeys, DRAFT_TEMPLATES, requiredSectionKeys } from "@/server/deterministic/draft-templates";
import { FakeLlmClient } from "@tests/support/fakes/llm-client";
import { LLM_TIMEOUT_MS } from "@/server/llm/timeouts";
import type { LlmClient, LlmCompleteInput, LlmCompleteResult, LlmStreamEvent } from "@/server/llm/types";
import type { ZodType } from "zod";
import { create, get, revise, type DraftProvenance, type DraftSectionOutput } from "@/server/services/draft";
import { createHarness, draftModelOutput, guestA, readyDocument, templatedKeysFor, type Harness, userA } from "@tests/support/services/draft";

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

async function caught(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("create — from_scratch", () => {
  it("persists templated sections from draft-templates (never the model), ai_generated sections from the model", async () => {
    const llm = new FakeLlmClient({ responses: [{ data: draftModelOutput("nda") }] });
    const result = await create(h.deps(llm), guestA, {
      mode: "from_scratch",
      documentType: "nda",
      userInstructions: "An NDA between Acme Pvt Ltd and a contractor, 2-year term.",
      jurisdiction: "IN",
    });

    expect(result.mode).toBe("from_scratch");
    expect(result.documentType).toBe("nda");
    expect(result.groundingDocumentId).toBeNull();
    expect(result.revisionNumber).toBe(1);
    expect(result.parentDraftId).toBeNull();
    expect(result.modelUsed).toBe("fake-model");
    expect(result.sections.map((s) => s.key)).toEqual(requiredSectionKeys("nda"));

    for (const section of result.sections) {
      const template = DRAFT_TEMPLATES.nda.sections.find((s) => s.key === section.key)!;
      expect(section.heading).toBe(template.heading);
      expect(section.provenance).toBe(template.provenance);
      if (template.provenance === "templated") {
        expect(section.content).toBe(template.body);
      } else {
        expect(section.content).toBe(`Generated body for ${section.key}.`);
      }
    }
    expect((await h.counts()).drafts).toBe(1);
    expect((await h.counts()).sections).toBe(requiredSectionKeys("nda").length);
  });

  it("the model cannot override a templated section — an extra key for it is ignored", async () => {
    const output = draftModelOutput("nda");
    for (const key of templatedKeysFor("nda")) (output.sections as Record<string, string>)[key] = "HACKED TEMPLATED SECTION";
    const llm = new FakeLlmClient({ responses: [{ data: output }] });
    const result = await create(h.deps(llm), guestA, {
      mode: "from_scratch",
      documentType: "nda",
      userInstructions: "Draft it.",
      jurisdiction: "IN",
    });
    for (const key of templatedKeysFor("nda")) {
      const section = result.sections.find((s) => s.key === key)!;
      expect(section.content).not.toContain("HACKED");
      expect(section.content).toBe(DRAFT_TEMPLATES.nda.sections.find((s) => s.key === key)!.body);
    }
  });

  it("rejects a non-draftable document type before ever calling the model", async () => {
    const llm = new FakeLlmClient({ defaultResponse: { data: draftModelOutput("nda") } });
    const error = await caught(create(h.deps(llm), guestA, { mode: "from_scratch", documentType: "generic" as never, userInstructions: "x", jurisdiction: "IN" }));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(llm.callCount).toBe(0);
  });

  it("rejects mode/groundingDocumentId mismatches before calling the model", async () => {
    const llm = new FakeLlmClient({ defaultResponse: { data: draftModelOutput("nda") } });
    const grounded = await caught(create(h.deps(llm), guestA, { mode: "document_grounded", documentType: "nda", userInstructions: "x", jurisdiction: "IN" }));
    expect(grounded.code).toBe("VALIDATION_FAILED");
    const doc = await readyDocument(h.t, guestA);
    const scratch = await caught(
      create(h.deps(llm), guestA, { mode: "from_scratch", documentType: "nda", groundingDocumentId: doc.id, userInstructions: "x", jurisdiction: "IN" }),
    );
    expect(scratch.code).toBe("VALIDATION_FAILED");
    expect(llm.callCount).toBe(0);
  });

  it("rejects an unsupported jurisdiction and blank/oversized instructions before calling the model", async () => {
    const llm = new FakeLlmClient({ defaultResponse: { data: draftModelOutput("nda") } });
    expect((await caught(create(h.deps(llm), guestA, { mode: "from_scratch", documentType: "nda", userInstructions: "x", jurisdiction: "US" }))).code).toBe(
      "VALIDATION_FAILED",
    );
    expect((await caught(create(h.deps(llm), guestA, { mode: "from_scratch", documentType: "nda", userInstructions: "   ", jurisdiction: "IN" }))).code).toBe(
      "VALIDATION_FAILED",
    );
    expect(
      (await caught(create(h.deps(llm), guestA, { mode: "from_scratch", documentType: "nda", userInstructions: "x".repeat(5000), jurisdiction: "IN" }))).code,
    ).toBe("VALIDATION_FAILED");
    expect(llm.callCount).toBe(0);
  });
});

describe("create — document_grounded", () => {
  it("passes the grounding document's canonical text to the model, delimited as data", async () => {
    const doc = await readyDocument(h.t, guestA, "Notice: vacate within 30 days or pay a penalty.");
    const llm = new FakeLlmClient({ responses: [{ data: draftModelOutput("grounded_response") }] });
    const result = await create(h.deps(llm), guestA, {
      mode: "document_grounded",
      documentType: "grounded_response",
      groundingDocumentId: doc.id,
      userInstructions: "Reply asking for a 15-day extension.",
      jurisdiction: "IN",
    });
    expect(result.groundingDocumentId).toBe(doc.id);
    expect(llm.calls[0].userPrompt).toContain("vacate within 30 days");
  });

  it("a document not yet ready (still processing) is INVALID_DOCUMENT, no model call", async () => {
    const { createPendingDocument } = await import("@/server/data/documents");
    const { refFor } = await import("@tests/support/data/documents");
    const pending = await createPendingDocument(h.t.db, guestA, { storageRef: refFor(guestA), filename: "x.txt", mimeType: "text/plain" });
    const llm = new FakeLlmClient({ defaultResponse: { data: draftModelOutput("grounded_response") } });
    const error = await caught(
      create(h.deps(llm), guestA, { mode: "document_grounded", documentType: "grounded_response", groundingDocumentId: pending.id, userInstructions: "x", jurisdiction: "IN" }),
    );
    expect(error.code).toBe("INVALID_DOCUMENT");
    expect(error.reason).toBe("grounding_not_ready");
    expect(llm.callCount).toBe(0);
  });

  it("create() always returns groundingDocumentAvailable: true for a successfully created grounded draft; null for from_scratch", async () => {
    const doc = await readyDocument(h.t, guestA);
    const grounded = await create(h.deps(new FakeLlmClient({ responses: [{ data: draftModelOutput("grounded_response") }] })), guestA, {
      mode: "document_grounded",
      documentType: "grounded_response",
      groundingDocumentId: doc.id,
      userInstructions: "x",
      jurisdiction: "IN",
    });
    expect(grounded.groundingDocumentAvailable).toBe(true);

    const scratch = await create(h.deps(new FakeLlmClient({ responses: [{ data: draftModelOutput("nda") }] })), guestA, {
      mode: "from_scratch",
      documentType: "nda",
      userInstructions: "x",
      jurisdiction: "IN",
    });
    expect(scratch.groundingDocumentAvailable).toBeNull();
  });
});

// revise() on a document_grounded draft whose grounding document becomes unavailable — gone, not
// ready, or foreign — must proceed without it, say so on the result, and never claim a DOCUMENT
// block follows or leak the unavailable document's real content into the prompt sent to the model.
describe("revise() when the grounding document is unavailable", () => {
  it("gone (grounding_document_id SET NULL after the document is deleted): proceeds without it, groundingDocumentAvailable: false", async () => {
    const doc = await readyDocument(h.t, guestA, "CONFIDENTIAL: vacate within 30 days.");
    const setupLlm = new FakeLlmClient({ responses: [{ data: draftModelOutput("grounded_response") }] });
    const root = await create(h.deps(setupLlm), guestA, {
      mode: "document_grounded",
      documentType: "grounded_response",
      groundingDocumentId: doc.id,
      userInstructions: "x",
      jurisdiction: "IN",
    });
    await h.t.db.delete(schema.documents).where(eq(schema.documents.id, doc.id)); // fires ON DELETE SET NULL

    const llm = new FakeLlmClient({ responses: [{ data: draftModelOutput("grounded_response") }] });
    const revision = await revise(h.deps(llm), guestA, root.id, { userInstructions: "revise it" });

    expect(revision.groundingDocumentId).toBeNull();
    expect(revision.groundingDocumentAvailable).toBe(false);
    expect(llm.calls[0].systemPrompt).not.toContain("the DOCUMENT block below is what you are responding to");
    expect(llm.calls[0].systemPrompt).toContain("no DOCUMENT block follows");
    expect(llm.calls[0].userPrompt).not.toContain("CONFIDENTIAL");
  });

  it("not ready (defensive: a document that regressed out of 'ready'): proceeds without it, groundingDocumentAvailable: false", async () => {
    const doc = await readyDocument(h.t, guestA, "CONFIDENTIAL: not-ready text.");
    const setupLlm = new FakeLlmClient({ responses: [{ data: draftModelOutput("grounded_response") }] });
    const root = await create(h.deps(setupLlm), guestA, {
      mode: "document_grounded",
      documentType: "grounded_response",
      groundingDocumentId: doc.id,
      userInstructions: "x",
      jurisdiction: "IN",
    });
    await h.t.db.update(schema.documents).set({ processingStatus: "pending" }).where(eq(schema.documents.id, doc.id));

    const llm = new FakeLlmClient({ responses: [{ data: draftModelOutput("grounded_response") }] });
    const revision = await revise(h.deps(llm), guestA, root.id, { userInstructions: "revise it" });

    expect(revision.groundingDocumentId).toBe(doc.id); // FK still points there — just not usable
    expect(revision.groundingDocumentAvailable).toBe(false);
    expect(llm.calls[0].userPrompt).not.toContain("CONFIDENTIAL");
  });

  it("foreign (re-owned away from the calling principal since the draft was created): re-fetch is principal-scoped, zero leakage", async () => {
    const doc = await readyDocument(h.t, guestA, "CONFIDENTIAL: guestA's own document text.");
    const setupLlm = new FakeLlmClient({ responses: [{ data: draftModelOutput("grounded_response") }] });
    const root = await create(h.deps(setupLlm), guestA, {
      mode: "document_grounded",
      documentType: "grounded_response",
      groundingDocumentId: doc.id,
      userInstructions: "x",
      jurisdiction: "IN",
    });
    // Simulates the document becoming foreign to guestA between the root's creation and this
    // revision (e.g. a future re-ownership event) — direct row update, no claim flow exists yet.
    // "repo-guest-b" matches guestB's own guestSessionId (documents.test-support.ts) — used as a
    // literal here since Principal is a discriminated union TS won't narrow through a plain import.
    await h.t.db.update(schema.documents).set({ ownerGuestSessionId: "repo-guest-b" }).where(eq(schema.documents.id, doc.id));

    const llm = new FakeLlmClient({ responses: [{ data: draftModelOutput("grounded_response") }] });
    await expect(revise(h.deps(llm), guestA, root.id, { userInstructions: "revise it" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(llm.callCount).toBe(0);
    const stored = await h.t.db.select().from(schema.drafts);
    expect(stored).toHaveLength(1);
  });
});

describe("revise() persists the model that produced THIS revision, never the parent's", () => {
  it("create() and revise() use distinct FakeLlmClient instances with different modelUsed — the revision's own value wins", async () => {
    const createLlm = new FakeLlmClient({ responses: [{ data: draftModelOutput("nda") }], modelUsed: "model-a-created-it" });
    const root = await create(h.deps(createLlm), guestA, { mode: "from_scratch", documentType: "nda", userInstructions: "v1", jurisdiction: "IN" });
    expect(root.modelUsed).toBe("model-a-created-it");

    const reviseLlm = new FakeLlmClient({ responses: [{ data: draftModelOutput("nda") }], modelUsed: "model-b-revised-it" });
    const revision = await revise(h.deps(reviseLlm), guestA, root.id, { userInstructions: "v2" });
    expect(revision.modelUsed).toBe("model-b-revised-it");
    expect(revision.modelUsed).not.toBe(root.modelUsed);

    const reread = await get(h.deps(reviseLlm), guestA, revision.id);
    expect(reread.modelUsed).toBe("model-b-revised-it");
  });
});

describe("revision chain inherits the root's expires_at", () => {
  it("a chain of 3 drafts (root + 2 revisions), created end to end through the service, all share the ROOT's expires_at exactly", async () => {
    const llm = new FakeLlmClient({ defaultResponse: { data: draftModelOutput("nda") } });
    const root = await create(h.deps(llm), guestA, { mode: "from_scratch", documentType: "nda", userInstructions: "v1", jurisdiction: "IN" });

    const distinctive = new Date(Date.now() + 23 * 60 * 1000);
    await h.t.db.update(schema.drafts).set({ expiresAt: distinctive }).where(eq(schema.drafts.id, root.id));

    const rev1 = await revise(h.deps(llm), guestA, root.id, { userInstructions: "v2" });
    const rev2 = await revise(h.deps(llm), guestA, rev1.id, { userInstructions: "v3" });

    expect(rev1.expiresAt!.getTime()).toBe(distinctive.getTime());
    expect(rev2.expiresAt!.getTime()).toBe(distinctive.getTime());
    expect(rev1.revisionNumber).toBe(2);
    expect(rev2.revisionNumber).toBe(3);
    expect(rev1.parentDraftId).toBe(root.id);
    expect(rev2.parentDraftId).toBe(rev1.id);

    const reread = await get(h.deps(llm), guestA, rev2.id);
    expect(reread.expiresAt!.getTime()).toBe(distinctive.getTime());
  });

  it("revise() re-generates ai_generated sections and keeps templated ones fixed", async () => {
    const llm = new FakeLlmClient({ responses: [{ data: draftModelOutput("nda") }, { data: draftModelOutput("nda", { term_and_remedies: "Revised: the term is now two years." }) }] });
    const root = await create(h.deps(llm), guestA, { mode: "from_scratch", documentType: "nda", userInstructions: "v1", jurisdiction: "IN" });
    const revision = await revise(h.deps(llm), guestA, root.id, { userInstructions: "Make the term 2 years." });

    expect(revision.sections.find((s) => s.key === "term_and_remedies")!.content).toBe("Revised: the term is now two years.");
    expect(revision.sections.find((s) => s.key === "disclaimer")!.content).toBe(DRAFT_TEMPLATES.nda.sections.find((s) => s.key === "disclaimer")!.body);
    expect(llm.calls[1].userPrompt).toContain("Generated body for parties_and_purpose."); // the parent's previous section, sent as data
  });
});

describe("document_grounded draft's expires_at is capped at the grounding document's earlier expiry", () => {
  it("equals the grounding document's expires_at when it is earlier than the draft's own TTL", async () => {
    const doc = await readyDocument(h.t, guestA);
    const earlier = new Date(Date.now() + 5 * 60 * 1000);
    await h.t.db.update(schema.documents).set({ expiresAt: earlier }).where(eq(schema.documents.id, doc.id));

    const llm = new FakeLlmClient({ responses: [{ data: draftModelOutput("grounded_response") }] });
    const result = await create(h.deps(llm), guestA, {
      mode: "document_grounded",
      documentType: "grounded_response",
      groundingDocumentId: doc.id,
      userInstructions: "x",
      jurisdiction: "IN",
    });
    expect(result.expiresAt!.getTime()).toBe(earlier.getTime());
  });
});

describe("structural guarantee: provenance never implies verification", () => {
  it("type-level: DraftSectionOutput's provenance rejects \"verified\"", () => {
    // @ts-expect-error "verified" is not a member of DraftProvenance — see draft-templates/types.ts.
    const forbidden: DraftProvenance = "verified";
    expect(forbidden).toBe("verified");

    // @ts-expect-error "status" is not a key of DraftSectionOutput — the shape has provenance, never
    // a verification status.
    const withStatus: DraftSectionOutput = { key: "k", heading: "H", provenance: "templated", content: "c", status: "verified" };
    expect(withStatus.content).toBe("c");
  });

  it("runtime: a persisted section carries exactly {key, heading, provenance, content} — no status field", async () => {
    const llm = new FakeLlmClient({ responses: [{ data: draftModelOutput("nda") }] });
    const result = await create(h.deps(llm), guestA, { mode: "from_scratch", documentType: "nda", userInstructions: "x", jurisdiction: "IN" });
    for (const section of result.sections) {
      expect(Object.keys(section).sort()).toEqual(["content", "heading", "key", "provenance"]);
      expect(["templated", "ai_generated"]).toContain(section.provenance);
    }
  });
});

describe("atomicity: no partial persistence", () => {
  it("a model response missing a required ai_generated section (even after the repair retry) throws SCHEMA_FAILED and persists nothing", async () => {
    const keys = aiSectionKeys("nda");
    const incomplete = { sections: Object.fromEntries(keys.slice(1).map((key) => [key, "x"])) };
    // Two bad attempts queued: completeStructured retries exactly once on schema failure
    // (llm/structured-output.ts MAX_ATTEMPTS = 2) — one bad response alone would under-test this.
    const llm = new FakeLlmClient({ responses: [{ data: incomplete }, { data: incomplete }] });
    const error = await caught(create(h.deps(llm), guestA, { mode: "from_scratch", documentType: "nda", userInstructions: "x", jurisdiction: "IN" }));
    expect(error.code).toBe("SCHEMA_FAILED");
    expect(llm.callCount).toBe(1); // one top-level complete() call, consuming both queued provider attempts internally
    expect((await h.counts()).drafts).toBe(0);
    expect((await h.counts()).sections).toBe(0);
  });

  it("a provider failure propagates immediately (no repair retry for a thrown error) and persists nothing", async () => {
    const llm = new FakeLlmClient({ responses: [{ error: new AppError("UPSTREAM_UNAVAILABLE", "boom") }] });
    const error = await caught(create(h.deps(llm), guestA, { mode: "from_scratch", documentType: "nda", userInstructions: "x", jurisdiction: "IN" }));
    expect(error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect((await h.counts()).drafts).toBe(0);
    expect((await h.counts()).sections).toBe(0);
  });

  // A blank (not merely missing) ai_generated section body must also fail before any row is
  // persisted — prompts/draft/schema.ts's non-blank refine is what's under test here directly in
  // prompt.test.ts; this is the same guarantee exercised end to end through the service.
  it("a model response with a blank (not missing) ai_generated section body throws SCHEMA_FAILED and persists nothing", async () => {
    const blank = draftModelOutput("nda", { term_and_remedies: "   " });
    const llm = new FakeLlmClient({ responses: [{ data: blank }, { data: blank }] });
    const error = await caught(create(h.deps(llm), guestA, { mode: "from_scratch", documentType: "nda", userInstructions: "x", jurisdiction: "IN" }));
    expect(error.code).toBe("SCHEMA_FAILED");
    expect((await h.counts()).drafts).toBe(0);
    expect((await h.counts()).sections).toBe(0);
  });
});

// No repository connection/transaction is held open across the LLM call. A probing LlmClient queries
// the SAME `db` handle from inside complete(); PGlite's single connection means the probe hangs
// forever if create() had a transaction open at that point.
class ProbingLlmClient implements LlmClient {
  probed = false;
  constructor(
    private readonly db: Db,
    private readonly inner: LlmClient,
  ) {}
  get capabilities() {
    return this.inner.capabilities;
  }
  async complete<Schema extends ZodType>(input: LlmCompleteInput<Schema>): Promise<LlmCompleteResult<Schema>> {
    const probe = this.db.select().from(schema.drafts);
    // Generous margin (a real open transaction hangs forever regardless, so this never weakens the
    // check) — a tight bound risks flaking under parallel test-worker load, where a single
    // in-memory PGlite query can occasionally take longer than a few hundred ms.
    const timeout = new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("DB probe timed out — a transaction/connection was held open during the LLM call")), 5000),
    );
    await Promise.race([probe, timeout]);
    this.probed = true;
    return this.inner.complete(input);
  }
  stream<Schema extends ZodType>(input: LlmCompleteInput<Schema>): AsyncIterable<LlmStreamEvent<Schema>> {
    return this.inner.stream(input);
  }
}

describe("no transaction is held open across the LLM call", () => {
  it("create(): a DB probe issued from inside the LlmClient's complete() succeeds — proves no open transaction blocks it", async () => {
    const inner = new FakeLlmClient({ responses: [{ data: draftModelOutput("nda") }] });
    const probing = new ProbingLlmClient(h.t.db, inner);
    await create(h.deps(probing), guestA, { mode: "from_scratch", documentType: "nda", userInstructions: "x", jurisdiction: "IN" });
    expect(probing.probed).toBe(true);
  });

  it("revise(): same probe, on the document_grounded path — two reads (parent + a re-fetched grounding document) before the LLM call", async () => {
    const doc = await readyDocument(h.t, guestA, "Notice: vacate within 30 days.");
    const setupLlm = new FakeLlmClient({ responses: [{ data: draftModelOutput("grounded_response") }] });
    const root = await create(h.deps(setupLlm), guestA, {
      mode: "document_grounded",
      documentType: "grounded_response",
      groundingDocumentId: doc.id,
      userInstructions: "x",
      jurisdiction: "IN",
    });

    const inner = new FakeLlmClient({ responses: [{ data: draftModelOutput("grounded_response") }] });
    const probing = new ProbingLlmClient(h.t.db, inner);
    await revise(h.deps(probing), guestA, root.id, { userInstructions: "revise it" });
    expect(probing.probed).toBe(true);
    // The grounding document was actually re-fetched and re-sent, not skipped.
    expect(inner.calls[0].userPrompt).toContain("vacate within 30 days");
  });
});

describe("get", () => {
  it("round-trips a created draft, sections in template order, modelUsed is the real persisted value", async () => {
    const llm = new FakeLlmClient({ responses: [{ data: draftModelOutput("nda") }], modelUsed: "gemma-fallback" });
    const created = await create(h.deps(llm), guestA, { mode: "from_scratch", documentType: "nda", userInstructions: "x", jurisdiction: "IN" });
    expect(created.modelUsed).toBe("gemma-fallback");
    const reread = await get(h.deps(llm), guestA, created.id);
    expect(reread.modelUsed).toBe("gemma-fallback"); // survives a reload — never lost, never a different model's name
    expect(reread.sections.map((s) => s.key)).toEqual(requiredSectionKeys("nda"));
    expect(reread.content).toBe(created.content);
  });
});

describe("from_scratch / user principal", () => {
  it("a user-owned draft never expires", async () => {
    const llm = new FakeLlmClient({ responses: [{ data: draftModelOutput("nda") }] });
    const result = await create(h.deps(llm), userA, { mode: "from_scratch", documentType: "nda", userInstructions: "x", jurisdiction: "IN" });
    expect(result.expiresAt).toBeNull();
  });
});

describe("revise() carries the same per-section guidance create() does", () => {
  it("revise()'s system prompt lists your_response's guidance (first person, the reply itself), and its user prompt tells the model to fix a section's form even where the new instructions didn't ask for it", async () => {
    const setupLlm = new FakeLlmClient({ responses: [{ data: draftModelOutput("grounded_response") }] });
    const root = await create(h.deps(setupLlm), guestA, {
      mode: "from_scratch",
      documentType: "grounded_response",
      userInstructions: "Reply to HR asking to remove the outside-hours clause.",
      jurisdiction: "IN",
    });

    const reviseLlm = new FakeLlmClient({ responses: [{ data: draftModelOutput("grounded_response") }] });
    await revise(h.deps(reviseLlm), guestA, root.id, { userInstructions: "Make it firmer." });

    const line = reviseLlm.calls[0].systemPrompt.split("\n").find((l) => l.trimStart().startsWith("- your_response"));
    expect(line).toBeDefined();
    expect(line).toContain("first person");
    expect(line).toContain("the reply itself");
    expect(reviseLlm.calls[0].userPrompt).toContain("must still match that section's own guidance");
  });
});

describe("get() on a draft older than a section its template has since gained", () => {
  it("drops the missing section instead of throwing, and keeps every section the draft actually has", async () => {
    const llm = new FakeLlmClient({ responses: [{ data: draftModelOutput("freelance_service_agreement") }] });
    const root = await create(h.deps(llm), guestA, {
      mode: "from_scratch",
      documentType: "freelance_service_agreement",
      userInstructions: "x",
      jurisdiction: "IN",
    });
    expect(root.sections.map((s) => s.key)).toContain("governing_law_and_disputes");

    // Simulates a draft that predates governing_law_and_disputes: no such row was ever inserted for
    // it, the same shape a pre-existing draft in the database has today.
    await h.t.db
      .delete(schema.draftSections)
      .where(and(eq(schema.draftSections.draftId, root.id), eq(schema.draftSections.sectionKey, "governing_law_and_disputes")));

    const reread = await get(h.deps(llm), guestA, root.id);
    expect(reread.sections.map((s) => s.key)).not.toContain("governing_law_and_disputes");
    expect(reread.sections.map((s) => s.key)).toEqual(requiredSectionKeys("freelance_service_agreement").filter((k) => k !== "governing_law_and_disputes"));
    expect(reread.content).toBe(root.content); // the pre-rendered content column is untouched by the row deletion
  });

  it("revise() self-heals: the missing section is regenerated and persisted, satisfying the current template's exact section set", async () => {
    const llm = new FakeLlmClient({ responses: [{ data: draftModelOutput("freelance_service_agreement") }] });
    const root = await create(h.deps(llm), guestA, {
      mode: "from_scratch",
      documentType: "freelance_service_agreement",
      userInstructions: "x",
      jurisdiction: "IN",
    });
    await h.t.db
      .delete(schema.draftSections)
      .where(and(eq(schema.draftSections.draftId, root.id), eq(schema.draftSections.sectionKey, "governing_law_and_disputes")));

    const reviseLlm = new FakeLlmClient({ responses: [{ data: draftModelOutput("freelance_service_agreement") }] });
    const revision = await revise(h.deps(reviseLlm), guestA, root.id, { userInstructions: "Add a Bengaluru arbitration clause." });

    // Proves the deleted row's body really was absent from what the model received — the root's own
    // original text for this key never reaches the revision prompt.
    expect(reviseLlm.calls[0].userPrompt).not.toContain("Generated body for governing_law_and_disputes.");
    expect(revision.sections.map((s) => s.key)).toEqual(requiredSectionKeys("freelance_service_agreement"));
    expect(revision.sections.find((s) => s.key === "governing_law_and_disputes")!.content).toBe("Generated body for governing_law_and_disputes.");
    // The parent's missing section sent an empty previous body — the model still had to fill it in
    // for the response schema to validate, since buildDraftResponseSchema requires every current
    // ai_generated key non-blank, regardless of what the parent draft had.
    expect(reviseLlm.calls[0].userPrompt).toContain("[governing_law_and_disputes]");
  });
});

describe("per-operation LLM budget", () => {
  it("create() and revise() each pass Draft's budget, which bounds the whole provider chain", async () => {
    const createLlm = new FakeLlmClient({ responses: [{ data: draftModelOutput("nda") }] });
    const root = await create(h.deps(createLlm), guestA, { mode: "from_scratch", documentType: "nda", userInstructions: "v1", jurisdiction: "IN" });
    const reviseLlm = new FakeLlmClient({ responses: [{ data: draftModelOutput("nda") }] });
    await revise(h.deps(reviseLlm), guestA, root.id, { userInstructions: "v2" });

    expect(createLlm.calls[0].timeoutMs).toBe(LLM_TIMEOUT_MS.draft);
    expect(reviseLlm.calls[0].timeoutMs).toBe(LLM_TIMEOUT_MS.draft);
  });
});
