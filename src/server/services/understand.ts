/**
 * Understand service — document analysis end to end. Route handlers call analyze() (upload →
 * analysis), analyzeDocument() (retry an existing document) or get(), nothing else.
 *
 * The model's response schema carries no status/span field, only quote text; every persisted status
 * comes from verify() against canonical_text. get() re-verifies every quote on each read, so a
 * stored, cached or model-claimed status is never itself returned; native_document text is capped
 * at approximate, and no transaction spans the LLM call. get() also adds the standard-clause
 * checklist's gaps: quote-less missing_clause findings that never carry a verification.
 */

import { createHash } from "node:crypto";
import { setImmediate as nextTurnOfEventLoop } from "node:timers/promises";
import type { Db } from "../../db/client";
import type { KeyValueCache } from "../cache/types";
import { AppError, notFound, type AppErrorCode } from "../core/errors";
import type { DocumentCategory, InputMode, Principal } from "../core/types";
import { detectDocumentType } from "../deterministic/detect-type";
import { DOCUMENT_TYPE_IDS, type DocumentTypeId } from "../deterministic/document-type-registry";
import { ExtractionAbortedError, extractDocument } from "../deterministic/extract";
import { findMissingStandardClauses, withoutModelCoveredGaps } from "../deterministic/standard-clauses";
import { MAX_QUOTES_PER_CALL, verifyMany, type VerifyResult } from "../deterministic/verify";
import { LLM_TIMEOUT_MS, MODEL_INPUT_BUDGET_CHARS } from "../llm/timeouts";
import type { LlmClient } from "../llm/types";
import {
  buildUnderstandResponseSchema,
  buildUnderstandSystemPrompt,
  buildUnderstandUserPrompt,
  MAX_FINDINGS,
  PROMPT_VERSION,
  THINKING_BUDGET,
  type UnderstandModelOutput,
} from "../prompts/understand/analyze";
import { LENSES_BY_DOCUMENT_TYPE } from "../prompts/understand/lenses";
import {
  TRANSCRIBE_PROMPT_VERSION,
  TRANSCRIBE_SYSTEM_PROMPT,
  TRANSCRIBE_USER_PROMPT,
  transcriptionResponseSchema,
} from "../prompts/understand/transcribe";
import type { StorageAdapter } from "../storage/types";
import {
  analysisCacheKey,
  ANALYSIS_CACHE_TTL_SECONDS,
  findLatestAnalysis,
  getCachedAnalysisOutput,
  insertAnalysisIfAbsent,
  lockDocumentForAnalysisPersistence,
  putCachedAnalysisOutput,
  type Analysis,
} from "../data/analyses";
import {
  assertBelowActiveRowCap,
  createPendingDocument,
  getDocument,
  markDocumentExtractionFailed,
  markDocumentReady,
  type Document,
} from "../data/documents";
import { insertLensExplanations, listLensExplanations } from "../data/finding-lens-explanations";
import { insertFindings, listFindings } from "../data/findings";

/** Dependencies the exported functions in this module need. */
export interface UnderstandDeps {
  db: Db;
  storage: StorageAdapter;
  llm: LlmClient;
  /** Model id of the primary LLM client; keys the analysis cache. The container checks it with assertCacheModelId(). */
  modelId: string;
  /**
   * Charges one LLM call to the caller's rate-limit tiers without making one — ServiceDeps always
   * supplies it. Without it the shared analysis cache is never read: an uncharged hit would tell a
   * caller at their limit whether someone else has analyzed the same text. Optional so hand-built
   * deps that never read the cache need not supply it.
   */
  chargeLlmCall?: () => Promise<void>;
  /**
   * A read-through tier in front of the Postgres result cache, keyed identically — see
   * chargedCacheHit(). Absent: the Postgres cache is still read/written on its own, exactly as
   * before this existed.
   */
  cache?: KeyValueCache;
}

/**
 * Throws unless `deps.modelId` equals the primary client's model id. Cache reads use deps.modelId and writes
 * use the model that answered, so a mismatch silently disables the cache. The container calls it when it
 * first builds the LLM providers.
 */
export function assertCacheModelId(deps: Pick<UnderstandDeps, "modelId">, primaryModelId: string): void {
  if (deps.modelId.trim() === "" || deps.modelId !== primaryModelId) {
    throw new Error(
      `UnderstandDeps.modelId (${JSON.stringify(deps.modelId)}) must equal the primary LLM client's model id (${JSON.stringify(primaryModelId)}).`,
    );
  }
}

