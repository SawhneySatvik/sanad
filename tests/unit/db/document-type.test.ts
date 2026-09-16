import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DOCUMENT_TYPE_IDS } from "@/server/deterministic/document-type-registry";
import { createTestDb, type TestDb } from "@tests/support/db";

// documents.document_type and drafts.document_type are CHECK IN (<registry ids>) — spelled out in the
// hand-written SQL, so a registry change that is not matched by a new migration must fail here.

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

// pg_get_constraintdef renders IN (...) as `= ANY (ARRAY['a'::text, 'b'::text])`.
export function allowedValues(constraintDef: string): string[] {
  return [...constraintDef.matchAll(/'([^']*)'::text/g)].map((m) => m[1]);
}

async function checkDefinition(name: string): Promise<string> {
  const result = await t.client.query<{ def: string }>(
    "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1",
    [name],
  );
  expect(result.rows, name).toHaveLength(1);
  return result.rows[0].def;
}

describe("document_type CHECKs mirror src/server/deterministic/document-type-registry.ts", () => {
  for (const constraint of ["documents_document_type_check", "drafts_document_type_check"]) {
    it(`${constraint} allows exactly DOCUMENT_TYPE_IDS, in registry order`, async () => {
      expect(DOCUMENT_TYPE_IDS.length).toBeGreaterThan(0);
      expect(allowedValues(await checkDefinition(constraint))).toEqual([...DOCUMENT_TYPE_IDS]);
    });
  }

  it("the comparison is not vacuous: a CHECK that differs from the registry by one id is detected", async () => {
    await t.client.exec(`
      ALTER TABLE documents DROP CONSTRAINT documents_document_type_check;
      ALTER TABLE documents ADD CONSTRAINT documents_document_type_check
        CHECK (document_type IN ('leave_and_license', 'job_offer_letter', 'nda', 'privacy_policy', 'freelance_service_agreement', 'grounded_response'));
    `);
    expect(allowedValues(await checkDefinition("documents_document_type_check"))).not.toEqual([...DOCUMENT_TYPE_IDS]);
  });

  it("an id outside the registry is rejected on both tables; NULL stays allowed on documents (not yet detected)", async () => {
    const insertDocument = (documentType: string | null) =>
      t.client.query(
        `INSERT INTO documents (owner_guest_session_id, storage_ref, filename, mime_type, document_type, expires_at)
         VALUES ('g', gen_random_uuid()::text, 'f', 'm', $1, now() + interval '2 hours')`,
        [documentType],
      );
    await expect(insertDocument("rental_agreement")).rejects.toMatchObject({ constraint: "documents_document_type_check" });
    await expect(insertDocument(null)).resolves.toBeDefined();
    for (const id of DOCUMENT_TYPE_IDS) await expect(insertDocument(id)).resolves.toBeDefined();

    const insertDraft = (documentType: string) =>
      t.client.query(
        `INSERT INTO drafts (owner_guest_session_id, document_type, mode, content, revision_number, expires_at, model_used)
         VALUES ('g', $1, 'from_scratch', 'c', 1, now() + interval '2 hours', 'gemini-test')`,
        [documentType],
      );
    await expect(insertDraft("rental_agreement")).rejects.toMatchObject({ constraint: "drafts_document_type_check" });
    await expect(insertDraft("grounded_response")).resolves.toBeDefined();
  });
});
