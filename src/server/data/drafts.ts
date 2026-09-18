/**
 * Drafts repository. Every function authorizes through canAccess before it reads/writes a row.
 * expires_at is never passed in: create computes it from the principal and any grounding document,
 * and a revision copies its parent's. model_used is caller-supplied on both; jurisdiction is
 * caller-supplied on create and inherited by a revision.
 */

import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import * as schema from "../../db/schema";
import { AppError, notFound } from "../core/errors";
import type { Principal } from "../core/types";
import {
  isDraftableDocumentType,
  missingRequiredSections,
  requiredSectionKeys,
  type DraftableDocumentTypeId,
  type DraftProvenance,
} from "../deterministic/draft-templates";
import { assertCanAccess, type OwnedResource } from "./access";
import { assertBelowActiveRowCap } from "./documents";

/** A persisted draft row, as read from the database. */
export type Draft = typeof schema.drafts.$inferSelect;
/** A persisted draft-section row, as read from the database. */
export type DraftSectionRow = typeof schema.draftSections.$inferSelect;
/** Whether a draft was written from scratch or grounded in an attached document. */
export type DraftMode = Draft["mode"];

/** A draft with its sections, in template order. */
export interface DraftWithSections extends Draft {
  // Always in template order (draft_sections carries no ordinal column — order is reconstructed
  // from draft-templates on every read, never trusted from insertion/select order).
  sections: DraftSectionRow[];
}

/**
 * A document row this repository needs only the fields of — kept minimal and structural rather than
 * importing documents.ts's own `Document` type, so this file's public surface doesn't shift shape if
 * the documents schema grows columns unrelated to drafting.
 */
export interface GroundingDocumentRef {
  id: string;
  ownerUserId: string | null;
  ownerGuestSessionId: string | null;
  expiresAt: Date | null;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function isUuidShaped(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Bounded by the guest session cookie's own lifetime — a draft never outlives the guest session that
 * created it. A from_scratch draft's expires_at is this TTL from creation for a guest, or null for a
 * user; a document_grounded draft's is never later than either this TTL or its grounding document's.
 */
export const DRAFT_GUEST_TTL_SECONDS = 3 * 60 * 60;

function draftOwnedResource(row: Pick<Draft, "ownerUserId" | "ownerGuestSessionId"> | undefined): OwnedResource | undefined {
  return row ? { ownerUserId: row.ownerUserId, ownerGuestSessionId: row.ownerGuestSessionId } : undefined;
}

function ownTtlExpiresAt(principal: Principal): Date | null {
  return principal.type === "guest" ? new Date(Date.now() + DRAFT_GUEST_TTL_SECONDS * 1000) : null;
}

// null means "no cap" (a user-owned row with no TTL) — treated as +infinity so a null on either side
// never wins over a real cap.
function earliestExpiry(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() <= b.getTime() ? a : b;
}

function toDraftableDocumentTypeId(value: string): DraftableDocumentTypeId | null {
  return isDraftableDocumentType(value) ? value : null;
}

// Reconstructs section order (and drops any row whose key the current template no longer
// recognizes, defensively) from draft-templates — never from insertion/select order.
function orderSections(documentType: string, rows: readonly DraftSectionRow[]): DraftSectionRow[] {
  const draftableType = toDraftableDocumentTypeId(documentType);
  if (draftableType === null) return [...rows];
  const bySectionKey = new Map(rows.map((row) => [row.sectionKey, row]));
  return requiredSectionKeys(draftableType)
    .map((key) => bySectionKey.get(key))
    .filter((row): row is DraftSectionRow => row !== undefined);
}

function assertExactSectionSet(documentType: DraftableDocumentTypeId, sections: readonly { sectionKey: string; content: string }[]): void {
  const keys = sections.map((section) => section.sectionKey);
  // Blank-content-aware: a section present with an empty/whitespace-only body is treated as missing,
  // not present.
  const missing = missingRequiredSections(documentType, sections);
  if (missing.length > 0) {
    throw new AppError("VALIDATION_FAILED", `Missing required draft sections: ${missing.join(", ")}.`);
  }
  const expected = new Set(requiredSectionKeys(documentType));
  const extra = keys.filter((key) => !expected.has(key));
  if (extra.length > 0) {
    throw new AppError("VALIDATION_FAILED", `Unexpected draft sections: ${extra.join(", ")}.`);
  }
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) throw new AppError("VALIDATION_FAILED", `Duplicate draft section: ${key}.`);
    seen.add(key);
  }
}