/**
 * Input to analyze(): an uploaded object's storage reference. The document's filename and type are
 * the ones declared when the upload target was created (confirmUpload returns them), never a
 * later request's.
 */
export interface AnalyzeInput {
  storageRef: string;
}

/** One finding: a model finding or a standard-clause checklist gap. */
export type UnderstandFinding = ModelFinding | ChecklistFinding;

/** A model-written finding, with its default-lens explanation and its freshly-computed verification. */
export interface ModelFinding {
  id: string;
  provenance: "ai_generated";
  category: DocumentCategory;
  quote: string | null;
  // The default (first) lens's explanation.
  explanation: string;
  lensExplanations: { lens: string; explanation: string }[];
  // verify() run by this very call against the document's current canonical_text; null for a
  // finding with no quote. Render canonical_text.slice(spanStart, spanEnd), never `quote`.
  verification: VerifyResult | null;
  modelUsed: string;
}

/**
 * A standard protection the deterministic checklist found no wording for, computed on every read
 * and never stored. An absence quotes nothing, so it can never carry a verification. Its one
 * explanation is reader-neutral, so there are no per-lens explanations.
 */
export interface ChecklistFinding {
  // Derived from the document and checklist item, so it is stable across reads.
  id: string;
  provenance: "checklist";
  category: "missing_clause";
  quote: null;
  explanation: string;
  lensExplanations: [];
  verification: null;
  // No model wrote it: the same "none" sentinel Compare uses for a comparison with no model call.
  modelUsed: "none";
}

/** get()'s and analyzeDocument()'s "complete" result: the document with its latest analysis. */
export interface AnalyzedDocument {
  document: Document;
  analysisState: "complete";
  analysis: Analysis;
  findings: UnderstandFinding[];
  // Set only by the analyzeDocument() call that persisted this analysis, never by get(): what was
  // trimmed from the model's response. Internal metadata for live-validation reports — the
  // documents contract does not carry it, so toWire strips it.
  findingsDropped?: FindingsDropped;
}

/**
 * Findings dropped from one model response, per category: exact repeats, then everything past
 * MAX_FINDINGS. The cap cuts from the end, where missing_clause findings usually sit.
 */
export interface FindingsDropped {
  duplicate: Partial<Record<DocumentCategory, number>>;
  overCap: Partial<Record<DocumentCategory, number>>;
}

/**
 * Every document with no analysis yet: extraction pending or failed (document.processingStatus says
 * which), or extracted but the analysis call failed or never ran. findings is null, never [], so
 * "not analysed" can never be read as "analysed, nothing found".
 */
export interface UnanalyzedDocument {
  document: Document;
  analysisState: "not_analyzed";
  analysis: null;
  findings: null;
}

/** get()'s return type: an analyzed document or one with no analysis yet. */
export type UnderstandResult = AnalyzedDocument | UnanalyzedDocument;

/**
 * analyze() failed after the caller's document row was created. The ref is spent (confirmUpload is
 * one-shot), so this id is the only way the client can retry, via analyzeDocument(). Same code — so
 * the same HTTP status and safe message — and retry-after as the underlying error. The id is the
 * caller's own document, so it reveals nothing.
 */
export class DocumentAnalysisError extends AppError {
  readonly documentId: string;

  constructor(documentId: string, cause: AppError) {
    super(cause.code, cause.message, { reason: cause.reason, retryAfterSeconds: cause.retryAfterSeconds });
    this.documentId = documentId;
    this.cause = cause;
  }
}

/**
 * Upload confirmation → pending row → analyzeDocument() (extraction, then analysis). Every call
 * creates a new document: confirmUpload is one-shot and storage_ref is unique, so a repeated ref
 * is NOT_FOUND. A document that failed part-way is retried with analyzeDocument(), using the
 * documentId a DocumentAnalysisError carries.
 *
 * @example
 * const { document, findings } = await analyze(deps, principal, { storageRef });
 */
