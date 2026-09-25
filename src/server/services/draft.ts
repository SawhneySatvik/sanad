/**
 * Draft service — from-scratch and document-grounded drafting, with a revision chain. Route
 * handlers call create()/revise()/get(), nothing else.
 *
 * The model's response schema carries no status/span field, only each ai_generated section's body
 * text; every other section is fixed "templated" text, never the model's. No DB connection or
 * transaction spans the LLM call: persistence happens in one short transaction strictly after it,
 * and a response missing a required section, or a provider failure, leaves no row persisted.
 */

import type { Db } from "../../db/client";
import { AppError } from "../core/errors";
import type { Principal } from "../core/types";
import {
  getDraftTemplate,
  headingFor,
  isDraftableDocumentType,
  renderDraftContent,
  type DraftableDocumentTypeId,
  type DraftProvenance,
  type DraftTemplate,
} from "../deterministic/draft-templates";
import { DOCUMENT_TYPE_REGISTRY } from "../deterministic/document-type-registry";
import { createDraft, getDraft, reviseDraft, type DraftMode, type DraftWithSections, type NewDraftSectionInput } from "../data/drafts";
import { assertBelowActiveRowCap, getDocument, type Document } from "../data/documents";
import { LLM_TIMEOUT_MS, MODEL_INPUT_BUDGET_CHARS } from "../llm/timeouts";
import type { LlmClient } from "../llm/types";
import { buildDraftRevisionUserPrompt, buildDraftSystemPrompt, buildDraftUserPrompt, MAX_INSTRUCTIONS_CHARS } from "../prompts/draft/prompt";
import { buildDraftResponseSchema } from "../prompts/draft/schema";
import { PROMPT_VERSION } from "../prompts/draft/version";

// Re-exported so callers don't also need to import draft-templates directly for the closed
// provenance union this service's own output type is built from.
export type { DraftProvenance } from "../deterministic/draft-templates";

/** Dependencies create()/revise() need; get() uses only `db`. */
export interface DraftDeps {
  db: Db;
  llm: LlmClient;
}

/**
 * Input to create(). No projectId: every draft this service creates starts unattached, and can be
 * attached to a project afterwards through projects.saveToProject, which checks ownership of both.
 */
export interface CreateDraftInput {
  mode: DraftMode;
  documentType: DraftableDocumentTypeId;
  groundingDocumentId?: string;
  userInstructions: string;
  jurisdiction: string;
}

/** Input to revise(). */
export interface ReviseDraftInput {
  userInstructions: string;
}

/**
 * Structural guarantee: this shape has no `status`/`verified` field — `provenance` is the closed
 * DraftProvenance union, which cannot express a verification claim (draft.test.ts asserts this
 * both at the type level and with a runtime key check).
 */
export interface DraftSectionOutput {
  key: string;
  heading: string;
  provenance: DraftProvenance;
  content: string;
}

/** The shape create(), revise() and get() all return. */
export interface DraftResult {
  id: string;
  title: string;
  documentType: DraftableDocumentTypeId;
  mode: DraftMode;
  groundingDocumentId: string | null;
  revisionNumber: number;
  parentDraftId: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  // Always the real, persisted value (drafts.model_used is NOT NULL). A revision's own fresh LLM
  // call may use a different model than its parent (fallback), so unlike jurisdiction it is never
  // inherited.
  modelUsed: string;
  jurisdiction: string;
  // null when mode is from_scratch. For create()/revise(), reflects whether this call had live
  // grounding context (an inaccessible document returns false). For get(), it's only a best-effort
  // read of whether the row still references one, not a fresh accessibility check.
  groundingDocumentAvailable: boolean | null;
  // The PROMPT_VERSION that produced this result's ai_generated sections — not persisted (no DB
  // column), so get() cannot recover it for an existing row and returns null instead of guessing.
  promptVersion: string | null;
  content: string;
  sections: DraftSectionOutput[];
}

function assertValidInstructions(userInstructions: string): void {
  if (userInstructions.trim().length === 0) {
    throw new AppError("VALIDATION_FAILED", "userInstructions must not be blank.");
  }
  // Checked before any prompt is built — instructions have no upstream extraction-layer cap the
  // way a document's canonical_text does.
  if (userInstructions.length > MAX_INSTRUCTIONS_CHARS) {
    throw new AppError("VALIDATION_FAILED", `userInstructions exceeds the ${MAX_INSTRUCTIONS_CHARS}-character cap.`);
  }
}

function assertValidCreateInput(input: CreateDraftInput): void {
  if (!isDraftableDocumentType(input.documentType)) {
    throw new AppError("VALIDATION_FAILED", `"${input.documentType}" has no draft template.`);
  }
  if (input.mode === "document_grounded" && !input.groundingDocumentId) {
    throw new AppError("VALIDATION_FAILED", "document_grounded mode requires groundingDocumentId.");
  }
  if (input.mode === "from_scratch" && input.groundingDocumentId) {
    throw new AppError("VALIDATION_FAILED", "from_scratch mode must not set groundingDocumentId.");
  }
  const registryEntry = DOCUMENT_TYPE_REGISTRY.find((entry) => entry.id === input.documentType);
  if (!registryEntry?.jurisdictions.includes(input.jurisdiction)) {
    throw new AppError("VALIDATION_FAILED", `Unsupported jurisdiction "${input.jurisdiction}" for "${input.documentType}".`);
  }
  assertValidInstructions(input.userInstructions);
}

