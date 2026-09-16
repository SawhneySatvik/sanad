import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uuidv4 } from "uuidv7";
import { newId } from "@/db/ids";
import * as s from "@/db/schema";
import { createTestDb, type TestDb } from "@tests/support/db";

// Run against the real migrated schema (createTestDb applies src/db/migrations/*.sql).
// Every negative asserts the NAME of the constraint/trigger that fired, then drops that one object in
// the same throwaway database and shows the identical statement is accepted — so each test proves it
// is that constraint, and nothing else, doing the rejecting.

let t: TestDb;
beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

type PgError = { code?: string; constraint?: string; column?: string; message: string };

async function rejection(run: () => Promise<unknown>): Promise<PgError> {
  try {
    await run();
  } catch (error) {
    // drizzle wraps driver errors; the Postgres fields live on the cause.
    return ((error as { cause?: unknown }).cause ?? error) as PgError;
  }
  throw new Error("expected the statement to be rejected, but it succeeded");
}

type NewDocument = typeof s.documents.$inferInsert;
type NewFinding = typeof s.findings.$inferInsert;
type NewDraft = typeof s.drafts.$inferInsert;
type NewComparison = typeof s.comparisons.$inferInsert;
type NewMessage = typeof s.messages.$inferInsert;
type NewCitation = typeof s.messageCitations.$inferInsert;
type NewChange = typeof s.comparisonChanges.$inferInsert;

const CANONICAL = "The tenant shall pay rent on the first of each month.";
// Guest-owned rows must carry an expiry (documents/comparisons/drafts_guest_expires_check).
const inTwoHours = () => new Date(Date.now() + 2 * 3_600_000);

async function insertUser(): Promise<string> {
  const id = newId();
  await t.db.insert(s.users).values({ id, email: `${id}@example.com` });
  return id;
}

function readyTextDocument(overrides: Partial<NewDocument> = {}): NewDocument {
  return {
    ownerGuestSessionId: "guest-a",
    storageRef: `guest:guest-a/${newId()}/lease.pdf`,
    filename: "lease.pdf",
    mimeType: "application/pdf",
    inputMode: "text",
    processingStatus: "ready",
    canonicalText: CANONICAL,
    canonicalTextHash: "hash-1",
    extractorVersion: "extract@1",
    documentType: "leave_and_license",
    expiresAt: inTwoHours(),
    ...overrides,
  };
}

async function insertDocument(overrides: Partial<NewDocument> = {}) {
  const [row] = await t.db.insert(s.documents).values(readyTextDocument(overrides)).returning();
  return row;
}

async function insertAnalysis(documentId: string, promptVersion = "understand@1") {
  const [row] = await t.db
    .insert(s.analyses)
    .values({ documentId, promptVersion, modelUsed: "gemini-test" })
    .returning();
  return row;
}

function verifiedFinding(documentId: string, analysisId: string, overrides: Partial<NewFinding> = {}): NewFinding {
  return {
    documentId,
    analysisId,
    category: "obligation",
    quoteText: "The tenant shall pay rent",
    quoteSpanStart: 0,
    quoteSpanEnd: 25,
    verificationStatus: "verified",
    verifierVersion: "verify@1",
    modelUsed: "gemini-test",
    explanation: "Rent is due monthly.",
    ...overrides,
  };
}

function guestComparison(documentAId: string, documentBId: string, overrides: Partial<NewComparison> = {}): NewComparison {
  return { ownerGuestSessionId: "guest-a", documentAId, documentBId, expiresAt: inTwoHours(), modelUsed: "gemini-test", ...overrides };
}

function guestDraft(overrides: Partial<NewDraft> = {}): NewDraft {
  return {
    ownerGuestSessionId: "guest-a",
    documentType: "leave_and_license",
    mode: "from_scratch",
    content: "Draft body",
    revisionNumber: 1,
    expiresAt: inTwoHours(),
    modelUsed: "gemini-test",
    ...overrides,
  };
}

async function insertThread(ownerUserId: string, projectId?: string) {
  const [row] = await t.db.insert(s.threads).values({ ownerUserId, projectId, title: "Lease questions" }).returning();
  return row;
}

function assistantMessage(threadId: string, overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: newId(),
    threadId,
    role: "assistant",
    content: "Rent is due on the first.",
    mode: "grounded",
    routedDomainArray: ["tenancy"],
    modelUsed: "gemini-test",
    ...overrides,
  };
}

function verifiedCitation(messageId: string, sourceDocumentId: string | null, overrides: Partial<NewCitation> = {}): NewCitation {
  return {
    messageId,
    quoteText: "The tenant shall pay rent",
    quoteSpanStart: 0,
    quoteSpanEnd: 25,
    sourceDocumentId,
    verificationStatus: "verified",
    verifierVersion: "verify@1",
    ...overrides,
  };
}

function changedChange(comparisonId: string, overrides: Partial<NewChange> = {}): NewChange {
  return {
    comparisonId,
    changeType: "changed",
    quoteTextA: "The tenant shall pay rent",
    quoteTextB: "The tenant shall pay rent",
    docASpanStart: 0,
    docASpanEnd: 25,
    docBSpanStart: 0,
    docBSpanEnd: 25,
    verificationStatusA: "verified",
    verificationStatusB: "verified",
    verifierVersion: "verify@1",
    explanation: "Same clause on both sides.",
    ...overrides,
  };
}