export async function analyze(deps: UnderstandDeps, principal: Principal, input: AnalyzeInput): Promise<AnalyzedDocument> {
  // Before the one-shot confirm: a cap rejection after it would spend the ref and orphan the object.
  await assertBelowActiveRowCap(deps.db, principal, "documents");
  const upload = await deps.storage.confirmUpload(principal, input.storageRef);
  const pending = await createPendingDocument(deps.db, principal, { storageRef: input.storageRef, ...upload });
  try {
    return await analyzeDocument(deps, principal, pending.id);
  } catch (error) {
    if (error instanceof AppError) throw new DocumentAnalysisError(pending.id, error);
    throw error;
  }
}

// Unavailable or rate-limited services, not the document: a retry can succeed.
const TRANSIENT_CODES: ReadonlySet<AppErrorCode> = new Set(["RATE_LIMITED", "UPSTREAM_UNAVAILABLE", "TIMEOUT"]);

// Not the document's doing, so a retry can succeed: an unavailable or rate-limited dependency, or a
// parse worker that never reported ready (it could not start, or the runtime can't watch its
// memory) — a deploy or runtime problem. Anything that ends a parse after ready is terminal.
function isRetryable(error: unknown): boolean {
  if (error instanceof ExtractionAbortedError) return error.abortReason === "worker_crash";
  return error instanceof AppError && TRANSIENT_CODES.has(error.code);
}

// canonical_text comes from the stored bytes or, for a scan with no text layer, the model's
// transcription (native_document). A failure caused by the document itself — including the parse
// sandbox stopping it at its deadline, heap or memory budget — is permanent (extraction_failed), so
// a retry never re-runs the same expensive parse. A retryable failure, and a provider failure while
// transcribing, leaves the document pending for a retry.
async function extract(deps: UnderstandDeps, principal: Principal, document: Document): Promise<Document> {
  const markFailed = async (error: unknown): Promise<never> => {
    if (!isRetryable(error)) await markDocumentExtractionFailed(deps.db, principal, document.id);
    throw error;
  };
  const bytes = await deps.storage.readObject(document.storageRef).catch(markFailed);
  const extracted = await extractDocument({ bytes, mimeType: document.mimeType }).catch(markFailed);
  const text =
    extracted.kind === "extracted"
      ? {
          inputMode: extracted.inputMode,
          canonicalText: extracted.canonicalText,
          canonicalTextHash: extracted.canonicalTextHash,
          extractorVersion: extracted.extractorVersion,
        }
      : await transcribe(deps.llm, bytes, document.mimeType, markFailed);
  const detection = detectDocumentType(text.canonicalText);
  const ready = await markDocumentReady(deps.db, principal, document.id, {
    ...text,
    documentType: detection.documentType,
    detectionConfidence: detection.confidence.toFixed(2),
    jurisdiction: "IN",
  });
  // null: a concurrent call finished extracting this document first; continue with its result.
  return ready ?? getDocument(deps.db, principal, document.id);
}

async function transcribe(
  llm: LlmClient,
  bytes: Uint8Array,
  mimeType: string,
  markFailed: (error: unknown) => Promise<never>,
) {
  // Checked at the call site, not assumed.
  if (!llm.capabilities.nativeDocumentInput) {
    return markFailed(
      new AppError("INVALID_DOCUMENT", "The document has no text layer and scanned documents cannot be read.", { reason: "unreadable" }),
    );
  }
  // Deliberately not markFailed: a provider failure leaves the document pending (see extract()).
  const result = await llm.complete({
    systemPrompt: TRANSCRIBE_SYSTEM_PROMPT,
    userPrompt: TRANSCRIBE_USER_PROMPT,
    schema: transcriptionResponseSchema,
    documents: [{ nativeFile: { bytes, mimeType } }],
    timeoutMs: LLM_TIMEOUT_MS.transcribe,
  });
  // The same normalization, size caps and hash as any other canonical_text.
  const extracted = await extractDocument({ pastedText: result.data.text }).catch(markFailed);
  if (extracted.kind !== "extracted") {
    return markFailed(new AppError("EXTRACTION_FAILED", "The transcription could not be read.", { reason: "unreadable" }));
  }
  return {
    inputMode: "native_document" as const,
    canonicalText: extracted.canonicalText,
    canonicalTextHash: extracted.canonicalTextHash,
    extractorVersion: `native-transcription/${TRANSCRIBE_PROMPT_VERSION}/${result.modelUsed}`,
  };
}

