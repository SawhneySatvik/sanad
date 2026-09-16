import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { DOCUMENT_CATEGORIES, INPUT_MODES, VERIFICATION_STATUSES } from "../server/core/types";
import { DOCUMENT_TYPE_IDS } from "../server/deterministic/document-type-registry";

/**
 * Typed mirror of the hand-written SQL in ./migrations — the SQL is the contract; this file is what
 * repositories import for typed queries. schema-drift.test.ts fails if the two diverge. Triggers live
 * only in the SQL. `document_embeddings` depends on @electric-sql/pglite-pgvector and has no mirror here.
 */

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// Built from the registry so this mirror can never disagree with it; the hand-written SQL spells the
// list out, and schema-kit-parity.test.ts / document-type.test.ts fail if the SQL drifts.
const documentTypeIn = sql.raw(`IN (${DOCUMENT_TYPE_IDS.map((id) => `'${id}'`).join(", ")})`);

/** Enum mirror of INPUT_MODES. */
export const inputMode = pgEnum("input_mode", INPUT_MODES);
/** A document's pipeline stage. */
export const processingStatus = pgEnum("processing_status", ["pending", "ready", "extraction_failed"]);
/** Enum mirror of VERIFICATION_STATUSES. */
export const verificationStatus = pgEnum("verification_status", VERIFICATION_STATUSES);
/** Enum mirror of DOCUMENT_CATEGORIES. */
export const findingCategory = pgEnum("finding_category", DOCUMENT_CATEGORIES);
/** Whether a comparison_changes row is an addition, removal, or changed clause. */
export const comparisonChangeType = pgEnum("comparison_change_type", ["added", "removed", "changed"]);
/** Who sent a message. */
export const messageRole = pgEnum("message_role", ["user", "assistant"]);
/** A message's mode: grounded in a document, or general legal chat. */
export const messageMode = pgEnum("message_mode", ["grounded", "general"]);
/** Whether a draft was written from scratch or grounded in an attached document. */
export const draftMode = pgEnum("draft_mode", ["from_scratch", "document_grounded"]);

/** Account rows. `id` has no default — in prod it is the Supabase Auth user id. */
export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  createdAt: createdAt(),
});

/** A user-owned folder that groups documents, comparisons, threads, and drafts. */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").notNull(),
    name: text("name").notNull(),
    color: text("color"),
    icon: text("icon"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "projects_owner_user_id_fkey", columns: [t.ownerUserId], foreignColumns: [users.id] }).onDelete(
      "restrict",
    ),
    index("projects_owner_user_id_idx").on(t.ownerUserId),
  ],
);