// A row past its own expires_at is treated as already gone — identical to a missing row — even if
// the guest-TTL sweep hasn't deleted it yet: a still-in-flight get()/revise() must not be able to
// read or extend a chain the sweep is about to delete out from under it. Checked after
// assertCanAccess so a foreign expired row still 404s the same way a foreign live row does.
function assertNotExpired(row: Draft): void {
  if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
    throw notFound();
  }
}

async function getDraftRow(db: Db, principal: Principal, draftId: string): Promise<Draft> {
  const [row] = isUuidShaped(draftId) ? await db.select().from(schema.drafts).where(eq(schema.drafts.id, draftId)) : [];
  assertCanAccess(principal, draftOwnedResource(row));
  assertNotExpired(row);
  return row;
}

/** One section to persist as part of a new or revised draft. */
export interface NewDraftSectionInput {
  sectionKey: string;
  provenance: DraftProvenance;
  content: string;
}

/** Fields required to create a draft's root revision. */
export interface CreateDraftInput {
  documentType: DraftableDocumentTypeId;
  mode: DraftMode;
  // Already fetched and ownership-checked by the caller (services/draft.ts, before the LLM call) for
  // document_grounded mode; undefined for from_scratch. Re-checked here too.
  groundingDocument?: GroundingDocumentRef;
  sections: NewDraftSectionInput[];
  content: string;
  // Which model actually produced this draft's ai_generated sections (LlmCompleteResult.modelUsed) —
  // persisted, never inferred.
  modelUsed: string;
  // ISO country code (drafts_jurisdiction_iso_check: ^[A-Z]{2}$) — caller-supplied and service-
  // validated against the document-type registry's jurisdictions list before this is called.
  jurisdiction: string;
}

/** Creates a draft's root revision (revisionNumber 1, no parent); RATE_LIMITED over the principal's active-draft cap. */
export async function createDraft(db: Db, principal: Principal, input: CreateDraftInput): Promise<DraftWithSections> {
  if (input.mode === "document_grounded") {
    if (!input.groundingDocument) {
      throw new AppError("VALIDATION_FAILED", "document_grounded mode requires a grounding document.");
    }
    assertCanAccess(principal, input.groundingDocument);
  } else if (input.groundingDocument) {
    throw new AppError("VALIDATION_FAILED", "from_scratch mode must not set a grounding document.");
  }
  assertExactSectionSet(input.documentType, input.sections);

  const own = ownTtlExpiresAt(principal);
  const expiresAt = input.mode === "document_grounded" ? earliestExpiry(own, input.groundingDocument!.expiresAt) : own;
  const owner: Pick<Draft, "ownerUserId" | "ownerGuestSessionId"> =
    principal.type === "user"
      ? { ownerUserId: principal.userId, ownerGuestSessionId: null }
      : { ownerUserId: null, ownerGuestSessionId: principal.guestSessionId };

  return db.transaction(async (tx) => {
    // Inside the transaction every query uses `tx`, never the outer `db` — PGlite holds a single
    // connection, so a query against `db` here would wait on this transaction forever (matches
    // services/understand.ts's analyzeDocument comment on the same trap).
    await assertBelowActiveRowCap(tx, principal, "drafts");
    const [draft] = await tx
      .insert(schema.drafts)
      .values({
        ...owner,
        documentType: input.documentType,
        mode: input.mode,
        groundingDocumentId: input.groundingDocument?.id ?? null,
        content: input.content,
        revisionNumber: 1,
        parentDraftId: null,
        expiresAt,
        modelUsed: input.modelUsed,
        jurisdiction: input.jurisdiction,
      })
      .returning();
    const sectionRows = input.sections.length
      ? await tx
          .insert(schema.draftSections)
          .values(input.sections.map((section) => ({ draftId: draft.id, sectionKey: section.sectionKey, provenance: section.provenance, content: section.content })))
          .returning()
      : [];
    return { ...draft, sections: orderSections(input.documentType, sectionRows) };
  });
}