/**
 * The entry point for (re)running analysis on an existing document — what the analyze retry route
 * calls. Principal-checked and idempotent: resumes at whichever stage is incomplete — pending
 * resolves through extraction then analysis, ready-but-unanalyzed runs the analysis call,
 * already-analyzed returns the existing analysis with no model call. extraction_failed always
 * throws EXTRACTION_FAILED, since the document itself cannot be read. A concurrent run that loses
 * the analysis-uniqueness race persists nothing and returns the winner's analysis.
 *
 * Refuses a sample copy outright: a sample's analysis is fixed at the moment it was recorded, and
 * retrying it live would silently turn a "recorded" result into a real one still labelled recorded.
 * Checked immediately after the document loads — before extract() and before findLatestAnalysis's
 * own early return — so this can never be reached by finding an already-persisted analysis first.
 */
export async function analyzeDocument(
  deps: UnderstandDeps,
  principal: Principal,
  documentId: string,
): Promise<AnalyzedDocument> {
  const document = await getDocument(deps.db, principal, documentId);
  if (document.sampleId !== null) {
    throw new AppError(
      "INVALID_DOCUMENT",
      "This document is a recorded sample and cannot be re-analyzed.",
      { reason: "sample_readonly" },
    );
  }
  return runAnalysis(deps, principal, documentId, document, {});
}

/**
 * The samples flow's only entry point into this module (src/server/samples/open.ts calls it, never
 * analyzeDocument): runs the same extraction/analysis/persistence core, with the shared result cache
 * off in both directions (a sample's recorded output is per-sample fixed data, never something to
 * read from or write into the cache real documents share). Refuses unless `documentId` is already
 * tagged as this exact sample, so it can never become a general bypass of analyzeDocument()'s guard.
 */
export async function replayRecordedAnalysis(
  deps: UnderstandDeps,
  principal: Principal,
  documentId: string,
  sampleId: string,
): Promise<AnalyzedDocument> {
  const document = await getDocument(deps.db, principal, documentId);
  if (document.sampleId !== sampleId) throw notFound();
  return runAnalysis(deps, principal, documentId, document, { skipResultCache: true });
}

/** Whether the shared analyzed_result_cache is read from or written to by runAnalysis(). */
interface RunAnalysisOptions {
  skipResultCache?: boolean;
}