/** An uploaded file plus its extracted canonical text; owned by exactly one user or one guest session. */
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id"),
    ownerGuestSessionId: text("owner_guest_session_id"),
    projectId: uuid("project_id"),
    storageRef: text("storage_ref").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    // NULL while pending; required (with every extraction output) once processing_status = 'ready'.
    inputMode: inputMode("input_mode"),
    processingStatus: processingStatus("processing_status").notNull().default("pending"),
    canonicalText: text("canonical_text"),
    canonicalTextHash: text("canonical_text_hash"),
    extractorVersion: text("extractor_version"),
    documentType: text("document_type"),
    jurisdiction: text("jurisdiction").notNull().default("IN"),
    detectionConfidence: text("detection_confidence"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // NULL until renamed; resolves to filename at the service layer.
    title: text("title"),
    // Which bundled sample this document was opened from, if any. Validated against the registry in
    // the service, not a DB enum — the registry is fixed application code, not migration-owned data.
    sampleId: text("sample_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "documents_owner_user_id_fkey", columns: [t.ownerUserId], foreignColumns: [users.id] }).onDelete(
      "restrict",
    ),
    foreignKey({ name: "documents_project_id_fkey", columns: [t.projectId], foreignColumns: [projects.id] }).onDelete(
      "set null",
    ),
    unique("documents_storage_ref_key").on(t.storageRef),
    uniqueIndex("documents_storage_ref_lower_key").on(sql`lower(${t.storageRef})`),
    check("documents_owner_exclusive_check", sql`num_nonnulls(owner_user_id, owner_guest_session_id) = 1`),
    check("documents_owner_guest_session_id_not_blank_check", sql`owner_guest_session_id ~ '[^[:space:]]'`),
    check("documents_guest_expires_check", sql`owner_guest_session_id IS NULL OR expires_at IS NOT NULL`),
    check(
      "documents_ready_extracted_check",
      sql`processing_status <> 'ready' OR (input_mode IS NOT NULL AND canonical_text IS NOT NULL AND canonical_text_hash IS NOT NULL AND extractor_version IS NOT NULL)`,
    ),
    check("documents_jurisdiction_iso_check", sql`jurisdiction ~ '^[A-Z]{2}$'`),
    check("documents_document_type_check", sql`document_type ${documentTypeIn}`),
    index("documents_owner_user_id_idx").on(t.ownerUserId),
    index("documents_owner_guest_session_id_idx").on(t.ownerGuestSessionId),
    index("documents_project_id_idx").on(t.projectId),
    index("documents_expires_at_idx").on(t.expiresAt),
    // Keyset list pages: one owner's rows, newest-activity first.
    index("documents_owner_user_id_updated_at_id_idx").on(t.ownerUserId, t.updatedAt.desc().nullsFirst(), t.id.desc().nullsFirst()),
    index("documents_owner_guest_session_id_updated_at_id_idx").on(
      t.ownerGuestSessionId,
      t.updatedAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
  ],
);

/** One Understand run of a document by a given prompt version and model; findings hang off this. */
export const analyses = pgTable(
  "analyses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").notNull(),
    promptVersion: text("prompt_version").notNull(),
    modelUsed: text("model_used").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: "analyses_document_id_fkey", columns: [t.documentId], foreignColumns: [documents.id] }).onDelete(
      "cascade",
    ),
    unique("analyses_document_prompt_model_key").on(t.documentId, t.promptVersion, t.modelUsed),
    unique("analyses_id_document_id_key").on(t.id, t.documentId),
    index("analyses_document_id_idx").on(t.documentId),
  ],
);

/** A single flagged clause from an analysis, with its verification status and quote span, if any. */
export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").notNull(),
    analysisId: uuid("analysis_id").notNull(),
    category: findingCategory("category").notNull(),
    quoteText: text("quote_text"),
    quoteSpanStart: integer("quote_span_start"),
    quoteSpanEnd: integer("quote_span_end"),
    verificationStatus: verificationStatus("verification_status"),
    verifierVersion: text("verifier_version"),
    modelUsed: text("model_used").notNull(),
    explanation: text("explanation").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: "findings_document_id_fkey", columns: [t.documentId], foreignColumns: [documents.id] }).onDelete(
      "cascade",
    ),
    // Pins the finding to its analysis AND that analysis's document.
    foreignKey({
      name: "findings_analysis_document_fkey",
      columns: [t.analysisId, t.documentId],
      foreignColumns: [analyses.id, analyses.documentId],
    }).onDelete("cascade"),
    check("findings_status_iff_quote_check", sql`(quote_text IS NULL) = (verification_status IS NULL)`),
    check("findings_status_has_verifier_version_check", sql`verification_status IS NULL OR verifier_version IS NOT NULL`),
    check(
      "findings_span_check",
      sql`(quote_span_start IS NULL AND quote_span_end IS NULL) OR (quote_span_start IS NOT NULL AND quote_span_end IS NOT NULL AND quote_text IS NOT NULL AND quote_span_start >= 0 AND quote_span_end >= quote_span_start)`,
    ),
    check(
      "findings_verified_has_span_check",
      sql`verification_status IS DISTINCT FROM 'verified' OR quote_span_start IS NOT NULL`,
    ),
    index("findings_document_id_idx").on(t.documentId),
    index("findings_analysis_id_idx").on(t.analysisId),
  ],
);