/** Fields required to create a new revision of an existing draft. */
export interface ReviseDraftInput {
  sections: NewDraftSectionInput[];
  content: string;
  // The model that produced this revision's text — a fresh LLM call, so its own value, never
  // inherited from the parent (unlike expires_at).
  modelUsed: string;
}

/**
 * Creates a new revision under `parentDraftId`: same principal check as get() (via getDraftRow), same
 * TTL inheritance (copies parent.expiresAt unchanged). Keeps the parent's
 * document_type/mode/grounding_document_id — a revision does not change what kind of draft this is,
 * only its section content. A revision is a row of its own, so it counts against the active-draft cap.
 */
export async function reviseDraft(db: Db, principal: Principal, parentDraftId: string, input: ReviseDraftInput): Promise<DraftWithSections> {
  const parent = await getDraftRow(db, principal, parentDraftId);
  const documentType = toDraftableDocumentTypeId(parent.documentType);
  if (documentType === null) {
    throw new AppError("VALIDATION_FAILED", `Draft ${parent.id} has no recognized draft template to revise against.`);
  }
  assertExactSectionSet(documentType, input.sections);

  return db.transaction(async (tx) => {
    await assertBelowActiveRowCap(tx, principal, "drafts");
    const [draft] = await tx
      .insert(schema.drafts)
      .values({
        ownerUserId: parent.ownerUserId,
        ownerGuestSessionId: parent.ownerGuestSessionId,
        documentType: parent.documentType,
        mode: parent.mode,
        groundingDocumentId: parent.groundingDocumentId,
        content: input.content,
        // No uniqueness constraint, deliberately: two children of the same parentDraftId sharing a
        // revisionNumber is an accepted shape (a revision tree, e.g. trying two rewrites of v1 side
        // by side), not a bug — this is purely a display/ordering hint along one chain, never global.
        revisionNumber: parent.revisionNumber + 1,
        parentDraftId: parent.id,
        // Inherited unchanged — never recomputed from "now": a later revision must never get a later
        // expiry than its parent, or the guest-TTL sweep would hit parent_draft_id's RESTRICT rule.
        expiresAt: parent.expiresAt,
        // NOT inherited — this revision's own fresh LLM call may have used a different model
        // (fallback) than the parent's.
        modelUsed: input.modelUsed,
        // Inherited unchanged, same reasoning as expires_at — a draft's jurisdiction describes the
        // document being drafted, not the revision. Never caller-supplied here.
        jurisdiction: parent.jurisdiction,
      })
      .returning();
    const sectionRows = input.sections.length
      ? await tx
          .insert(schema.draftSections)
          .values(input.sections.map((section) => ({ draftId: draft.id, sectionKey: section.sectionKey, provenance: section.provenance, content: section.content })))
          .returning()
      : [];
    return { ...draft, sections: orderSections(documentType, sectionRows) };
  });
}

/** A draft with its sections, in template order. */
export async function getDraft(db: Db, principal: Principal, draftId: string): Promise<DraftWithSections> {
  const draft = await getDraftRow(db, principal, draftId);
  const sectionRows = await db.select().from(schema.draftSections).where(eq(schema.draftSections.draftId, draft.id));
  return { ...draft, sections: orderSections(draft.documentType, sectionRows) };
}
