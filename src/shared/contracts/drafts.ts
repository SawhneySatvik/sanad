/**
 * POST /api/drafts, POST /api/drafts/:id/revise, GET /api/drafts/:id. This shape has no
 * status/verified field anywhere — DraftSectionOutput.provenance is "templated" | "ai_generated"
 * only, so there is no key that could ever carry a verification claim (drafts.test.ts asserts this
 * with a runtime key check). modelUsed is always the real, persisted value — a Gemma-degraded draft
 * never looks identical to a Gemini one after a reload. Request schemas are strict: a client can
 * never submit provenance, a section body or a status directly.
 */

import { z } from "zod";
import { IsoDateTime } from "./common";

// Duplicated from the server-side draft-templates registry, not imported — a contract must not
// pull in server code. Kept structurally equal by a test; the service validates the actual pairing.
const DRAFTABLE_DOCUMENT_TYPE_IDS = [
  "leave_and_license",
  "job_offer_letter",
  "nda",
  "privacy_policy",
  "freelance_service_agreement",
  "grounded_response",
] as const;

/** POST /api/drafts' request body. */
export const CreateDraftInput = z.strictObject({
  mode: z.enum(["from_scratch", "document_grounded"]),
  documentType: z.enum(DRAFTABLE_DOCUMENT_TYPE_IDS),
  // A body field, so a strict z.guid() would make a malformed id 400 while a foreign/missing one is
  // 404 — a bounded z.string() lets the service answer uniformly instead.
  groundingDocumentId: z.string().min(1).max(64).optional(),
  // Mirrors the draft prompt's own instructions-length cap, duplicated as a literal since a
  // contract does not import prompt code; a test pins the two equal.
  userInstructions: z.string().min(1).max(4000),
  // ISO country code; which codes are actually supported for a given documentType is a
  // service-level check.
  jurisdiction: z.string().regex(/^[A-Z]{2}$/),
});
export type CreateDraftInput = z.infer<typeof CreateDraftInput>;

/** POST /api/drafts/:id/revise's request body. */
export const ReviseDraftInput = z.strictObject({
  userInstructions: z.string().min(1).max(4000),
});
export type ReviseDraftInput = z.infer<typeof ReviseDraftInput>;

/** One section of a draft's content. */
export const DraftSectionOutput = z.object({
  key: z.string(),
  heading: z.string(),
  provenance: z.enum(["templated", "ai_generated"]),
  content: z.string(),
});
export type DraftSectionOutput = z.infer<typeof DraftSectionOutput>;

// One shape for create()/revise()/get(): the service returns the identical DraftResult for all
// three, so a draft is never shown without its sections.
/** A draft with its sections — the response for create, revise and get alike. */
export const DraftWithSectionsOutput = z.object({
  id: z.guid(),
  documentType: z.string(),
  mode: z.enum(["from_scratch", "document_grounded"]),
  groundingDocumentId: z.guid().nullable(),
  revisionNumber: z.number().int().positive(),
  parentDraftId: z.guid().nullable(),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime.nullable(),
  modelUsed: z.string(),
  jurisdiction: z.string(),
  // null only when mode is from_scratch — there is no grounding document to speak of.
  groundingDocumentAvailable: z.boolean().nullable(),
  // null for get(): not persisted, so an existing row's original prompt version is unrecoverable.
  promptVersion: z.string().nullable(),
  content: z.string(),
  sections: z.array(DraftSectionOutput),
});
export type DraftWithSectionsOutput = z.infer<typeof DraftWithSectionsOutput>;

/** POST /api/drafts and POST /api/drafts/:id/revise's response — the same shape as DraftWithSectionsOutput. */
export const DraftOutput = DraftWithSectionsOutput;
export type DraftOutput = DraftWithSectionsOutput;