/** A per-role/stage explanation of one finding: written with the analysis, one row per lens. */
export const findingLensExplanations = pgTable(
  "finding_lens_explanations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    findingId: uuid("finding_id").notNull(),
    roleStageLens: text("role_stage_lens").notNull(),
    explanation: text("explanation").notNull(),
  },
  (t) => [
    foreignKey({
      name: "finding_lens_explanations_finding_id_fkey",
      columns: [t.findingId],
      foreignColumns: [findings.id],
    }).onDelete("cascade"),
    unique("finding_lens_explanations_finding_lens_key").on(t.findingId, t.roleStageLens),
    index("finding_lens_explanations_finding_id_idx").on(t.findingId),
  ],
);

/** A side-by-side comparison of two documents; owned by exactly one user or one guest session. */
export const comparisons = pgTable(
  "comparisons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id"),
    ownerGuestSessionId: text("owner_guest_session_id"),
    projectId: uuid("project_id"),
    documentAId: uuid("document_a_id").notNull(),
    documentBId: uuid("document_b_id").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // Which model produced the comparison ("none" when no model call was needed), so a fallback result
    // never looks like a primary one.
    modelUsed: text("model_used").notNull(),
    // NULL until renamed; resolves to "<title A> vs <title B>" at the service layer.
    title: text("title"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "comparisons_owner_user_id_fkey", columns: [t.ownerUserId], foreignColumns: [users.id] }).onDelete(
      "restrict",
    ),
    foreignKey({ name: "comparisons_project_id_fkey", columns: [t.projectId], foreignColumns: [projects.id] }).onDelete(
      "set null",
    ),
    foreignKey({
      name: "comparisons_document_a_id_fkey",
      columns: [t.documentAId],
      foreignColumns: [documents.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "comparisons_document_b_id_fkey",
      columns: [t.documentBId],
      foreignColumns: [documents.id],
    }).onDelete("restrict"),
    check("comparisons_owner_exclusive_check", sql`num_nonnulls(owner_user_id, owner_guest_session_id) = 1`),
    check("comparisons_owner_guest_session_id_not_blank_check", sql`owner_guest_session_id ~ '[^[:space:]]'`),
    check("comparisons_guest_expires_check", sql`owner_guest_session_id IS NULL OR expires_at IS NOT NULL`),
    check("comparisons_model_used_not_blank_check", sql`model_used ~ '[^[:space:]]'`),
    index("comparisons_owner_user_id_idx").on(t.ownerUserId),
    index("comparisons_owner_guest_session_id_idx").on(t.ownerGuestSessionId),
    index("comparisons_project_id_idx").on(t.projectId),
    index("comparisons_document_a_id_idx").on(t.documentAId),
    index("comparisons_document_b_id_idx").on(t.documentBId),
    index("comparisons_expires_at_idx").on(t.expiresAt),
    index("comparisons_owner_user_id_updated_at_id_idx").on(t.ownerUserId, t.updatedAt.desc().nullsFirst(), t.id.desc().nullsFirst()),
    index("comparisons_owner_guest_session_id_updated_at_id_idx").on(
      t.ownerGuestSessionId,
      t.updatedAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
  ],
);