async function runAnalysis(
  deps: UnderstandDeps,
  principal: Principal,
  documentId: string,
  initialDocument: Document,
  options: RunAnalysisOptions,
): Promise<AnalyzedDocument> {
  let document = initialDocument;
  if (document.processingStatus === "pending") document = await extract(deps, principal, document);
  const { canonicalText, canonicalTextHash, inputMode } = document;
  if (document.processingStatus !== "ready" || canonicalText === null || canonicalTextHash === null || inputMode === null) {
    throw new AppError("EXTRACTION_FAILED", "The document's text could not be extracted.", { reason: "unreadable" });
  }
  if (await findLatestAnalysis(deps.db, principal, documentId, PROMPT_VERSION)) {
    return getAnalyzed(deps, principal, documentId);
  }

  const userPrompt = buildUnderstandUserPrompt({ canonicalText, canonicalTextHash });
  // Checked before the cache too, so whether a document can be analyzed never depends on whether
  // someone else's identical text was analyzed first. The document stays ready: its text is fine.
  if (userPrompt.length > MODEL_INPUT_BUDGET_CHARS.understand) {
    throw new AppError(
      "INVALID_DOCUMENT",
      `The document is too long to analyze: its prompt is ${userPrompt.length} characters, over the ${MODEL_INPUT_BUDGET_CHARS.understand}-character limit.`,
      { reason: "too_large" },
    );
  }
  const documentType = toDocumentTypeId(document.documentType);
  const schema = buildUnderstandResponseSchema(documentType);
  const cacheHit = options.skipResultCache ? null : await chargedCacheHit(deps, principal, document, schema);
  const { data: output, modelUsed } =
    cacheHit ??
    (await deps.llm.complete({
      systemPrompt: buildUnderstandSystemPrompt(documentType),
      userPrompt,
      schema,
      timeoutMs: LLM_TIMEOUT_MS.understand,
      thinkingBudget: THINKING_BUDGET,
    }));

  const { claims, dropped } = toClaims(output, documentType);
  const droppedCount = [...Object.values(dropped.duplicate), ...Object.values(dropped.overCap)].reduce((sum, n) => sum + n, 0);
  if (droppedCount > 0) {
    // Counts only, never finding text.
    console.warn(
      JSON.stringify({ event: "llm_output_trimmed", surface: "understand", documentId, modelUsed, received: output.findings.length, kept: claims.length, ...dropped }),
    );
  }
  const verifications = await verifyQuotes(
    claims.map((claim) => claim.quote),
    canonicalText,
    inputMode,
  );

  let persisted = false;
  await deps.db.transaction(async (tx) => {
    // Inside the transaction every repository call gets `tx`: PGlite holds one connection, so a
    // query on the outer handle here would wait for this transaction forever.
    await lockDocumentForAnalysisPersistence(tx, principal, documentId);
    const analysis = await insertAnalysisIfAbsent(tx, principal, {
      documentId,
      promptVersion: PROMPT_VERSION,
      modelUsed,
    });
    if (analysis === null) return;
    persisted = true;
    const findings = await insertFindings(tx, principal, {
      documentId,
      analysisId: analysis.id,
      modelUsed,
      findings: claims.map((claim, i) => ({
        category: claim.category,
        quote: claim.quote,
        explanation: claim.lensExplanations[0].explanation,
        verification: verifications[i],
      })),
    });
    await insertLensExplanations(
      tx,
      principal,
      documentId,
      findings.flatMap((finding, i) =>
        claims[i].lensExplanations.map((lens) => ({
          findingId: finding.id,
          roleStageLens: lens.lens,
          explanation: lens.explanation,
        })),
      ),
    );
    // A sample's recorded output is fixed per sample, never something to seed the cache real
    // documents share — skipResultCache takes this branch out entirely, not only the read above.
    if (cacheHit === null && !options.skipResultCache) {
      await putCachedAnalysisOutput(tx, principal, documentId, {
        promptVersion: PROMPT_VERSION,
        modelUsed,
        rawModelOutput: JSON.stringify(output),
      });
    }
  });

  // Redis is written after the transaction commits, never inside it: network I/O must never
  // extend the row lock lockDocumentForAnalysisPersistence takes, and a write that rolls back
  // (a concurrent caller won insertAnalysisIfAbsent's race, so `persisted` is false) must never
  // leave a Redis entry for output nothing actually persisted.
  if (persisted && cacheHit === null && !options.skipResultCache) {
    const redisKey = deps.cache ? analysisRedisKey(document, modelUsed) : null;
    if (redisKey !== null) {
      await deps.cache!.set(
        redisKey,
        JSON.stringify({ rawModelOutput: JSON.stringify(output), modelUsed }),
        ANALYSIS_CACHE_TTL_SECONDS,
      );
    }
  }

  const analyzed = await getAnalyzed(deps, principal, documentId);
  // A concurrent call that won the insert returns its own analysis; our counts would not describe it.
  return persisted ? { ...analyzed, findingsDropped: dropped } : analyzed;
}

// Same key analysisCacheKey (and so Postgres's analyzed_result_cache) uses for this document,
// prompt version and model id — a Redis hit and a Postgres hit must be interchangeable, or the two
// tiers would silently diverge on what "the same cached analysis" means. Null for a document with
// no extracted text/type yet: cacheKeyFor in analyses.ts would throw for the same reason.
function analysisRedisKey(document: Pick<Document, "canonicalTextHash" | "documentType" | "jurisdiction">, modelId: string): string | null {
  if (document.canonicalTextHash === null || document.documentType === null) return null;
  return (
    "analysis:" +
    analysisCacheKey({
      canonicalTextHash: document.canonicalTextHash,
      documentType: document.documentType,
      jurisdiction: document.jurisdiction,
      promptVersion: PROMPT_VERSION,
      modelId,
    })
  );
}

interface CachedAnalysisEntry {
  rawModelOutput: string;
  modelUsed: string;
}

// Never trusts a cached payload's shape — a hand-edited or malformed entry (including one carrying
// extra fields like a self-certified "status") is a miss here, same as a schema mismatch below;
// only rawModelOutput/modelUsed are ever read out of it.
function parseCachedAnalysisEntry(raw: string): CachedAnalysisEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { rawModelOutput, modelUsed } = parsed as Record<string, unknown>;
  if (typeof rawModelOutput !== "string" || typeof modelUsed !== "string") return null;
  return { rawModelOutput, modelUsed };
}

