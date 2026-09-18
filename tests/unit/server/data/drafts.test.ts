// Cross-principal cases live in drafts.idor.test.ts (collected by `npm test -- idor`).

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { TestDb } from "@tests/support/db";
import type { DraftProvenance } from "@/server/deterministic/draft-templates";
import { requiredSectionKeys } from "@/server/deterministic/draft-templates";
import { caught, createRepoTestDb, guestA, readyDocument, userA, USER_A_ID } from "@tests/support/data/documents";
import { createDraft, DRAFT_GUEST_TTL_SECONDS, getDraft, reviseDraft, type NewDraftSectionInput } from "@/server/data/drafts";

let t: TestDb;
beforeEach(async () => {
  t = await createRepoTestDb();
});
afterEach(async () => {
  await t.close();
});

const MODEL_USED = "fake-model";
const JURISDICTION = "IN";

function sectionsFor(documentType: "nda" | "leave_and_license" | "grounded_response", overrides: Record<string, string> = {}): NewDraftSectionInput[] {
  return requiredSectionKeys(documentType).map((key) => ({
    sectionKey: key,
    provenance: (overrides[`${key}:provenance`] as DraftProvenance) ?? (key === "disclaimer" || key === "signatures" || key === "closing" ? "templated" : "ai_generated"),
    content: overrides[key] ?? `body for ${key}`,
  }));
}

describe("createDraft — from_scratch", () => {
  it("persists the draft and every section in template order, in one call", async () => {
    const draft = await createDraft(t.db, guestA, {
      documentType: "nda",
      mode: "from_scratch",
      sections: sectionsFor("nda"),
      content: "rendered content",
      modelUsed: MODEL_USED,
      jurisdiction: JURISDICTION,
    });
    expect(draft.mode).toBe("from_scratch");
    expect(draft.documentType).toBe("nda");
    expect(draft.groundingDocumentId).toBeNull();
    expect(draft.revisionNumber).toBe(1);
    expect(draft.parentDraftId).toBeNull();
    expect(draft.content).toBe("rendered content");
    expect(draft.modelUsed).toBe(MODEL_USED);
    expect(draft.jurisdiction).toBe(JURISDICTION);
    expect(draft.sections.map((s) => s.sectionKey)).toEqual(requiredSectionKeys("nda"));

    const reread = await getDraft(t.db, guestA, draft.id);
    expect(reread.sections.map((s) => s.sectionKey)).toEqual(requiredSectionKeys("nda"));
    expect(reread.sections).toHaveLength(requiredSectionKeys("nda").length);
    expect(reread.modelUsed).toBe(MODEL_USED);
  });

  it("a guest draft is guest-owned and expires within the guest TTL window", async () => {
    const before = Date.now();
    const draft = await createDraft(t.db, guestA, { documentType: "nda", mode: "from_scratch", sections: sectionsFor("nda"), content: "x", modelUsed: MODEL_USED, jurisdiction: JURISDICTION });
    expect(draft).toMatchObject({ ownerGuestSessionId: "repo-guest-a", ownerUserId: null });
    expect(draft.expiresAt).not.toBeNull();
    expect(draft.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + DRAFT_GUEST_TTL_SECONDS * 1000);
    expect(draft.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + DRAFT_GUEST_TTL_SECONDS * 1000);
  });

  it("a user draft is user-owned and never expires", async () => {
    const draft = await createDraft(t.db, userA, { documentType: "nda", mode: "from_scratch", sections: sectionsFor("nda"), content: "x", modelUsed: MODEL_USED, jurisdiction: JURISDICTION });
    expect(draft).toMatchObject({ ownerUserId: USER_A_ID, ownerGuestSessionId: null, expiresAt: null });
  });

  it("rejects a missing required section, an extra section, and a duplicate section — no row persisted", async () => {
    const all = sectionsFor("nda");
    const missing = await caught(createDraft(t.db, guestA, { documentType: "nda", mode: "from_scratch", sections: all.slice(1), content: "x", modelUsed: MODEL_USED, jurisdiction: JURISDICTION }));
    expect(missing.code).toBe("VALIDATION_FAILED");

    const extra = [...all, { sectionKey: "not_a_real_key", provenance: "ai_generated" as const, content: "x" }];
    const extraErr = await caught(createDraft(t.db, guestA, { documentType: "nda", mode: "from_scratch", sections: extra, content: "x", modelUsed: MODEL_USED, jurisdiction: JURISDICTION }));
    expect(extraErr.code).toBe("VALIDATION_FAILED");

    const duplicate = [...all, all[0]];
    const dupErr = await caught(createDraft(t.db, guestA, { documentType: "nda", mode: "from_scratch", sections: duplicate, content: "x", modelUsed: MODEL_USED, jurisdiction: JURISDICTION }));
    expect(dupErr.code).toBe("VALIDATION_FAILED");

    expect(await t.db.select().from(schema.drafts)).toHaveLength(0);
    expect(await t.db.select().from(schema.draftSections)).toHaveLength(0);
  });

  it("rejects a section present but with a blank body — treated the same as missing", async () => {
    const blankOne = sectionsFor("nda").map((s, i) => (i === 1 ? { ...s, content: "   " } : s));
    const error = await caught(createDraft(t.db, guestA, { documentType: "nda", mode: "from_scratch", sections: blankOne, content: "x", modelUsed: MODEL_USED, jurisdiction: JURISDICTION }));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(await t.db.select().from(schema.drafts)).toHaveLength(0);
  });

  it("rejects a groundingDocument in from_scratch mode", async () => {
    const doc = await readyDocument(t, guestA);
    const error = await caught(
      createDraft(t.db, guestA, {
        documentType: "nda",
        mode: "from_scratch",
        groundingDocument: doc,
        sections: sectionsFor("nda"),
        content: "x",
        modelUsed: MODEL_USED,
        jurisdiction: JURISDICTION,
      }),
    );
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(await t.db.select().from(schema.drafts)).toHaveLength(0);
  });
});