/** One changed, added, or removed clause between the two documents of a comparison. */
export const comparisonChanges = pgTable(
  "comparison_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    comparisonId: uuid("comparison_id").notNull(),
    changeType: comparisonChangeType("change_type").notNull(),
    quoteTextA: text("quote_text_a"),
    quoteTextB: text("quote_text_b"),
    docASpanStart: integer("doc_a_span_start"),
    docASpanEnd: integer("doc_a_span_end"),
    docBSpanStart: integer("doc_b_span_start"),
    docBSpanEnd: integer("doc_b_span_end"),
    verificationStatusA: verificationStatus("verification_status_a"),
    verificationStatusB: verificationStatus("verification_status_b"),
    verifierVersion: text("verifier_version"),
    explanation: text("explanation").notNull(),
  },
  (t) => [
    foreignKey({
      name: "comparison_changes_comparison_id_fkey",
      columns: [t.comparisonId],
      foreignColumns: [comparisons.id],
    }).onDelete("cascade"),
    check("comparison_changes_status_a_iff_quote_check", sql`(quote_text_a IS NULL) = (verification_status_a IS NULL)`),
    check("comparison_changes_status_b_iff_quote_check", sql`(quote_text_b IS NULL) = (verification_status_b IS NULL)`),
    check(
      "comparison_changes_status_has_verifier_version_check",
      sql`(verification_status_a IS NULL AND verification_status_b IS NULL) OR verifier_version IS NOT NULL`,
    ),
    check(
      "comparison_changes_span_a_check",
      sql`(doc_a_span_start IS NULL AND doc_a_span_end IS NULL) OR (doc_a_span_start IS NOT NULL AND doc_a_span_end IS NOT NULL AND quote_text_a IS NOT NULL AND doc_a_span_start >= 0 AND doc_a_span_end >= doc_a_span_start)`,
    ),
    check(
      "comparison_changes_span_b_check",
      sql`(doc_b_span_start IS NULL AND doc_b_span_end IS NULL) OR (doc_b_span_start IS NOT NULL AND doc_b_span_end IS NOT NULL AND quote_text_b IS NOT NULL AND doc_b_span_start >= 0 AND doc_b_span_end >= doc_b_span_start)`,
    ),
    check(
      "comparison_changes_verified_a_has_span_check",
      sql`verification_status_a IS DISTINCT FROM 'verified' OR doc_a_span_start IS NOT NULL`,
    ),
    check(
      "comparison_changes_verified_b_has_span_check",
      sql`verification_status_b IS DISTINCT FROM 'verified' OR doc_b_span_start IS NOT NULL`,
    ),
    index("comparison_changes_comparison_id_idx").on(t.comparisonId),
  ],
);

/** A chat thread; always user-owned (guests can chat but their threads are not persisted). */
export const threads = pgTable(
  "threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").notNull(),
    projectId: uuid("project_id"),
    title: text("title"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "threads_owner_user_id_fkey", columns: [t.ownerUserId], foreignColumns: [users.id] }).onDelete(
      "restrict",
    ),
    foreignKey({ name: "threads_project_id_fkey", columns: [t.projectId], foreignColumns: [projects.id] }).onDelete(
      "set null",
    ),
    index("threads_owner_user_id_idx").on(t.ownerUserId),
    index("threads_project_id_idx").on(t.projectId),
  ],
);

/** Join table: which documents are attached to which thread. */
export const threadDocuments = pgTable(
  "thread_documents",
  {
    threadId: uuid("thread_id").notNull(),
    documentId: uuid("document_id").notNull(),
    attachedAt: timestamp("attached_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "thread_documents_pkey", columns: [t.threadId, t.documentId] }),
    foreignKey({ name: "thread_documents_thread_id_fkey", columns: [t.threadId], foreignColumns: [threads.id] }).onDelete(
      "cascade",
    ),
    foreignKey({
      name: "thread_documents_document_id_fkey",
      columns: [t.documentId],
      foreignColumns: [documents.id],
    }).onDelete("cascade"),
    index("thread_documents_document_id_idx").on(t.documentId),
    index("thread_documents_thread_id_idx").on(t.threadId),
  ],
);

/** One chat message. `id` has no default — supply newId() from ./ids; the database rejects a missing or non-v7 id. */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey(),
    threadId: uuid("thread_id").notNull(),
    role: messageRole("role").notNull(),
    content: text("content").notNull(),
    mode: messageMode("mode"),
    routedDomainArray: text("routed_domain_array").array(),
    modelUsed: text("model_used"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: "messages_thread_id_fkey", columns: [t.threadId], foreignColumns: [threads.id] }).onDelete(
      "cascade",
    ),
    check("messages_id_uuidv7_check", sql`substr(id::text, 15, 1) = '7'`),
    check("messages_mode_by_role_check", sql`(role = 'user') = (mode IS NULL)`),
    check("messages_assistant_model_used_check", sql`role = 'user' OR model_used IS NOT NULL`),
    // nullsFirst() because drizzle's bare .desc() emits DESC NULLS LAST, which would no longer match the
    // SQL's plain DESC (= NULLS FIRST) that the listRecentMessages ORDER BY uses.
    index("messages_thread_id_created_at_id_idx").on(t.threadId, t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst()),
  ],
);