// The cache is shared across principals, so a hit is served only once charged like the model call
// it replaces: otherwise a caller at their limit would get 200 for text someone else has analyzed
// and 429 for text nobody has. A miss is charged by `llm` itself. null: a miss, or no way to charge.
// Redis is read first (deps.cache, keyed identically to Postgres) and Postgres second; a Postgres
// hit backfills Redis so the next identical lookup skips Postgres too.
async function chargedCacheHit(
  deps: UnderstandDeps,
  principal: Principal,
  document: Document,
  schema: ReturnType<typeof buildUnderstandResponseSchema>,
): Promise<{ data: UnderstandModelOutput; modelUsed: string } | null> {
  if (deps.chargeLlmCall === undefined) return null;
  const redisKey = deps.cache ? analysisRedisKey(document, deps.modelId) : null;

  if (redisKey !== null) {
    const raw = await deps.cache!.get(redisKey);
    const entry = raw === null ? null : parseCachedAnalysisEntry(raw);
    if (entry !== null) {
      const parsed = schema.safeParse(parseJson(entry.rawModelOutput));
      if (parsed.success) {
        await deps.chargeLlmCall();
        return { data: parsed.data, modelUsed: entry.modelUsed };
      }
    }
  }

  const cached = await getCachedAnalysisOutput(deps.db, principal, document.id, {
    promptVersion: PROMPT_VERSION,
    modelId: deps.modelId,
  });
  if (cached === null) return null;
  // A cached payload that doesn't match the schema is a miss, not an error.
  const parsed = schema.safeParse(parseJson(cached.rawModelOutput));
  if (!parsed.success) return null;
  await deps.chargeLlmCall();
  if (redisKey !== null) {
    const ttlSeconds = Math.max(1, Math.min(ANALYSIS_CACHE_TTL_SECONDS, Math.round((cached.expiresAt.getTime() - Date.now()) / 1000)));
    await deps.cache!.set(redisKey, JSON.stringify({ rawModelOutput: cached.rawModelOutput, modelUsed: cached.modelUsed }), ttlSeconds);
  }
  return { data: parsed.data, modelUsed: cached.modelUsed };
}

// get() for a document known to have an analysis. Analyses are deleted only with their document,
// which get() already reports as NOT_FOUND, so "not_analyzed" here cannot happen.
async function getAnalyzed(deps: UnderstandDeps, principal: Principal, documentId: string): Promise<AnalyzedDocument> {
  const result = await get(deps, principal, documentId);
  if (result.analysisState !== "complete") throw notFound();
  return result;
}

/**
 * The document with its latest analysis. Stored verification_status and spans are audit fields
 * only: every quote is verified again, here, against the current canonical_text, and only that
 * result is returned. The model's findings come first, then the standard-clause checklist's gaps.
 */
export async function get(deps: UnderstandDeps, principal: Principal, documentId: string): Promise<UnderstandResult> {
  const document = await getDocument(deps.db, principal, documentId);
  const analysis = await findLatestAnalysis(deps.db, principal, documentId);
  if (analysis === null) return { document, analysisState: "not_analyzed", analysis: null, findings: null };

  const rows = await listFindings(deps.db, principal, documentId, analysis.id);
  const lensRows = await listLensExplanations(deps.db, principal, documentId, analysis.id);
  // Findings only exist for ready documents; if that ever failed to hold, an empty text makes
  // every quote not_found rather than anything stronger.
  const verifications = await verifyQuotes(
    rows.map((row) => row.quoteText),
    document.canonicalText ?? "",
    document.inputMode ?? "native_document",
  );
  const modelFindings: ModelFinding[] = rows.map((row, i) => ({
    id: row.id,
    provenance: "ai_generated",
    category: row.category,
    quote: row.quoteText,
    explanation: row.explanation,
    lensExplanations: lensRows
      .filter((lens) => lens.findingId === row.id)
      .map((lens) => ({ lens: lens.roleStageLens, explanation: lens.explanation })),
    verification: verifications[i],
    modelUsed: row.modelUsed,
  }));
  // The checklist scans the whole text in one synchronous run too; its own turn keeps it from
  // extending the verify block.
  await nextTurnOfEventLoop();
  const gaps = checklistFindings(document, modelFindings);

  return {
    document,
    analysisState: "complete",
    analysis,
    findings: [...modelFindings, ...gaps],
  };
}