// The instructions are capped far below the budget, so only a grounding document (plus a
// revision's previous sections) can take a prompt over it.
function assertWithinInputBudget(userPrompt: string): void {
  if (userPrompt.length > MODEL_INPUT_BUDGET_CHARS.draft) {
    throw new AppError(
      "INVALID_DOCUMENT",
      `The grounding document is too long to draft from: ${userPrompt.length} characters of input, over the ${MODEL_INPUT_BUDGET_CHARS.draft}-character limit.`,
      { reason: "grounding_too_long" },
    );
  }
}

function assertGroundingDocumentReady(document: Document): void {
  if (document.processingStatus !== "ready" || document.canonicalText === null || document.canonicalTextHash === null) {
    throw new AppError("INVALID_DOCUMENT", "The grounding document has not finished processing.", { reason: "grounding_not_ready" });
  }
}

// Templated sections come from draft-templates only, never from the model — the model's response
// schema doesn't even carry a key for them (prompts/draft/schema.ts's aiSectionKeys), so there is
// nothing here to filter beyond reading the right source per section.
function buildSectionInputs(template: DraftTemplate, aiSections: Record<string, string>): NewDraftSectionInput[] {
  return template.sections.map((section) =>
    section.provenance === "templated"
      ? { sectionKey: section.key, provenance: "templated" as const, content: section.body! }
      : { sectionKey: section.key, provenance: "ai_generated" as const, content: aiSections[section.key] },
  );
}

interface ToDraftResultOptions {
  // The PROMPT_VERSION that produced this call's sections — PROMPT_VERSION for a fresh create()/
  // revise(), null for get() (not persisted, so an existing row's original version is unrecoverable).
  promptVersion: string | null;
  // Explicit, never derived from `draft.groundingDocumentId` alone: a still-set id doesn't mean the
  // document was actually available for this call. create()/revise() pass the real answer; get()
  // passes its best-effort read (see DraftResult.groundingDocumentAvailable's own comment).
  groundingDocumentAvailable: boolean | null;
}

function toDraftResult(draft: DraftWithSections, options: ToDraftResultOptions): DraftResult {
  // Safe: data/drafts.ts's createDraft/reviseDraft only ever persist a draftable document_type
  // (assertExactSectionSet would have rejected anything else before the row existed).
  const documentType = draft.documentType as DraftableDocumentTypeId;
  return {
    id: draft.id,
    title: draft.title ?? `${DOCUMENT_TYPE_REGISTRY.find((entry) => entry.id === documentType)?.label ?? documentType} draft`,
    documentType,
    mode: draft.mode,
    groundingDocumentId: draft.groundingDocumentId,
    revisionNumber: draft.revisionNumber,
    parentDraftId: draft.parentDraftId,
    createdAt: draft.createdAt,
    expiresAt: draft.expiresAt,
    modelUsed: draft.modelUsed,
    jurisdiction: draft.jurisdiction,
    groundingDocumentAvailable: options.groundingDocumentAvailable,
    promptVersion: options.promptVersion,
    content: draft.content,
    sections: draft.sections.map((row) => ({
      key: row.sectionKey,
      heading: headingFor(documentType, row.sectionKey),
      provenance: row.provenance as DraftProvenance,
      content: row.content,
    })),
  };
}

/**
 * Creates a draft: from scratch, or grounded in an already-extracted document the principal owns.
 * A grounding document is loaded and checked before the LLM call, and the draft persists in one
 * short transaction strictly after it.
 *
 * @example
 * const draft = await create(deps, principal, { mode: "from_scratch", documentType, userInstructions, jurisdiction });
 */