/** One verified-or-not quote an assistant message cites from a source document. */
export const messageCitations = pgTable(
  "message_citations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    messageId: uuid("message_id").notNull(),
    quoteText: text("quote_text").notNull(),
    quoteSpanStart: integer("quote_span_start"),
    quoteSpanEnd: integer("quote_span_end"),
    sourceDocumentId: uuid("source_document_id"),
    verificationStatus: verificationStatus("verification_status").notNull(),
    verifierVersion: text("verifier_version").notNull(),
  },
  (t) => [
    foreignKey({
      name: "message_citations_message_id_fkey",
      columns: [t.messageId],
      foreignColumns: [messages.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "message_citations_source_document_id_fkey",
      columns: [t.sourceDocumentId],
      foreignColumns: [documents.id],
    }).onDelete("set null"),
    check(
      "message_citations_span_check",
      sql`(quote_span_start IS NULL AND quote_span_end IS NULL) OR (quote_span_start IS NOT NULL AND quote_span_end IS NOT NULL AND quote_span_start >= 0 AND quote_span_end >= quote_span_start)`,
    ),
    check(
      "message_citations_verified_has_span_check",
      sql`verification_status <> 'verified' OR quote_span_start IS NOT NULL`,
    ),
    index("message_citations_source_document_id_idx").on(t.sourceDocumentId),
    index("message_citations_message_id_idx").on(t.messageId),
  ],
);

/** One revision of a drafted document; owned by exactly one user or one guest session. */
export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id"),
    ownerGuestSessionId: text("owner_guest_session_id"),
    projectId: uuid("project_id"),
    documentType: text("document_type").notNull(),
    mode: draftMode("mode").notNull(),
    groundingDocumentId: uuid("grounding_document_id"),
    content: text("content").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    parentDraftId: uuid("parent_draft_id"),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // Which model produced the draft, so a fallback result never looks like a primary one.
    modelUsed: text("model_used").notNull(),
    // Mirrors documents.jurisdiction.
    jurisdiction: text("jurisdiction").notNull().default("IN"),
    // NULL until renamed; resolves to "<type label> draft" at the service layer. Stored on every row
    // in a chain, not derived from the root, so a rename mid-chain is visible everywhere it should be.
    title: text("title"),
    // What was actually asked for (create or revise). NULL on rows written before this column existed.
    userInstructions: text("user_instructions"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ name: "drafts_owner_user_id_fkey", columns: [t.ownerUserId], foreignColumns: [users.id] }).onDelete(
      "restrict",
    ),
    foreignKey({ name: "drafts_project_id_fkey", columns: [t.projectId], foreignColumns: [projects.id] }).onDelete(
      "set null",
    ),
    foreignKey({
      name: "drafts_grounding_document_id_fkey",
      columns: [t.groundingDocumentId],
      foreignColumns: [documents.id],
    }).onDelete("set null"),
    foreignKey({ name: "drafts_parent_draft_id_fkey", columns: [t.parentDraftId], foreignColumns: [t.id] }).onDelete(
      "restrict",
    ),
    check("drafts_owner_exclusive_check", sql`num_nonnulls(owner_user_id, owner_guest_session_id) = 1`),
    check("drafts_owner_guest_session_id_not_blank_check", sql`owner_guest_session_id ~ '[^[:space:]]'`),
    check("drafts_guest_expires_check", sql`owner_guest_session_id IS NULL OR expires_at IS NOT NULL`),
    check("drafts_model_used_not_blank_check", sql`model_used ~ '[^[:space:]]'`),
    check("drafts_jurisdiction_iso_check", sql`jurisdiction ~ '^[A-Z]{2}$'`),
    check("drafts_document_type_check", sql`document_type ${documentTypeIn}`),
    check(
      "drafts_grounding_only_when_grounded_check",
      sql`mode = 'document_grounded' OR grounding_document_id IS NULL`,
    ),
    index("drafts_owner_user_id_idx").on(t.ownerUserId),
    index("drafts_owner_guest_session_id_idx").on(t.ownerGuestSessionId),
    index("drafts_project_id_idx").on(t.projectId),
    index("drafts_expires_at_idx").on(t.expiresAt),
    index("drafts_grounding_document_id_idx").on(t.groundingDocumentId),
    index("drafts_parent_draft_id_idx").on(t.parentDraftId),
    index("drafts_owner_user_id_updated_at_id_idx").on(t.ownerUserId, t.updatedAt.desc().nullsFirst(), t.id.desc().nullsFirst()),
    index("drafts_owner_guest_session_id_updated_at_id_idx").on(
      t.ownerGuestSessionId,
      t.updatedAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
  ],
);