describe("createDraft — document_grounded", () => {
  it("requires a groundingDocument", async () => {
    const error = await caught(
      createDraft(t.db, guestA, { documentType: "grounded_response", mode: "document_grounded", sections: sectionsFor("grounded_response"), content: "x", modelUsed: MODEL_USED, jurisdiction: JURISDICTION }),
    );
    expect(error.code).toBe("VALIDATION_FAILED");
  });

  it("expires_at is LEAST(own TTL, grounding document's expires_at) — document expiring EARLIER wins", async () => {
    const doc = await readyDocument(t, guestA);
    const earlier = new Date(Date.now() + 5 * 60 * 1000); // 5 min — well inside the 3h guest TTL
    await t.db.update(schema.documents).set({ expiresAt: earlier }).where(eq(schema.documents.id, doc.id));

    const draft = await createDraft(t.db, guestA, {
      documentType: "grounded_response",
      mode: "document_grounded",
      groundingDocument: { ...doc, expiresAt: earlier },
      sections: sectionsFor("grounded_response"),
      content: "x",
      modelUsed: MODEL_USED,
      jurisdiction: JURISDICTION,
    });
    expect(draft.expiresAt!.getTime()).toBe(earlier.getTime());
  });

  it("expires_at is LEAST(own TTL, grounding document's expires_at) — the draft's own TTL wins when the document expires LATER", async () => {
    const doc = await readyDocument(t, guestA);
    const later = new Date(Date.now() + 10 * 60 * 60 * 1000); // 10h — beyond the 3h guest TTL
    await t.db.update(schema.documents).set({ expiresAt: later }).where(eq(schema.documents.id, doc.id));

    const before = Date.now();
    const draft = await createDraft(t.db, guestA, {
      documentType: "grounded_response",
      mode: "document_grounded",
      groundingDocument: { ...doc, expiresAt: later },
      sections: sectionsFor("grounded_response"),
      content: "x",
      modelUsed: MODEL_USED,
      jurisdiction: JURISDICTION,
    });
    expect(draft.expiresAt!.getTime()).toBeLessThan(later.getTime());
    expect(draft.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + DRAFT_GUEST_TTL_SECONDS * 1000);
    expect(draft.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + DRAFT_GUEST_TTL_SECONDS * 1000);
  });

  it("a user's grounded draft has no cap when both the draft's own TTL and the document's are null", async () => {
    const doc = await readyDocument(t, userA);
    const draft = await createDraft(t.db, userA, {
      documentType: "grounded_response",
      mode: "document_grounded",
      groundingDocument: doc,
      sections: sectionsFor("grounded_response"),
      content: "x",
      modelUsed: MODEL_USED,
      jurisdiction: JURISDICTION,
    });
    expect(draft.expiresAt).toBeNull();
  });
});