export async function create(deps: DraftDeps, principal: Principal, input: CreateDraftInput): Promise<DraftResult> {
  assertValidCreateInput(input);
  // createDraft enforces the cap after the model call; checked first too, so a principal at the cap
  // spends no call.
  await assertBelowActiveRowCap(deps.db, principal, "drafts");

  let groundingDocument: Document | undefined;
  if (input.mode === "document_grounded") {
    // Ownership-checked before the LLM call — a foreign/missing document 404s here, never spending a
    // call (the IDOR gate asserts llm.callCount stays 0 for this path).
    groundingDocument = await getDocument(deps.db, principal, input.groundingDocumentId!);
    assertGroundingDocumentReady(groundingDocument);
  }

  const template = getDraftTemplate(input.documentType);
  const schema = buildDraftResponseSchema(input.documentType);
  const systemPrompt = buildDraftSystemPrompt(input.documentType, input.mode, groundingDocument !== undefined);
  const userPrompt = buildDraftUserPrompt({
    documentType: input.documentType,
    jurisdiction: input.jurisdiction,
    userInstructions: input.userInstructions,
    groundingDocument: groundingDocument
      ? { canonicalText: groundingDocument.canonicalText!, canonicalTextHash: groundingDocument.canonicalTextHash! }
      : undefined,
  });
  assertWithinInputBudget(userPrompt);

  // No DB connection/transaction spans this call — everything above already resolved.
  const { data, modelUsed } = await deps.llm.complete({ systemPrompt, userPrompt, schema, timeoutMs: LLM_TIMEOUT_MS.draft });

  const sections = buildSectionInputs(template, data.sections);
  const content = renderDraftContent(input.documentType, sections);

  const draft = await createDraft(deps.db, principal, {
    documentType: input.documentType,
    title: `${DOCUMENT_TYPE_REGISTRY.find((entry) => entry.id === input.documentType)?.label ?? input.documentType} draft`,
    userInstructions: input.userInstructions,
    mode: input.mode,
    groundingDocument,
    sections,
    content,
    modelUsed,
    jurisdiction: input.jurisdiction,
  });
  // document_grounded always has a live groundingDocument by this point (assertGroundingDocumentReady
  // already threw otherwise) — never false/null on a freshly created grounded draft.
  return toDraftResult(draft, { promptVersion: PROMPT_VERSION, groundingDocumentAvailable: input.mode === "document_grounded" ? true : null });
}

/**
 * Revises a draft: re-runs the LLM call with the user's new instructions and the previous
 * ai_generated section bodies. A document_grounded draft survives its grounding document's
 * deletion or expiry — the revision proceeds without fresh grounding context rather than failing.
 */
export async function revise(deps: DraftDeps, principal: Principal, parentDraftId: string, input: ReviseDraftInput): Promise<DraftResult> {
  assertValidInstructions(input.userInstructions);

  const parent = await getDraft(deps.db, principal, parentDraftId); // authorizes; 404 for foreign/missing/malformed
  await assertBelowActiveRowCap(deps.db, principal, "drafts");
  if (!isDraftableDocumentType(parent.documentType)) {
    throw new AppError("VALIDATION_FAILED", `Draft ${parent.id} has no recognized draft template.`);
  }
  const documentType = parent.documentType;
  const template = getDraftTemplate(documentType);

  let groundingDocument: Document | undefined;
  if (parent.mode === "document_grounded" && parent.groundingDocumentId !== null) {
    // Re-verified: the grounding document may have changed owner (claim) or been lost (SET NULL)
    // since the parent was created. If it's inaccessible or not ready, the revision proceeds
    // without fresh grounding context.
    try {
      const candidate = await getDocument(deps.db, principal, parent.groundingDocumentId);
      if (candidate.processingStatus === "ready" && candidate.canonicalText !== null && candidate.canonicalTextHash !== null) {
        groundingDocument = candidate;
      }
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "NOT_FOUND") throw error;
    }
  }

  const schema = buildDraftResponseSchema(documentType);
  const systemPrompt = buildDraftSystemPrompt(documentType, parent.mode, groundingDocument !== undefined);
  const previousSections = template.sections
    .filter((section) => section.provenance === "ai_generated")
    .map((section) => ({
      key: section.key,
      content: parent.sections.find((row) => row.sectionKey === section.key)?.content ?? "",
    }));
  const userPrompt = buildDraftRevisionUserPrompt({
    documentType,
    // Inherited from the parent, never a hardcoded default — a draft's jurisdiction is a property
    // of the document being drafted, not of when a revision happened to run.
    jurisdiction: parent.jurisdiction,
    userInstructions: input.userInstructions,
    previousSections,
    groundingDocument: groundingDocument
      ? { canonicalText: groundingDocument.canonicalText!, canonicalTextHash: groundingDocument.canonicalTextHash! }
      : undefined,
  });
  assertWithinInputBudget(userPrompt);

  const { data, modelUsed } = await deps.llm.complete({ systemPrompt, userPrompt, schema, timeoutMs: LLM_TIMEOUT_MS.draft });

  const sections = buildSectionInputs(template, data.sections);
  const content = renderDraftContent(documentType, sections);

  const draft = await reviseDraft(deps.db, principal, parentDraftId, { sections, content, modelUsed, userInstructions: input.userInstructions });
  return toDraftResult(draft, {
    promptVersion: PROMPT_VERSION,
    groundingDocumentAvailable: parent.mode === "document_grounded" ? groundingDocument !== undefined : null,
  });
}

/** The draft as persisted, with a best-effort (not freshly re-verified) grounding-document read. */
export async function get(deps: DraftDeps, principal: Principal, draftId: string): Promise<DraftResult> {
  const draft = await getDraft(deps.db, principal, draftId);
  return toDraftResult(draft, {
    // Not persisted — an existing row's original prompt version is unrecoverable (see DraftResult's
    // own comment).
    promptVersion: null,
    // Best-effort: reflects only whether the row still references a grounding_document_id, not
    // whether that document is currently accessible/ready (see ToDraftResultOptions's comment).
    groundingDocumentAvailable: draft.mode === "document_grounded" ? draft.groundingDocumentId !== null : null,
  });
}