// Recomputed on every read rather than stored, so a checklist change can never leave a stale gap.
// Skipped for native_document: that text is a model transcription, and an absence claim would rest
// on the transcription being complete. A gap the model already reported as missing is not repeated.
function checklistFindings(document: Document, modelFindings: readonly ModelFinding[]): ChecklistFinding[] {
  if (document.inputMode !== "text" || document.canonicalText === null) return [];
  const gaps = findMissingStandardClauses(toDocumentTypeId(document.documentType), document.canonicalText);
  const modelGaps = modelFindings.filter((finding) => finding.category === "missing_clause");
  return withoutModelCoveredGaps(gaps, modelGaps.map((finding) => finding.explanation)).map((gap) => ({
    id: checklistFindingId(document.id, gap.id),
    provenance: "checklist",
    category: gap.category,
    quote: gap.quote,
    explanation: gap.explanation,
    lensExplanations: [],
    verification: gap.verification,
    modelUsed: "none",
  }));
}

// A deterministic UUID (version 8, RFC 9562 variant) from the document and checklist item, so
// Prepare can cite the gap by a stable id. Never collides with a stored finding's UUIDv7.
function checklistFindingId(documentId: string, gapId: string): string {
  const hex = createHash("sha256").update(`${documentId}:${gapId}`).digest("hex");
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

interface Claim {
  category: DocumentCategory;
  quote: string | null;
  lensExplanations: { lens: string; explanation: string }[];
}

// Model output → what gets verified and stored. A missing_clause cannot quote the document, so any
// quote it carries is dropped; a blank quote is no quote. An over-long response is trimmed here,
// never rejected: exact repeats are dropped first, so a repeating model doesn't use up MAX_FINDINGS.
function toClaims(output: UnderstandModelOutput, documentType: DocumentTypeId): { claims: Claim[]; dropped: FindingsDropped } {
  const lenses = LENSES_BY_DOCUMENT_TYPE[documentType];
  const dropped: FindingsDropped = { duplicate: {}, overCap: {} };
  const count = (tally: FindingsDropped["duplicate"], category: DocumentCategory) => {
    tally[category] = (tally[category] ?? 0) + 1;
  };
  const seen = new Set<string>();
  const findings = output.findings.filter((finding) => {
    const key = JSON.stringify([finding.category, finding.quote, lenses.map((lens) => finding.lensExplanations[lens.id])]);
    if (seen.has(key)) {
      count(dropped.duplicate, finding.category);
      return false;
    }
    seen.add(key);
    return true;
  });
  for (const finding of findings.slice(MAX_FINDINGS)) count(dropped.overCap, finding.category);
  const claims = findings.slice(0, MAX_FINDINGS).map((finding) => ({
    category: finding.category,
    quote:
      finding.category === "missing_clause" || finding.quote === null || finding.quote.trim() === ""
        ? null
        : finding.quote,
    lensExplanations: lenses.map((lens) => ({ lens: lens.id, explanation: finding.lensExplanations[lens.id] })),
  }));
  return { claims, dropped };
}

// verifyMany in chunks of at most MAX_QUOTES_PER_CALL (it throws above that), each in its own turn
// of the event loop: a call blocks for its whole chunk, and the reads before it give no turn
// (in-process PGlite settles in microtasks). Position i of the result is quote i's; findings.ts
// re-checks each result against its own quote, so a mismatch here fails the write instead of
// attaching a status to the wrong finding.
async function verifyQuotes(
  quotes: readonly (string | null)[],
  canonicalText: string,
  inputMode: InputMode,
): Promise<(VerifyResult | null)[]> {
  const quoted = quotes.filter((quote): quote is string => quote !== null);
  const results: VerifyResult[] = [];
  for (let start = 0; start < quoted.length; start += MAX_QUOTES_PER_CALL) {
    await nextTurnOfEventLoop();
    results.push(...verifyMany(quoted.slice(start, start + MAX_QUOTES_PER_CALL), canonicalText, inputMode));
  }
  let next = 0;
  return quotes.map((quote) => (quote === null ? null : results[next++]));
}

function toDocumentTypeId(value: string | null): DocumentTypeId {
  return DOCUMENT_TYPE_IDS.find((id) => id === value) ?? "generic";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