describe("jurisdiction persistence and inheritance", () => {
  it("create() persists the caller-supplied jurisdiction; a revision INHERITS it unchanged, never recomputed", async () => {
    // "GB" specifically: "IN" is the registry default, so a test using "IN" could pass even if
    // persistence were silently broken. The repository itself doesn't validate jurisdiction against
    // the registry (the service does), so "GB" is a legitimate repo-layer input here.
    const root = await createDraft(t.db, guestA, { documentType: "nda", mode: "from_scratch", sections: sectionsFor("nda"), content: "v1", modelUsed: MODEL_USED, jurisdiction: "GB" });
    expect(root.jurisdiction).toBe("GB");

    const revision = await reviseDraft(t.db, guestA, root.id, { sections: sectionsFor("nda"), content: "v2", modelUsed: MODEL_USED });
    expect(revision.jurisdiction).toBe("GB");

    const reread = await getDraft(t.db, guestA, revision.id);
    expect(reread.jurisdiction).toBe("GB");
  });
});

describe("a draft past its own expires_at is NOT_FOUND, identical to missing", () => {
  it("get() and revise() both 404 on an expired-but-unswept guest draft", async () => {
    const draft = await createDraft(t.db, guestA, { documentType: "nda", mode: "from_scratch", sections: sectionsFor("nda"), content: "x", modelUsed: MODEL_USED, jurisdiction: JURISDICTION });
    const past = new Date(Date.now() - 60 * 1000);
    await t.db.update(schema.drafts).set({ expiresAt: past }).where(eq(schema.drafts.id, draft.id));

    const getError = await caught(getDraft(t.db, guestA, draft.id));
    const missingError = await caught(getDraft(t.db, guestA, "0f0f0f0f-0000-4000-8000-000000000000"));
    expect(getError.code).toBe("NOT_FOUND");
    expect([getError.code, getError.message]).toEqual([missingError.code, missingError.message]);

    const reviseError = await caught(reviseDraft(t.db, guestA, draft.id, { sections: sectionsFor("nda"), content: "y", modelUsed: MODEL_USED }));
    expect(reviseError.code).toBe("NOT_FOUND");
  });

  it("a draft with no expires_at (user-owned) is never treated as expired", async () => {
    const draft = await createDraft(t.db, userA, { documentType: "nda", mode: "from_scratch", sections: sectionsFor("nda"), content: "x", modelUsed: MODEL_USED, jurisdiction: JURISDICTION });
    expect((await getDraft(t.db, userA, draft.id)).id).toBe(draft.id);
  });
});