/** One named section of a draft's content, with its provenance (e.g. template vs. model-generated). */
export const draftSections = pgTable(
  "draft_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    draftId: uuid("draft_id").notNull(),
    sectionKey: text("section_key").notNull(),
    // Open-ended on purpose, but a CHECK rejects any value naming verification — a draft section is
    // never labeled "verified": that status only ever comes from verify().
    provenance: text("provenance").notNull(),
    content: text("content").notNull(),
  },
  (t) => [
    foreignKey({ name: "draft_sections_draft_id_fkey", columns: [t.draftId], foreignColumns: [drafts.id] }).onDelete(
      "cascade",
    ),
    check("draft_sections_provenance_not_verification_check", sql`provenance !~* 'verif'`),
    index("draft_sections_draft_id_idx").on(t.draftId),
  ],
);

// Rate-limit and cache tables below: every increment is INSERT ... ON CONFLICT DO UPDATE ...
// RETURNING, never read-then-write, so concurrent requests can never race into a double count.

/** Per-principal request counter for a fixed time window; the atomic-increment target for the per-principal rate limit. */
export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    principalKey: text("principal_key").notNull(),
    windowKey: text("window_key").notNull(),
    requestCount: integer("request_count").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "rate_limit_buckets_pkey", columns: [t.principalKey, t.windowKey] })],
);

/** Per-IP request counter for a fixed time window, used to rate-limit requests with no principal yet. */
export const ipRateLimitBuckets = pgTable(
  "ip_rate_limit_buckets",
  {
    ipKey: text("ip_key").notNull(),
    windowKey: text("window_key").notNull(),
    requestCount: integer("request_count").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "ip_rate_limit_buckets_pkey", columns: [t.ipKey, t.windowKey] })],
);

/** Shared request counter for a fixed time window, capping total LLM calls across every principal. */
export const globalLlmRateLimit = pgTable(
  "global_llm_rate_limit",
  {
    providerKey: text("provider_key").notNull(),
    windowKey: text("window_key").notNull(),
    requestCount: integer("request_count").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "global_llm_rate_limit_pkey", columns: [t.providerKey, t.windowKey] })],
);

/** Cached raw model output, keyed by input hash. Never a status column — a persisted status only ever comes from verify(). */
export const analyzedResultCache = pgTable(
  "analyzed_result_cache",
  {
    cacheKey: text("cache_key").primaryKey(),
    rawModelOutput: text("raw_model_output").notNull(),
    modelUsed: text("model_used").notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("analyzed_result_cache_expires_at_idx").on(t.expiresAt)],
);