async function publicTables(): Promise<string[]> {
  const result = await t.client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations'
      ORDER BY table_name`,
  );
  return result.rows.map((r) => r.table_name);
}

describe("(a) one valid row per table", () => {
  it("accepts a valid row in every migrated table (and the seed covers every table that exists)", async () => {
    const userId = await insertUser();
    const [project] = await t.db.insert(s.projects).values({ ownerUserId: userId, name: "Flat in Pune" }).returning();
    const docA = await insertDocument({ projectId: project.id });
    const docB = await insertDocument({ ownerGuestSessionId: null, ownerUserId: userId });
    const analysis = await insertAnalysis(docA.id);
    const [finding] = await t.db.insert(s.findings).values(verifiedFinding(docA.id, analysis.id)).returning();
    await t.db.insert(s.findings).values(
      verifiedFinding(docA.id, analysis.id, {
        category: "missing_clause",
        quoteText: null,
        quoteSpanStart: null,
        quoteSpanEnd: null,
        verificationStatus: null,
        verifierVersion: null,
      }),
    );
    await t.db
      .insert(s.findingLensExplanations)
      .values({ findingId: finding.id, roleStageLens: "tenant:before_signing", explanation: "Check this first." });
    const [comparison] = await t.db.insert(s.comparisons).values(guestComparison(docA.id, docA.id)).returning();
    await t.db.insert(s.comparisonChanges).values(changedChange(comparison.id));
    const thread = await insertThread(userId, project.id);
    await t.db.insert(s.threadDocuments).values({ threadId: thread.id, documentId: docB.id });
    await t.db.insert(s.messages).values({ id: newId(), threadId: thread.id, role: "user", content: "When is rent due?" });
    const [message] = await t.db.insert(s.messages).values(assistantMessage(thread.id)).returning();
    await t.db.insert(s.messageCitations).values(verifiedCitation(message.id, docB.id));
    const [draft] = await t.db
      .insert(s.drafts)
      .values(guestDraft({ mode: "document_grounded", groundingDocumentId: docA.id }))
      .returning();
    await t.db.insert(s.draftSections).values({ draftId: draft.id, sectionKey: "intro", provenance: "templated", content: "To," });
    await t.db.insert(s.rateLimitBuckets).values({ principalKey: "guest:guest-a", windowKey: "2026-09-23T10:00", requestCount: 1 });
    await t.db.insert(s.ipRateLimitBuckets).values({ ipKey: "iphash", windowKey: "2026-09-23T10:00", requestCount: 1 });
    await t.db.insert(s.globalLlmRateLimit).values({ providerKey: "gemini", windowKey: "2026-09-23T10:00", requestCount: 1 });
    await t.db.insert(s.analyzedResultCache).values({
      cacheKey: "k1",
      rawModelOutput: "{}",
      modelUsed: "gemini-test",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const tables = await publicTables();
    expect(tables).toHaveLength(18);
    for (const table of tables) {
      const count = await t.client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      expect(count.rows[0].n, `table ${table} has no seeded row`).toBeGreaterThanOrEqual(1);
    }
  });

  it("applies the documented defaults (jurisdiction IN, processing_status pending, ids, timestamps)", async () => {
    const [doc] = await t.db
      .insert(s.documents)
      .values({ ownerGuestSessionId: "g", storageRef: "guest:g/x/a.pdf", filename: "a.pdf", mimeType: "application/pdf", expiresAt: inTwoHours() })
      .returning();
    expect(doc.jurisdiction).toBe("IN");
    expect(doc.processingStatus).toBe("pending");
    expect(doc.inputMode).toBeNull();
    expect(doc.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(doc.uploadedAt).toBeInstanceOf(Date);
  });
});

describe("(b) owner exclusivity — exactly one of owner_user_id / owner_guest_session_id", () => {
  const cases = [
    { table: "documents", constraint: "documents_owner_exclusive_check" },
    { table: "comparisons", constraint: "comparisons_owner_exclusive_check" },
    { table: "drafts", constraint: "drafts_owner_exclusive_check" },
  ] as const;

  async function insertOwned(table: (typeof cases)[number]["table"], owner: { ownerUserId: string | null; ownerGuestSessionId: string | null }) {
    if (table === "documents") return t.db.insert(s.documents).values(readyTextDocument(owner));
    if (table === "drafts") return t.db.insert(s.drafts).values(guestDraft(owner));
    const doc = await insertDocument();
    return t.db.insert(s.comparisons).values(guestComparison(doc.id, doc.id, owner));
  }

  for (const { table, constraint } of cases) {
    it(`${table}: both set is rejected by ${constraint}, and accepted once it is dropped`, async () => {
      const userId = await insertUser();
      const both = { ownerUserId: userId, ownerGuestSessionId: "guest-a" };
      expect((await rejection(() => insertOwned(table, both))).constraint).toBe(constraint);
      await t.client.exec(`ALTER TABLE ${table} DROP CONSTRAINT ${constraint}`);
      await expect(insertOwned(table, both)).resolves.toBeDefined();
    });

    it(`${table}: neither set is rejected by ${constraint}, and accepted once it is dropped`, async () => {
      const neither = { ownerUserId: null, ownerGuestSessionId: null };
      expect((await rejection(() => insertOwned(table, neither))).constraint).toBe(constraint);
      await t.client.exec(`ALTER TABLE ${table} DROP CONSTRAINT ${constraint}`);
      await expect(insertOwned(table, neither)).resolves.toBeDefined();
    });

    it(`${table}: exactly one owner (user, or guest) is accepted`, async () => {
      const userId = await insertUser();
      await expect(insertOwned(table, { ownerUserId: userId, ownerGuestSessionId: null })).resolves.toBeDefined();
      await expect(insertOwned(table, { ownerUserId: null, ownerGuestSessionId: "guest-a" })).resolves.toBeDefined();
    });
  }
});

describe("(b) native-document verified ceiling (DB backstop)", () => {
  async function nativeDocument() {
    return insertDocument({ inputMode: "native_document" });
  }

  it("findings: verified on a native_document document is rejected; drop the trigger and it is accepted", async () => {
    const doc = await nativeDocument();
    const analysis = await insertAnalysis(doc.id);
    const row = verifiedFinding(doc.id, analysis.id);
    const error = await rejection(() => t.db.insert(s.findings).values(row));
    expect(error.constraint).toBe("findings_native_document_verified_ceiling");
    expect(error.code).toBe("23514");
    await t.client.exec("DROP TRIGGER findings_native_document_verified_ceiling ON findings");
    await expect(t.db.insert(s.findings).values(row)).resolves.toBeDefined();
  });

  it("findings: approximate/not_found on a native_document document are accepted; verified on a text document is accepted", async () => {
    const native = await nativeDocument();
    const nativeAnalysis = await insertAnalysis(native.id);
    await t.db.insert(s.findings).values(verifiedFinding(native.id, nativeAnalysis.id, { verificationStatus: "approximate" }));
    await t.db
      .insert(s.findings)
      .values(verifiedFinding(native.id, nativeAnalysis.id, { verificationStatus: "not_found", quoteSpanStart: null, quoteSpanEnd: null }));
    const text = await insertDocument();
    const textAnalysis = await insertAnalysis(text.id);
    await expect(t.db.insert(s.findings).values(verifiedFinding(text.id, textAnalysis.id))).resolves.toBeDefined();
  });

  it("findings: fail-closed — verified is rejected while the document is still pending (input_mode NULL)", async () => {
    const pending = await insertDocument({
      processingStatus: "pending",
      inputMode: null,
      canonicalText: null,
      canonicalTextHash: null,
      extractorVersion: null,
    });
    const analysis = await insertAnalysis(pending.id);
    const error = await rejection(() => t.db.insert(s.findings).values(verifiedFinding(pending.id, analysis.id)));
    expect(error.constraint).toBe("findings_native_document_verified_ceiling");
  });

  it("findings: an UPDATE to verified on a native_document finding is rejected too", async () => {
    const doc = await nativeDocument();
    const analysis = await insertAnalysis(doc.id);
    const [finding] = await t.db
      .insert(s.findings)
      .values(verifiedFinding(doc.id, analysis.id, { verificationStatus: "approximate" }))
      .returning();
    const error = await rejection(() =>
      t.db.update(s.findings).set({ verificationStatus: "verified" }).where(eq(s.findings.id, finding.id)),
    );
    expect(error.constraint).toBe("findings_native_document_verified_ceiling");
  });

  it("message_citations: verified against a native_document source is rejected; drop the trigger and it is accepted", async () => {
    const userId = await insertUser();
    const thread = await insertThread(userId);
    const [message] = await t.db.insert(s.messages).values(assistantMessage(thread.id)).returning();
    const doc = await nativeDocument();
    const row = verifiedCitation(message.id, doc.id);
    expect((await rejection(() => t.db.insert(s.messageCitations).values(row))).constraint).toBe(
      "message_citations_native_document_verified_ceiling",
    );
    await t.client.exec("DROP TRIGGER message_citations_native_document_verified_ceiling ON message_citations");
    await expect(t.db.insert(s.messageCitations).values(row)).resolves.toBeDefined();
  });

  it("message_citations: a NEW verified citation with no source document is rejected", async () => {
    const userId = await insertUser();
    const thread = await insertThread(userId);
    const [message] = await t.db.insert(s.messages).values(assistantMessage(thread.id)).returning();
    expect((await rejection(() => t.db.insert(s.messageCitations).values(verifiedCitation(message.id, null)))).constraint).toBe(
      "message_citations_native_document_verified_ceiling",
    );
  });

  it("comparison_changes: each side is capped by its OWN document", async () => {
    const text = await insertDocument();
    const native = await nativeDocument();
    const [nativeOnA] = await t.db.insert(s.comparisons).values(guestComparison(native.id, text.id)).returning();
    const [nativeOnB] = await t.db.insert(s.comparisons).values(guestComparison(text.id, native.id)).returning();
    const ceiling = "comparison_changes_native_document_verified_ceiling";

    expect((await rejection(() => t.db.insert(s.comparisonChanges).values(changedChange(nativeOnA.id)))).constraint).toBe(ceiling);
    expect((await rejection(() => t.db.insert(s.comparisonChanges).values(changedChange(nativeOnB.id)))).constraint).toBe(ceiling);
    // The text side may still be verified when only the other side is native.
    await expect(
      t.db.insert(s.comparisonChanges).values(changedChange(nativeOnA.id, { verificationStatusA: "approximate" })),
    ).resolves.toBeDefined();
    await expect(
      t.db.insert(s.comparisonChanges).values(changedChange(nativeOnB.id, { verificationStatusB: "approximate" })),
    ).resolves.toBeDefined();

    await t.client.exec("DROP TRIGGER comparison_changes_native_document_verified_ceiling ON comparison_changes");
    await expect(t.db.insert(s.comparisonChanges).values(changedChange(nativeOnA.id))).resolves.toBeDefined();
  });

  it("fail-closed on processing_status: a text-mode document that is not ready accepts no verified row in any table", async () => {
    const userId = await insertUser();
    const thread = await insertThread(userId);
    const [message] = await t.db.insert(s.messages).values(assistantMessage(thread.id)).returning();
    const ready = await insertDocument();
    for (const processingStatus of ["pending", "extraction_failed"] as const) {
      // input_mode is already 'text' — only processing_status says there is no canonical text yet.
      const notReady = await insertDocument({ processingStatus, inputMode: "text", canonicalText: null, canonicalTextHash: null });
      const analysis = await insertAnalysis(notReady.id);
      expect((await rejection(() => t.db.insert(s.findings).values(verifiedFinding(notReady.id, analysis.id)))).constraint).toBe(
        "findings_native_document_verified_ceiling",
      );
      expect((await rejection(() => t.db.insert(s.messageCitations).values(verifiedCitation(message.id, notReady.id)))).constraint).toBe(
        "message_citations_native_document_verified_ceiling",
      );
      const [aNotReady] = await t.db.insert(s.comparisons).values(guestComparison(notReady.id, ready.id)).returning();
      const [bNotReady] = await t.db.insert(s.comparisons).values(guestComparison(ready.id, notReady.id)).returning();
      for (const comparison of [aNotReady, bNotReady]) {
        expect((await rejection(() => t.db.insert(s.comparisonChanges).values(changedChange(comparison.id)))).constraint).toBe(
          "comparison_changes_native_document_verified_ceiling",
        );
      }
    }
    // Positive control: the ready text document accepts verified rows everywhere.
    const analysis = await insertAnalysis(ready.id);
    await expect(t.db.insert(s.findings).values(verifiedFinding(ready.id, analysis.id))).resolves.toBeDefined();
    await expect(t.db.insert(s.messageCitations).values(verifiedCitation(message.id, ready.id))).resolves.toBeDefined();
  });

  it("comparison_changes: an UPDATE to verified on a native side is rejected (UPDATE path, not only INSERT)", async () => {
    const text = await insertDocument();
    const native = await nativeDocument();
    const [comparison] = await t.db.insert(s.comparisons).values(guestComparison(native.id, text.id)).returning();
    const [change] = await t.db
      .insert(s.comparisonChanges)
      .values(changedChange(comparison.id, { verificationStatusA: "approximate" }))
      .returning();
    const error = await rejection(() =>
      t.db.update(s.comparisonChanges).set({ verificationStatusA: "verified" }).where(eq(s.comparisonChanges.id, change.id)),
    );
    expect(error.constraint).toBe("comparison_changes_native_document_verified_ceiling");
  });

  it("message_citations: an UPDATE to verified, or re-pointing a verified citation at a native document, is rejected", async () => {
    const userId = await insertUser();
    const thread = await insertThread(userId);
    const [message] = await t.db.insert(s.messages).values(assistantMessage(thread.id)).returning();
    const native = await nativeDocument();
    const text = await insertDocument();
    const ceiling = "message_citations_native_document_verified_ceiling";
    const [approximate] = await t.db
      .insert(s.messageCitations)
      .values(verifiedCitation(message.id, native.id, { verificationStatus: "approximate" }))
      .returning();
    expect(
      (await rejection(() =>
        t.db.update(s.messageCitations).set({ verificationStatus: "verified" }).where(eq(s.messageCitations.id, approximate.id)),
      )).constraint,
    ).toBe(ceiling);
    const [verified] = await t.db.insert(s.messageCitations).values(verifiedCitation(message.id, text.id)).returning();
    expect(
      (await rejection(() =>
        t.db.update(s.messageCitations).set({ sourceDocumentId: native.id }).where(eq(s.messageCitations.id, verified.id)),
      )).constraint,
    ).toBe(ceiling);
  });

  it("comparisons: the document pair is immutable, so a verified change can't be re-pointed at a native document", async () => {
    const textA = await insertDocument();
    const textB = await insertDocument();
    const native = await nativeDocument();
    const [comparison] = await t.db.insert(s.comparisons).values(guestComparison(textA.id, textB.id)).returning();
    await t.db.insert(s.comparisonChanges).values(changedChange(comparison.id)); // verified on both sides
    for (const set of [{ documentAId: native.id }, { documentBId: native.id }]) {
      expect(
        (await rejection(() => t.db.update(s.comparisons).set(set).where(eq(s.comparisons.id, comparison.id)))).constraint,
      ).toBe("comparisons_document_pair_immutable");
    }
    // Other columns stay writable (claim clears expires_at, save sets project_id).
    const userId = await insertUser();
    await expect(
      t.db
        .update(s.comparisons)
        .set({ ownerUserId: userId, ownerGuestSessionId: null, expiresAt: null })
        .where(eq(s.comparisons.id, comparison.id)),
    ).resolves.toBeDefined();
  });

  it("documents.input_mode is immutable once set (closes flipping a text document to native after verified rows exist)", async () => {
    const doc = await insertDocument();
    const error = await rejection(() =>
      t.db.update(s.documents).set({ inputMode: "native_document" }).where(eq(s.documents.id, doc.id)),
    );
    expect(error.constraint).toBe("documents_input_mode_immutable");
    const pending = await insertDocument({
      processingStatus: "pending",
      inputMode: null,
      canonicalText: null,
      canonicalTextHash: null,
      extractorVersion: null,
    });
    await expect(
      t.db.update(s.documents).set({ inputMode: "native_document" }).where(eq(s.documents.id, pending.id)),
    ).resolves.toBeDefined();
  });
});

describe("(c) messages.id — app-supplied UUIDv7 only", () => {
  it("an insert without an id is rejected (no database default exists)", async () => {
    const userId = await insertUser();
    const thread = await insertThread(userId);
    const error = await rejection(() =>
      t.client.query("INSERT INTO messages (thread_id, role, content) VALUES ($1, 'user', 'hi')", [thread.id]),
    );
    expect(error.code).toBe("23502");
    expect(error.column).toBe("id");
    const defaults = await t.client.query<{ column_default: string | null }>(
      "SELECT column_default FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'id'",
    );
    expect(defaults.rows[0].column_default).toBeNull();
  });

  it("a v4 (gen_random_uuid-style) id is rejected by messages_id_uuidv7_check; newId() is accepted", async () => {
    const userId = await insertUser();
    const thread = await insertThread(userId);
    const v4 = { id: uuidv4(), threadId: thread.id, role: "user" as const, content: "hi" };
    expect((await rejection(() => t.db.insert(s.messages).values(v4))).constraint).toBe("messages_id_uuidv7_check");
    await expect(t.db.insert(s.messages).values({ ...v4, id: newId() })).resolves.toBeDefined();
    await t.client.exec("ALTER TABLE messages DROP CONSTRAINT messages_id_uuidv7_check");
    await expect(t.db.insert(s.messages).values(v4)).resolves.toBeDefined();
  });
});

describe("guest rows: a real owner id and an expiry", () => {
  const tables = ["documents", "comparisons", "drafts"] as const;

  async function insertGuestRow(table: (typeof tables)[number], overrides: { ownerGuestSessionId?: string; expiresAt?: Date | null }) {
    if (table === "documents") return t.db.insert(s.documents).values(readyTextDocument(overrides));
    if (table === "drafts") return t.db.insert(s.drafts).values(guestDraft(overrides));
    const doc = await insertDocument();
    return t.db.insert(s.comparisons).values(guestComparison(doc.id, doc.id, overrides));
  }

  for (const table of tables) {
    it(`${table}: a guest row without expires_at is rejected by ${table}_guest_expires_check`, async () => {
      expect((await rejection(() => insertGuestRow(table, { expiresAt: null }))).constraint).toBe(`${table}_guest_expires_check`);
    });

    it(`${table}: a blank or whitespace-only guest id is rejected by ${table}_owner_guest_session_id_not_blank_check`, async () => {
      for (const blank of ["", "   ", "\t\n"]) {
        expect((await rejection(() => insertGuestRow(table, { ownerGuestSessionId: blank }))).constraint, JSON.stringify(blank)).toBe(
          `${table}_owner_guest_session_id_not_blank_check`,
        );
      }
      await expect(insertGuestRow(table, { ownerGuestSessionId: " guest-b " })).resolves.toBeDefined();
    });
  }

  it("user-owned rows may have no expiry; a claim re-owns AND clears expires_at in one UPDATE, never expiry first", async () => {
    const userId = await insertUser();
    await expect(t.db.insert(s.documents).values(readyTextDocument({ ownerGuestSessionId: null, ownerUserId: userId, expiresAt: null }))).resolves.toBeDefined();
    const doc = await insertDocument();
    expect(
      (await rejection(() => t.db.update(s.documents).set({ expiresAt: null }).where(eq(s.documents.id, doc.id)))).constraint,
    ).toBe("documents_guest_expires_check");
    await expect(
      t.db.update(s.documents).set({ ownerUserId: userId, ownerGuestSessionId: null, expiresAt: null }).where(eq(s.documents.id, doc.id)),
    ).resolves.toBeDefined();
  });
});

describe("findings are pinned to their analysis's document", () => {
  it("a finding whose document_id differs from its analysis's document is rejected by findings_analysis_document_fkey", async () => {
    const analysed = await insertDocument();
    const other = await insertDocument();
    const analysis = await insertAnalysis(analysed.id);
    const error = await rejection(() => t.db.insert(s.findings).values(verifiedFinding(other.id, analysis.id)));
    expect(error.constraint).toBe("findings_analysis_document_fkey");
    await expect(t.db.insert(s.findings).values(verifiedFinding(analysed.id, analysis.id))).resolves.toBeDefined();
  });
});

describe("draft_sections.provenance never names verification", () => {
  it("rejects verification-implying provenance values, accepts origin values", async () => {
    const [draft] = await t.db.insert(s.drafts).values(guestDraft()).returning();
    for (const provenance of ["verified", "Unverified", "ai_verified", "VERIFICATION_PASSED"]) {
      expect(
        (await rejection(() => t.db.insert(s.draftSections).values({ draftId: draft.id, sectionKey: "k", provenance, content: "c" })))
          .constraint,
        provenance,
      ).toBe("draft_sections_provenance_not_verification_check");
    }
    for (const provenance of ["templated", "ai_generated", "user_edited"]) {
      await expect(t.db.insert(s.draftSections).values({ draftId: draft.id, sectionKey: provenance, provenance, content: "c" })).resolves.toBeDefined();
    }
  });
});

describe("documents.storage_ref — one stored object backs at most one document row", () => {
  it("a second row with the same storage_ref is rejected by documents_storage_ref_key", async () => {
    const first = await insertDocument();
    const userId = await insertUser();
    const second = readyTextDocument({ storageRef: first.storageRef, ownerGuestSessionId: null, ownerUserId: userId });
    expect((await rejection(() => t.db.insert(s.documents).values(second))).constraint).toBe("documents_storage_ref_key");
  });

  it("a case-variant of an existing storage_ref is rejected by documents_storage_ref_lower_key", async () => {
    await insertDocument({ storageRef: "guest:guest-a/0199/Lease.pdf" });
    const alias = readyTextDocument({ storageRef: "guest:guest-a/0199/lease.PDF" });
    expect((await rejection(() => t.db.insert(s.documents).values(alias))).constraint).toBe("documents_storage_ref_lower_key");
    await t.client.exec("DROP INDEX documents_storage_ref_lower_key");
    await expect(t.db.insert(s.documents).values(alias)).resolves.toBeDefined();
  });
});

describe("row-level CHECKs added beyond the owner/native rules (spec-implied)", () => {
  it("rejects each malformed row with the named constraint", async () => {
    const userId = await insertUser();
    const thread = await insertThread(userId);
    const doc = await insertDocument();
    const analysis = await insertAnalysis(doc.id);

    const expectations: Array<[string, () => Promise<unknown>]> = [
      ["documents_ready_extracted_check", () => t.db.insert(s.documents).values(readyTextDocument({ canonicalText: null }))],
      ["documents_ready_extracted_check", () => t.db.insert(s.documents).values(readyTextDocument({ inputMode: null }))],
      ["documents_jurisdiction_iso_check", () => t.db.insert(s.documents).values(readyTextDocument({ jurisdiction: "India" }))],
      [
        "findings_status_iff_quote_check",
        () => t.db.insert(s.findings).values(verifiedFinding(doc.id, analysis.id, { quoteText: null, quoteSpanStart: null, quoteSpanEnd: null })),
      ],
      [
        "findings_verified_has_span_check",
        () => t.db.insert(s.findings).values(verifiedFinding(doc.id, analysis.id, { quoteSpanStart: null, quoteSpanEnd: null })),
      ],
      ["findings_span_check", () => t.db.insert(s.findings).values(verifiedFinding(doc.id, analysis.id, { quoteSpanStart: 10, quoteSpanEnd: 5 }))],
      ["findings_span_check", () => t.db.insert(s.findings).values(verifiedFinding(doc.id, analysis.id, { quoteSpanEnd: null }))],
      [
        "findings_status_has_verifier_version_check",
        () => t.db.insert(s.findings).values(verifiedFinding(doc.id, analysis.id, { verifierVersion: null })),
      ],
      ["messages_mode_by_role_check", () => t.db.insert(s.messages).values(assistantMessage(thread.id, { mode: null }))],
      [
        "messages_mode_by_role_check",
        () => t.db.insert(s.messages).values({ id: newId(), threadId: thread.id, role: "user", content: "hi", mode: "grounded" }),
      ],
      ["messages_assistant_model_used_check", () => t.db.insert(s.messages).values(assistantMessage(thread.id, { modelUsed: null }))],
      [
        "drafts_grounding_only_when_grounded_check",
        () => t.db.insert(s.drafts).values(guestDraft({ mode: "from_scratch", groundingDocumentId: doc.id })),
      ],
      ["analyses_document_prompt_model_key", () => insertAnalysis(doc.id)],
    ];

    for (const [constraint, run] of expectations) {
      expect((await rejection(run)).constraint, constraint).toBe(constraint);
    }
  });

  it("finding_lens_explanations: one row per (finding, lens)", async () => {
    const doc = await insertDocument();
    const analysis = await insertAnalysis(doc.id);
    const [finding] = await t.db.insert(s.findings).values(verifiedFinding(doc.id, analysis.id)).returning();
    const lens = { findingId: finding.id, roleStageLens: "tenant:before_signing", explanation: "x" };
    await t.db.insert(s.findingLensExplanations).values(lens);
    expect((await rejection(() => t.db.insert(s.findingLensExplanations).values(lens))).constraint).toBe(
      "finding_lens_explanations_finding_lens_key",
    );
  });
});

describe("(f) delete / cascade semantics", () => {
  it("project delete SET NULLs documents, threads, drafts and comparisons (they detach, not vanish)", async () => {
    const userId = await insertUser();
    const [project] = await t.db.insert(s.projects).values({ ownerUserId: userId, name: "P" }).returning();
    const doc = await insertDocument({ projectId: project.id });
    const thread = await insertThread(userId, project.id);
    const [draft] = await t.db.insert(s.drafts).values(guestDraft({ projectId: project.id })).returning();
    const [comparison] = await t.db.insert(s.comparisons).values(guestComparison(doc.id, doc.id, { projectId: project.id })).returning();

    await t.db.delete(s.projects).where(eq(s.projects.id, project.id));

    const [docAfter] = await t.db.select().from(s.documents).where(eq(s.documents.id, doc.id));
    const [threadAfter] = await t.db.select().from(s.threads).where(eq(s.threads.id, thread.id));
    const [draftAfter] = await t.db.select().from(s.drafts).where(eq(s.drafts.id, draft.id));
    const [comparisonAfter] = await t.db.select().from(s.comparisons).where(eq(s.comparisons.id, comparison.id));
    expect(docAfter.projectId).toBeNull();
    expect(threadAfter.projectId).toBeNull();
    expect(draftAfter.projectId).toBeNull();
    expect(comparisonAfter.projectId).toBeNull();
  });

  it("document delete CASCADEs analyses, findings, lens explanations and thread attachments", async () => {
    const userId = await insertUser();
    const doc = await insertDocument();
    const keep = await insertDocument();
    const analysis = await insertAnalysis(doc.id);
    const keepAnalysis = await insertAnalysis(keep.id);
    const [finding] = await t.db.insert(s.findings).values(verifiedFinding(doc.id, analysis.id)).returning();
    await t.db.insert(s.findings).values(verifiedFinding(keep.id, keepAnalysis.id));
    await t.db.insert(s.findingLensExplanations).values({ findingId: finding.id, roleStageLens: "l1", explanation: "x" });
    const thread = await insertThread(userId);
    await t.db.insert(s.threadDocuments).values({ threadId: thread.id, documentId: doc.id });

    await t.db.delete(s.documents).where(eq(s.documents.id, doc.id));

    expect(await t.db.select().from(s.findings).where(eq(s.findings.documentId, doc.id))).toHaveLength(0);
    expect(await t.db.select().from(s.analyses).where(eq(s.analyses.documentId, doc.id))).toHaveLength(0);
    expect(await t.db.select().from(s.findingLensExplanations)).toHaveLength(0);
    expect(await t.db.select().from(s.threadDocuments)).toHaveLength(0);
    // Positive control: the other document's rows are untouched.
    expect(await t.db.select().from(s.findings).where(eq(s.findings.documentId, keep.id))).toHaveLength(1);
  });

  it("document delete is RESTRICTed while a comparison references it (either side)", async () => {
    const a = await insertDocument();
    const b = await insertDocument();
    await t.db.insert(s.comparisons).values(guestComparison(a.id, b.id));
    expect((await rejection(() => t.db.delete(s.documents).where(eq(s.documents.id, a.id)))).constraint).toBe(
      "comparisons_document_a_id_fkey",
    );
    expect((await rejection(() => t.db.delete(s.documents).where(eq(s.documents.id, b.id)))).constraint).toBe(
      "comparisons_document_b_id_fkey",
    );
  });

  it("document delete SET NULLs a verified citation's source — the ceiling trigger does not block it", async () => {
    const userId = await insertUser();
    const thread = await insertThread(userId);
    const [message] = await t.db.insert(s.messages).values(assistantMessage(thread.id)).returning();
    const doc = await insertDocument();
    const [citation] = await t.db.insert(s.messageCitations).values(verifiedCitation(message.id, doc.id)).returning();

    await t.db.delete(s.documents).where(eq(s.documents.id, doc.id));

    const [after] = await t.db.select().from(s.messageCitations).where(eq(s.messageCitations.id, citation.id));
    expect(after.sourceDocumentId).toBeNull();
    expect(after.verificationStatus).toBe("verified"); // audit value only; re-verify on read yields not_found
  });

  it("document delete SET NULLs drafts.grounding_document_id; the draft survives", async () => {
    const doc = await insertDocument();
    const [draft] = await t.db.insert(s.drafts).values(guestDraft({ mode: "document_grounded", groundingDocumentId: doc.id })).returning();
    await t.db.delete(s.documents).where(eq(s.documents.id, doc.id));
    const [after] = await t.db.select().from(s.drafts).where(eq(s.drafts.id, draft.id));
    expect(after.groundingDocumentId).toBeNull();
  });

  it("a draft with a child revision is RESTRICTed; deleting the child first then the parent works", async () => {
    const [root] = await t.db.insert(s.drafts).values(guestDraft()).returning();
    const [child] = await t.db.insert(s.drafts).values(guestDraft({ parentDraftId: root.id, revisionNumber: 2 })).returning();
    expect((await rejection(() => t.db.delete(s.drafts).where(eq(s.drafts.id, root.id)))).constraint).toBe(
      "drafts_parent_draft_id_fkey",
    );
    await t.db.delete(s.drafts).where(eq(s.drafts.id, child.id));
    await t.db.delete(s.drafts).where(eq(s.drafts.id, root.id));
    expect(await t.db.select().from(s.drafts)).toHaveLength(0);
  });

  it("thread delete CASCADEs messages and their citations; comparison delete CASCADEs changes; draft delete CASCADEs sections", async () => {
    const userId = await insertUser();
    const thread = await insertThread(userId);
    const [message] = await t.db.insert(s.messages).values(assistantMessage(thread.id)).returning();
    const doc = await insertDocument();
    await t.db.insert(s.messageCitations).values(verifiedCitation(message.id, doc.id));
    const [comparison] = await t.db.insert(s.comparisons).values(guestComparison(doc.id, doc.id)).returning();
    await t.db.insert(s.comparisonChanges).values(changedChange(comparison.id));
    const [draft] = await t.db.insert(s.drafts).values(guestDraft()).returning();
    await t.db.insert(s.draftSections).values({ draftId: draft.id, sectionKey: "k", provenance: "templated", content: "c" });

    await t.db.delete(s.threads).where(eq(s.threads.id, thread.id));
    await t.db.delete(s.comparisons).where(eq(s.comparisons.id, comparison.id));
    await t.db.delete(s.drafts).where(eq(s.drafts.id, draft.id));

    expect(await t.db.select().from(s.messages)).toHaveLength(0);
    expect(await t.db.select().from(s.messageCitations)).toHaveLength(0);
    expect(await t.db.select().from(s.comparisonChanges)).toHaveLength(0);
    expect(await t.db.select().from(s.draftSections)).toHaveLength(0);
  });

  it("every FK's ON DELETE rule in the catalog matches the expected cascade behavior (docs/SCHEMA.md's Delete behaviour table)", async () => {
    // Spec-derived (docs/SCHEMA.md "Delete behaviour"), plus the rows that table does not
    // cover, marked (unspecified): users → RESTRICT, analyses/findings.analysis_id → CASCADE.
    const expected: Record<string, string> = {
      documents_project_id_fkey: "SET NULL",
      threads_project_id_fkey: "SET NULL",
      drafts_project_id_fkey: "SET NULL",
      comparisons_project_id_fkey: "SET NULL",
      findings_document_id_fkey: "CASCADE",
      finding_lens_explanations_finding_id_fkey: "CASCADE",
      comparisons_document_a_id_fkey: "RESTRICT",
      comparisons_document_b_id_fkey: "RESTRICT",
      thread_documents_document_id_fkey: "CASCADE",
      drafts_grounding_document_id_fkey: "SET NULL",
      message_citations_source_document_id_fkey: "SET NULL",
      messages_thread_id_fkey: "CASCADE",
      thread_documents_thread_id_fkey: "CASCADE",
      message_citations_message_id_fkey: "CASCADE",
      comparison_changes_comparison_id_fkey: "CASCADE",
      draft_sections_draft_id_fkey: "CASCADE",
      drafts_parent_draft_id_fkey: "RESTRICT",
      // (unspecified)
      analyses_document_id_fkey: "CASCADE",
      findings_analysis_document_fkey: "CASCADE",
      projects_owner_user_id_fkey: "RESTRICT",
      documents_owner_user_id_fkey: "RESTRICT",
      comparisons_owner_user_id_fkey: "RESTRICT",
      threads_owner_user_id_fkey: "RESTRICT",
      drafts_owner_user_id_fkey: "RESTRICT",
    };
    const result = await t.client.query<{ conname: string; rule: string }>(
      `SELECT conname,
              CASE confdeltype WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE'
                               WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END AS rule
         FROM pg_constraint
        WHERE contype = 'f' AND connamespace = 'public'::regnamespace`,
    );
    const actual = Object.fromEntries(result.rows.map((r) => [r.conname, r.rule]));
    expect(actual).toEqual(expected);
  });
});

describe("catalog post-conditions (an index/trigger that exists under the right name AND shape)", () => {
  it("every expected index exists with exactly the listed columns, and no others exist", async () => {
    const expected: Record<string, string> = {
      users_pkey: "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)",
      projects_pkey: "CREATE UNIQUE INDEX projects_pkey ON public.projects USING btree (id)",
      projects_owner_user_id_idx: "CREATE INDEX projects_owner_user_id_idx ON public.projects USING btree (owner_user_id)",
      documents_pkey: "CREATE UNIQUE INDEX documents_pkey ON public.documents USING btree (id)",
      documents_owner_user_id_idx: "CREATE INDEX documents_owner_user_id_idx ON public.documents USING btree (owner_user_id)",
      documents_owner_guest_session_id_idx:
        "CREATE INDEX documents_owner_guest_session_id_idx ON public.documents USING btree (owner_guest_session_id)",
      documents_project_id_idx: "CREATE INDEX documents_project_id_idx ON public.documents USING btree (project_id)",
      documents_expires_at_idx: "CREATE INDEX documents_expires_at_idx ON public.documents USING btree (expires_at)",
      documents_owner_user_id_updated_at_id_idx:
        "CREATE INDEX documents_owner_user_id_updated_at_id_idx ON public.documents USING btree (owner_user_id, updated_at DESC, id DESC)",
      documents_owner_guest_session_id_updated_at_id_idx:
        "CREATE INDEX documents_owner_guest_session_id_updated_at_id_idx ON public.documents USING btree (owner_guest_session_id, updated_at DESC, id DESC)",
      documents_storage_ref_key: "CREATE UNIQUE INDEX documents_storage_ref_key ON public.documents USING btree (storage_ref)",
      documents_storage_ref_lower_key:
        "CREATE UNIQUE INDEX documents_storage_ref_lower_key ON public.documents USING btree (lower(storage_ref))",
      analyses_pkey: "CREATE UNIQUE INDEX analyses_pkey ON public.analyses USING btree (id)",
      analyses_document_id_idx: "CREATE INDEX analyses_document_id_idx ON public.analyses USING btree (document_id)",
      analyses_id_document_id_key: "CREATE UNIQUE INDEX analyses_id_document_id_key ON public.analyses USING btree (id, document_id)",
      analyses_document_prompt_model_key:
        "CREATE UNIQUE INDEX analyses_document_prompt_model_key ON public.analyses USING btree (document_id, prompt_version, model_used)",
      findings_pkey: "CREATE UNIQUE INDEX findings_pkey ON public.findings USING btree (id)",
      findings_document_id_idx: "CREATE INDEX findings_document_id_idx ON public.findings USING btree (document_id)",
      findings_analysis_id_idx: "CREATE INDEX findings_analysis_id_idx ON public.findings USING btree (analysis_id)",
      finding_lens_explanations_pkey:
        "CREATE UNIQUE INDEX finding_lens_explanations_pkey ON public.finding_lens_explanations USING btree (id)",
      finding_lens_explanations_finding_id_idx:
        "CREATE INDEX finding_lens_explanations_finding_id_idx ON public.finding_lens_explanations USING btree (finding_id)",
      finding_lens_explanations_finding_lens_key:
        "CREATE UNIQUE INDEX finding_lens_explanations_finding_lens_key ON public.finding_lens_explanations USING btree (finding_id, role_stage_lens)",
      threads_pkey: "CREATE UNIQUE INDEX threads_pkey ON public.threads USING btree (id)",
      threads_owner_user_id_idx: "CREATE INDEX threads_owner_user_id_idx ON public.threads USING btree (owner_user_id)",
      threads_project_id_idx: "CREATE INDEX threads_project_id_idx ON public.threads USING btree (project_id)",
      messages_pkey: "CREATE UNIQUE INDEX messages_pkey ON public.messages USING btree (id)",
      messages_thread_id_created_at_id_idx:
        "CREATE INDEX messages_thread_id_created_at_id_idx ON public.messages USING btree (thread_id, created_at DESC, id DESC)",
      comparisons_pkey: "CREATE UNIQUE INDEX comparisons_pkey ON public.comparisons USING btree (id)",
      comparisons_owner_user_id_idx: "CREATE INDEX comparisons_owner_user_id_idx ON public.comparisons USING btree (owner_user_id)",
      comparisons_owner_guest_session_id_idx:
        "CREATE INDEX comparisons_owner_guest_session_id_idx ON public.comparisons USING btree (owner_guest_session_id)",
      comparisons_project_id_idx: "CREATE INDEX comparisons_project_id_idx ON public.comparisons USING btree (project_id)",
      comparisons_document_a_id_idx: "CREATE INDEX comparisons_document_a_id_idx ON public.comparisons USING btree (document_a_id)",
      comparisons_document_b_id_idx: "CREATE INDEX comparisons_document_b_id_idx ON public.comparisons USING btree (document_b_id)",
      comparisons_expires_at_idx: "CREATE INDEX comparisons_expires_at_idx ON public.comparisons USING btree (expires_at)",
      comparisons_owner_user_id_updated_at_id_idx:
        "CREATE INDEX comparisons_owner_user_id_updated_at_id_idx ON public.comparisons USING btree (owner_user_id, updated_at DESC, id DESC)",
      comparisons_owner_guest_session_id_updated_at_id_idx:
        "CREATE INDEX comparisons_owner_guest_session_id_updated_at_id_idx ON public.comparisons USING btree (owner_guest_session_id, updated_at DESC, id DESC)",
      comparison_changes_pkey: "CREATE UNIQUE INDEX comparison_changes_pkey ON public.comparison_changes USING btree (id)",
      comparison_changes_comparison_id_idx:
        "CREATE INDEX comparison_changes_comparison_id_idx ON public.comparison_changes USING btree (comparison_id)",
      drafts_pkey: "CREATE UNIQUE INDEX drafts_pkey ON public.drafts USING btree (id)",
      drafts_owner_user_id_idx: "CREATE INDEX drafts_owner_user_id_idx ON public.drafts USING btree (owner_user_id)",
      drafts_owner_guest_session_id_idx:
        "CREATE INDEX drafts_owner_guest_session_id_idx ON public.drafts USING btree (owner_guest_session_id)",
      drafts_project_id_idx: "CREATE INDEX drafts_project_id_idx ON public.drafts USING btree (project_id)",
      drafts_expires_at_idx: "CREATE INDEX drafts_expires_at_idx ON public.drafts USING btree (expires_at)",
      drafts_grounding_document_id_idx:
        "CREATE INDEX drafts_grounding_document_id_idx ON public.drafts USING btree (grounding_document_id)",
      drafts_parent_draft_id_idx: "CREATE INDEX drafts_parent_draft_id_idx ON public.drafts USING btree (parent_draft_id)",
      drafts_owner_user_id_updated_at_id_idx:
        "CREATE INDEX drafts_owner_user_id_updated_at_id_idx ON public.drafts USING btree (owner_user_id, updated_at DESC, id DESC)",
      drafts_owner_guest_session_id_updated_at_id_idx:
        "CREATE INDEX drafts_owner_guest_session_id_updated_at_id_idx ON public.drafts USING btree (owner_guest_session_id, updated_at DESC, id DESC)",
      draft_sections_pkey: "CREATE UNIQUE INDEX draft_sections_pkey ON public.draft_sections USING btree (id)",
      draft_sections_draft_id_idx: "CREATE INDEX draft_sections_draft_id_idx ON public.draft_sections USING btree (draft_id)",
      thread_documents_pkey:
        "CREATE UNIQUE INDEX thread_documents_pkey ON public.thread_documents USING btree (thread_id, document_id)",
      thread_documents_document_id_idx:
        "CREATE INDEX thread_documents_document_id_idx ON public.thread_documents USING btree (document_id)",
      thread_documents_thread_id_idx: "CREATE INDEX thread_documents_thread_id_idx ON public.thread_documents USING btree (thread_id)",
      message_citations_pkey: "CREATE UNIQUE INDEX message_citations_pkey ON public.message_citations USING btree (id)",
      message_citations_source_document_id_idx:
        "CREATE INDEX message_citations_source_document_id_idx ON public.message_citations USING btree (source_document_id)",
      message_citations_message_id_idx:
        "CREATE INDEX message_citations_message_id_idx ON public.message_citations USING btree (message_id)",
      rate_limit_buckets_pkey:
        "CREATE UNIQUE INDEX rate_limit_buckets_pkey ON public.rate_limit_buckets USING btree (principal_key, window_key)",
      ip_rate_limit_buckets_pkey:
        "CREATE UNIQUE INDEX ip_rate_limit_buckets_pkey ON public.ip_rate_limit_buckets USING btree (ip_key, window_key)",
      global_llm_rate_limit_pkey:
        "CREATE UNIQUE INDEX global_llm_rate_limit_pkey ON public.global_llm_rate_limit USING btree (provider_key, window_key)",
      analyzed_result_cache_pkey:
        "CREATE UNIQUE INDEX analyzed_result_cache_pkey ON public.analyzed_result_cache USING btree (cache_key)",
      analyzed_result_cache_expires_at_idx:
        "CREATE INDEX analyzed_result_cache_expires_at_idx ON public.analyzed_result_cache USING btree (expires_at)",
      schema_migrations_pkey: "CREATE UNIQUE INDEX schema_migrations_pkey ON public.schema_migrations USING btree (name)",
    };
    const result = await t.client.query<{ indexname: string; indexdef: string }>(
      "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'",
    );
    expect(Object.fromEntries(result.rows.map((r) => [r.indexname, r.indexdef]))).toEqual(expected);
  });

  it("the five integrity triggers: enabled, row-level, BEFORE, on exactly the right tables, events and columns", async () => {
    const enabled = await t.client.query<{ tgname: string; enabled: string }>(
      "SELECT tgname, tgenabled AS enabled FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname",
    );
    expect(enabled.rows.map((r) => [r.tgname, r.enabled])).toEqual([
      ["comparison_changes_native_document_verified_ceiling", "O"],
      ["comparisons_document_pair_immutable", "O"],
      ["documents_input_mode_immutable", "O"],
      ["findings_native_document_verified_ceiling", "O"],
      ["message_citations_native_document_verified_ceiling", "O"],
    ]);
    // information_schema.triggers has one row per (trigger, event); a BEFORE-INSERT-only or an
    // AFTER mutant of any trigger changes this list.
    const events = await t.client.query<{ name: string; tbl: string; event: string; timing: string; orientation: string }>(
      `SELECT trigger_name AS name, event_object_table AS tbl, event_manipulation AS event,
              action_timing AS timing, action_orientation AS orientation
         FROM information_schema.triggers WHERE trigger_schema = 'public'
        ORDER BY trigger_name, event_manipulation`,
    );
    expect(events.rows.map((r) => `${r.name} ${r.timing} ${r.event} ON ${r.tbl} FOR EACH ${r.orientation}`)).toEqual([
      "comparison_changes_native_document_verified_ceiling BEFORE INSERT ON comparison_changes FOR EACH ROW",
      "comparison_changes_native_document_verified_ceiling BEFORE UPDATE ON comparison_changes FOR EACH ROW",
      "comparisons_document_pair_immutable BEFORE UPDATE ON comparisons FOR EACH ROW",
      "documents_input_mode_immutable BEFORE UPDATE ON documents FOR EACH ROW",
      "findings_native_document_verified_ceiling BEFORE INSERT ON findings FOR EACH ROW",
      "findings_native_document_verified_ceiling BEFORE UPDATE ON findings FOR EACH ROW",
      "message_citations_native_document_verified_ceiling BEFORE INSERT ON message_citations FOR EACH ROW",
      "message_citations_native_document_verified_ceiling BEFORE UPDATE ON message_citations FOR EACH ROW",
    ]);
    // The ceilings fire on an UPDATE of ANY column; the immutability guards on exactly their columns.
    const columns = await t.client.query<{ name: string; col: string }>(
      `SELECT trigger_name AS name, event_object_column AS col FROM information_schema.triggered_update_columns
        WHERE trigger_schema = 'public' ORDER BY trigger_name, event_object_column`,
    );
    expect(columns.rows.map((r) => `${r.name}.${r.col}`)).toEqual([
      "comparisons_document_pair_immutable.document_a_id",
      "comparisons_document_pair_immutable.document_b_id",
      "documents_input_mode_immutable.input_mode",
    ]);
  });

  it("nothing from pending/ or prod-only/ was applied", async () => {
    const result = await t.client.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name");
    expect(result.rows.map((r) => r.name)).toEqual([
      "0001_core_schema.sql",
      "0002_rate_limits_and_cache.sql",
      "0003_comparisons_drafts_model_used.sql",
      "0004_drafts_jurisdiction.sql",
      "0005_titles_samples_updated_at.sql",
    ]);
    const probes = await t.client.query<{ embeddings: string | null; app_private: number; vector: number }>(
      `SELECT to_regclass('public.document_embeddings')::text AS embeddings,
              (SELECT count(*)::int FROM pg_namespace WHERE nspname = 'app_private') AS app_private,
              (SELECT count(*)::int FROM pg_extension WHERE extname = 'vector') AS vector`,
    );
    expect(probes.rows[0]).toEqual({ embeddings: null, app_private: 0, vector: 0 });
  });

  it("raw SQL through drizzle works against the typed schema (sanity)", async () => {
    const rows = await t.db.execute(sql`SELECT count(*)::int AS n FROM ${s.documents}`);
    expect(rows.rows[0]).toEqual({ n: 0 });
  });
});
