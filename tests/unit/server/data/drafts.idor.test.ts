// Cross-principal access to the drafts repository. Collected by
// `npm test -- idor` (vitest filters by file path).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import type { TestDb } from "@tests/support/db";
import { requiredSectionKeys, type DraftProvenance } from "@/server/deterministic/draft-templates";
import { caught, createRepoTestDb, guestA, guestB, readyDocument, userA, userB } from "@tests/support/data/documents";
import { createDraft, getDraft, reviseDraft, type NewDraftSectionInput } from "@/server/data/drafts";

let t: TestDb;
beforeEach(async () => {
  t = await createRepoTestDb();
});
afterEach(async () => {
  await t.close();
});

const MISSING_ID = "0f0f0f0f-0000-4000-8000-000000000000";
const MODEL_USED = "fake-model";
const JURISDICTION = "IN";

function sectionsFor(documentType: "nda" | "grounded_response"): NewDraftSectionInput[] {
  return requiredSectionKeys(documentType).map((key) => ({
    sectionKey: key,
    provenance: (key === "disclaimer" || key === "signatures" || key === "closing" ? "templated" : "ai_generated") as DraftProvenance,
    content: `body for ${key}`,
  }));
}

describe("drafts IDOR", () => {
  it("createDraft in document_grounded mode against another principal's document is NOT_FOUND and creates no row", async () => {
    const documentOwnedByA = await readyDocument(t, userA);
    const error = await caught(
      createDraft(t.db, userB, {
        documentType: "grounded_response",
        mode: "document_grounded",
        groundingDocument: documentOwnedByA,
        sections: sectionsFor("grounded_response"),
        content: "x",
        modelUsed: MODEL_USED,
        jurisdiction: JURISDICTION,
      }),
    );
    expect(error.code).toBe("NOT_FOUND");
    expect(await t.db.select().from(schema.drafts)).toHaveLength(0);
    expect(await t.db.select().from(schema.draftSections)).toHaveLength(0);

    // Positive control: the owner can.
    const own = await createDraft(t.db, userA, {
      documentType: "grounded_response",
      mode: "document_grounded",
      groundingDocument: documentOwnedByA,
      sections: sectionsFor("grounded_response"),
      content: "x",
      modelUsed: MODEL_USED,
      jurisdiction: JURISDICTION,
    });
    expect(own.groundingDocumentId).toBe(documentOwnedByA.id);
  });

  it("getDraft: foreign, missing and malformed ids are the same NOT_FOUND; the owner still reads it", async () => {
    const draft = await createDraft(t.db, guestA, { documentType: "nda", mode: "from_scratch", sections: sectionsFor("nda"), content: "x", modelUsed: MODEL_USED, jurisdiction: JURISDICTION });

    const foreign = await caught(getDraft(t.db, guestB, draft.id));
    const missing = await caught(getDraft(t.db, guestB, MISSING_ID));
    const malformed = await caught(getDraft(t.db, guestB, "1 OR 1=1"));
    expect(foreign.code).toBe("NOT_FOUND");
    expect([missing.code, missing.message]).toEqual([foreign.code, foreign.message]);
    expect([malformed.code, malformed.message]).toEqual([foreign.code, foreign.message]);

    const own = await getDraft(t.db, guestA, draft.id);
    expect(own.id).toBe(draft.id);
  });

  it("reviseDraft: foreign, missing and malformed parentDraftId are the same NOT_FOUND; the owner still can revise", async () => {
    const draft = await createDraft(t.db, userA, { documentType: "nda", mode: "from_scratch", sections: sectionsFor("nda"), content: "x", modelUsed: MODEL_USED, jurisdiction: JURISDICTION });
    const attempt = (parentDraftId: string) => caught(reviseDraft(t.db, userB, parentDraftId, { sections: sectionsFor("nda"), content: "y", modelUsed: MODEL_USED }));

    const foreign = await attempt(draft.id);
    const missing = await attempt(MISSING_ID);
    const malformed = await attempt("1 OR 1=1");
    expect(foreign.code).toBe("NOT_FOUND");
    expect([missing.code, missing.message]).toEqual([foreign.code, foreign.message]);
    expect([malformed.code, malformed.message]).toEqual([foreign.code, foreign.message]);
    expect(await t.db.select().from(schema.drafts)).toHaveLength(1); // no revision was created by any of the three

    const revision = await reviseDraft(t.db, userA, draft.id, { sections: sectionsFor("nda"), content: "y", modelUsed: MODEL_USED });
    expect(revision.parentDraftId).toBe(draft.id);
  });

  it("a user and a guest never see each other's drafts, in either direction", async () => {
    const guestDraft = await createDraft(t.db, guestA, { documentType: "nda", mode: "from_scratch", sections: sectionsFor("nda"), content: "x", modelUsed: MODEL_USED, jurisdiction: JURISDICTION });
    const userDraft = await createDraft(t.db, userA, { documentType: "nda", mode: "from_scratch", sections: sectionsFor("nda"), content: "x", modelUsed: MODEL_USED, jurisdiction: JURISDICTION });
    expect((await caught(getDraft(t.db, userA, guestDraft.id))).code).toBe("NOT_FOUND");
    expect((await caught(getDraft(t.db, guestA, userDraft.id))).code).toBe("NOT_FOUND");
  });
});