describe("revision chain inherits the root's expires_at", () => {
  it("a chain of 3 drafts (root + 2 revisions) all share the ROOT's expires_at exactly, never recomputed", async () => {
    const root = await createDraft(t.db, guestA, { documentType: "nda", mode: "from_scratch", sections: sectionsFor("nda"), content: "v1", modelUsed: MODEL_USED, jurisdiction: JURISDICTION });
    // Patch the root to a distinctive, deliberately-not-"now + TTL" timestamp — if a revision ever
    // recomputed its own expiry instead of copying the root's, this exact value would not survive.
    const distinctive = new Date(Date.now() + 17 * 60 * 1000);
    await t.db.update(schema.drafts).set({ expiresAt: distinctive }).where(eq(schema.drafts.id, root.id));

    const rev1 = await reviseDraft(t.db, guestA, root.id, { sections: sectionsFor("nda"), content: "v2", modelUsed: "fake-model-b" });
    const rev2 = await reviseDraft(t.db, guestA, rev1.id, { sections: sectionsFor("nda"), content: "v3", modelUsed: MODEL_USED });

    expect(rev1.expiresAt!.getTime()).toBe(distinctive.getTime());
    expect(rev2.expiresAt!.getTime()).toBe(distinctive.getTime());
    expect(rev1.revisionNumber).toBe(2);
    expect(rev2.revisionNumber).toBe(3);
    expect(rev1.parentDraftId).toBe(root.id);
    expect(rev2.parentDraftId).toBe(rev1.id);
    // model_used is each revision's OWN value (a fresh LLM call), never inherited like expires_at.
    expect(rev1.modelUsed).toBe("fake-model-b");
    expect(rev2.modelUsed).toBe(MODEL_USED);
  });

  it("a revision keeps the parent's document_type, mode and grounding_document_id unchanged", async () => {
    const doc = await readyDocument(t, guestA);
    const root = await createDraft(t.db, guestA, {
      documentType: "grounded_response",
      mode: "document_grounded",
      groundingDocument: doc,
      sections: sectionsFor("grounded_response"),
      content: "v1",
      modelUsed: MODEL_USED,
      jurisdiction: JURISDICTION,
    });
    const revision = await reviseDraft(t.db, guestA, root.id, { sections: sectionsFor("grounded_response"), content: "v2", modelUsed: MODEL_USED });
    expect(revision.mode).toBe("document_grounded");
    expect(revision.documentType).toBe("grounded_response");
    expect(revision.groundingDocumentId).toBe(doc.id);
  });

  it("two revisions of the same parent may legitimately share a revision_number (a revision tree, not just a chain — accepted, not a bug)", async () => {
    const root = await createDraft(t.db, guestA, { documentType: "nda", mode: "from_scratch", sections: sectionsFor("nda"), content: "v1", modelUsed: MODEL_USED, jurisdiction: JURISDICTION });
    const branchA = await reviseDraft(t.db, guestA, root.id, { sections: sectionsFor("nda"), content: "v2a", modelUsed: MODEL_USED });
    const branchB = await reviseDraft(t.db, guestA, root.id, { sections: sectionsFor("nda"), content: "v2b", modelUsed: MODEL_USED });
    expect(branchA.revisionNumber).toBe(2);
    expect(branchB.revisionNumber).toBe(2);
    expect(branchA.parentDraftId).toBe(root.id);
    expect(branchB.parentDraftId).toBe(root.id);
    expect(branchA.id).not.toBe(branchB.id);
  });

  it("rejects a revision with the wrong section set — no row persisted", async () => {
    const root = await createDraft(t.db, guestA, { documentType: "nda", mode: "from_scratch", sections: sectionsFor("nda"), content: "v1", modelUsed: MODEL_USED, jurisdiction: JURISDICTION });
    const before = await t.db.select().from(schema.drafts);
    const error = await caught(reviseDraft(t.db, guestA, root.id, { sections: sectionsFor("nda").slice(1), content: "v2", modelUsed: MODEL_USED }));
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(await t.db.select().from(schema.drafts)).toHaveLength(before.length);
  });
});

describe("provenance is a closed union that cannot imply verification", () => {
  it("type-level: DraftProvenance rejects \"verified\" at compile time", () => {
    // @ts-expect-error "verified" is not a member of DraftProvenance (draft-templates/types.ts) —
    // if this stops erroring (e.g. the union is ever widened), tsc fails on "unused directive".
    const forbidden: DraftProvenance = "verified";
    expect(forbidden).toBe("verified");
  });

  it("the DB CHECK rejects a raw insert whose provenance implies verification — backstop when the TS layer is bypassed", async () => {
    const draft = await createDraft(t.db, guestA, { documentType: "nda", mode: "from_scratch", sections: sectionsFor("nda"), content: "x", modelUsed: MODEL_USED, jurisdiction: JURISDICTION });

    for (const badValue of ["verified", "unverified", "pending_verification"]) {
      await expect(
        t.db.insert(schema.draftSections).values({ draftId: draft.id, sectionKey: `bad_${badValue}`, provenance: badValue, content: "x" }),
      ).rejects.toThrow();
    }
    // Positive control: the assertions above are not vacuously true — a legitimate value is accepted.
    await expect(
      t.db.insert(schema.draftSections).values({ draftId: draft.id, sectionKey: "extra_ok", provenance: "templated", content: "x" }),
    ).resolves.toBeDefined();
  });
});

describe("getDraft", () => {
  it("malformed and missing ids are NOT_FOUND", async () => {
    const missing = await caught(getDraft(t.db, guestA, "0f0f0f0f-0000-4000-8000-000000000000"));
    expect(missing.code).toBe("NOT_FOUND");
    const malformed = await caught(getDraft(t.db, guestA, "1 OR 1=1"));
    expect(malformed.code).toBe("NOT_FOUND");
  });
});
