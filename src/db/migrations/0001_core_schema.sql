-- Core schema: users, projects, documents with their analyses and findings, comparisons, threads and
-- messages, drafts. Hand-written; drizzle-kit is only used to check that src/db/schema.ts matches it.
--
-- Deliberately not here:
--   * document_embeddings and the pgvector extension: PGlite 0.5.8 does not bundle pgvector (it is the
--     separate @electric-sql/pglite-pgvector package). The table waits in migrations/pending/ so that
--     this file applies on every PGlite.
--   * Data API privilege revokes and the pg_cron/pg_net jobs: they need Supabase, see
--     migrations/prod-only/.
--
-- Foreign-key delete behaviour the data model leaves open, chosen here:
--   * every FK to users(id): RESTRICT. There is no account-deletion flow, and deleting a user must
--     never silently wipe their data.
--   * analyses.document_id and findings(analysis_id, document_id): CASCADE. Anything else would make
--     the guest-expiry delete of a document fail on the document's own analysis rows.
--
-- Guest-owned rows (documents, comparisons, drafts) must carry expires_at: a guest row without one is
-- never swept, and a non-expiring guest comparison would RESTRICT-block its documents forever. So a
-- guest→user claim must set the owner columns AND clear expires_at in ONE UPDATE; clearing expires_at
-- first, while the row is still guest-owned, is rejected.
--
-- document_type IN (...) lists DOCUMENT_TYPE_IDS from
-- src/server/deterministic/document-type-registry.ts in order, and a test fails if the two diverge.
-- Changing the registry needs a new migration that replaces both document_type CHECKs.

CREATE TYPE input_mode AS ENUM ('text', 'native_document');
CREATE TYPE processing_status AS ENUM ('pending', 'ready', 'extraction_failed');
CREATE TYPE verification_status AS ENUM ('verified', 'approximate', 'not_found');
CREATE TYPE finding_category AS ENUM ('obligation', 'deadline', 'penalty', 'ambiguity', 'missing_clause');
CREATE TYPE comparison_change_type AS ENUM ('added', 'removed', 'changed');
CREATE TYPE message_role AS ENUM ('user', 'assistant');
CREATE TYPE message_mode AS ENUM ('grounded', 'general');
CREATE TYPE draft_mode AS ENUM ('from_scratch', 'document_grounded');

-- users.id has no default: in prod it is the Supabase Auth user id, never minted here.
CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  display_name text,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL CONSTRAINT projects_owner_user_id_fkey REFERENCES users (id) ON DELETE RESTRICT,
  name text NOT NULL,
  color text,
  icon text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- input_mode is NULL while pending: whether a PDF has a text layer is only known after extraction.
-- documents_ready_extracted_check makes "ready" imply every extraction output is present.
CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid CONSTRAINT documents_owner_user_id_fkey REFERENCES users (id) ON DELETE RESTRICT,
  owner_guest_session_id text,
  project_id uuid CONSTRAINT documents_project_id_fkey REFERENCES projects (id) ON DELETE SET NULL,
  storage_ref text NOT NULL,
  filename text NOT NULL,
  mime_type text NOT NULL,
  input_mode input_mode,
  processing_status processing_status NOT NULL DEFAULT 'pending',
  canonical_text text,
  canonical_text_hash text,
  extractor_version text,
  document_type text,
  jurisdiction text NOT NULL DEFAULT 'IN',
  detection_confidence text,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  -- One stored object backs at most one document row. Without this, a re-confirm (or a case-variant
  -- of the same ref) could create a second row over the same bytes, and the guest-TTL sweep deleting
  -- an expired guest row would purge bytes a claimed user's row still points at.
  CONSTRAINT documents_storage_ref_key UNIQUE (storage_ref),
  CONSTRAINT documents_owner_exclusive_check CHECK (num_nonnulls(owner_user_id, owner_guest_session_id) = 1),
  -- canAccess treats a blank guest id as "no owner"; without this the DB would count it as one.
  CONSTRAINT documents_owner_guest_session_id_not_blank_check CHECK (owner_guest_session_id ~ '[^[:space:]]'),
  CONSTRAINT documents_guest_expires_check CHECK (owner_guest_session_id IS NULL OR expires_at IS NOT NULL),
  CONSTRAINT documents_ready_extracted_check CHECK (
    processing_status <> 'ready'
    OR (input_mode IS NOT NULL AND canonical_text IS NOT NULL AND canonical_text_hash IS NOT NULL AND extractor_version IS NOT NULL)
  ),
  CONSTRAINT documents_jurisdiction_iso_check CHECK (jurisdiction ~ '^[A-Z]{2}$'),
  CONSTRAINT documents_document_type_check CHECK (document_type IN (
    'leave_and_license', 'job_offer_letter', 'nda', 'privacy_policy', 'freelance_service_agreement',
    'grounded_response', 'generic'
  ))
);

CREATE TABLE analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL CONSTRAINT analyses_document_id_fkey REFERENCES documents (id) ON DELETE CASCADE,
  prompt_version text NOT NULL,
  model_used text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Idempotency guard: at most one analysis per (document, prompt version, model), so a retried or
  -- concurrent analysis cannot store a second set of findings.
  CONSTRAINT analyses_document_prompt_model_key UNIQUE (document_id, prompt_version, model_used),
  -- Target of findings_analysis_document_fkey (a composite FK needs a matching unique key).
  CONSTRAINT analyses_id_document_id_key UNIQUE (id, document_id)
);

-- verification_status/verifier_version/spans are audit fields: every read that shows a status runs
-- verification again against the live canonical text, so nothing trusts these stored values.
-- A quote-less finding (missing_clause) has no status at all rather than a fake one.
-- findings_analysis_document_fkey ties the finding to its analysis AND to that analysis's document:
-- the verified ceiling below checks findings.document_id, so that must be the document actually
-- analysed.
CREATE TABLE findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL CONSTRAINT findings_document_id_fkey REFERENCES documents (id) ON DELETE CASCADE,
  analysis_id uuid NOT NULL,
  category finding_category NOT NULL,
  quote_text text,
  quote_span_start integer,
  quote_span_end integer,
  verification_status verification_status,
  verifier_version text,
  model_used text NOT NULL,
  explanation text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT findings_analysis_document_fkey FOREIGN KEY (analysis_id, document_id)
    REFERENCES analyses (id, document_id) ON DELETE CASCADE,
  CONSTRAINT findings_status_iff_quote_check CHECK ((quote_text IS NULL) = (verification_status IS NULL)),
  CONSTRAINT findings_status_has_verifier_version_check CHECK (verification_status IS NULL OR verifier_version IS NOT NULL),
  CONSTRAINT findings_span_check CHECK (
    (quote_span_start IS NULL AND quote_span_end IS NULL)
    OR (quote_span_start IS NOT NULL AND quote_span_end IS NOT NULL AND quote_text IS NOT NULL
        AND quote_span_start >= 0 AND quote_span_end >= quote_span_start)
  ),
  CONSTRAINT findings_verified_has_span_check CHECK (verification_status IS DISTINCT FROM 'verified' OR quote_span_start IS NOT NULL)
);

CREATE TABLE finding_lens_explanations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id uuid NOT NULL CONSTRAINT finding_lens_explanations_finding_id_fkey REFERENCES findings (id) ON DELETE CASCADE,
  role_stage_lens text NOT NULL,
  explanation text NOT NULL,
  CONSTRAINT finding_lens_explanations_finding_lens_key UNIQUE (finding_id, role_stage_lens)
);

CREATE TABLE comparisons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid CONSTRAINT comparisons_owner_user_id_fkey REFERENCES users (id) ON DELETE RESTRICT,
  owner_guest_session_id text,
  project_id uuid CONSTRAINT comparisons_project_id_fkey REFERENCES projects (id) ON DELETE SET NULL,
  document_a_id uuid NOT NULL CONSTRAINT comparisons_document_a_id_fkey REFERENCES documents (id) ON DELETE RESTRICT,
  document_b_id uuid NOT NULL CONSTRAINT comparisons_document_b_id_fkey REFERENCES documents (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  CONSTRAINT comparisons_owner_exclusive_check CHECK (num_nonnulls(owner_user_id, owner_guest_session_id) = 1),
  CONSTRAINT comparisons_owner_guest_session_id_not_blank_check CHECK (owner_guest_session_id ~ '[^[:space:]]'),
  CONSTRAINT comparisons_guest_expires_check CHECK (owner_guest_session_id IS NULL OR expires_at IS NOT NULL)
);

-- Each side is verified independently against its own document; an added/removed change has no
-- quote, and so no status, on the missing side.
CREATE TABLE comparison_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comparison_id uuid NOT NULL CONSTRAINT comparison_changes_comparison_id_fkey REFERENCES comparisons (id) ON DELETE CASCADE,
  change_type comparison_change_type NOT NULL,
  quote_text_a text,
  quote_text_b text,
  doc_a_span_start integer,
  doc_a_span_end integer,
  doc_b_span_start integer,
  doc_b_span_end integer,
  verification_status_a verification_status,
  verification_status_b verification_status,
  verifier_version text,
  explanation text NOT NULL,
  CONSTRAINT comparison_changes_status_a_iff_quote_check CHECK ((quote_text_a IS NULL) = (verification_status_a IS NULL)),
  CONSTRAINT comparison_changes_status_b_iff_quote_check CHECK ((quote_text_b IS NULL) = (verification_status_b IS NULL)),
  CONSTRAINT comparison_changes_status_has_verifier_version_check CHECK (
    (verification_status_a IS NULL AND verification_status_b IS NULL) OR verifier_version IS NOT NULL
  ),
  CONSTRAINT comparison_changes_span_a_check CHECK (
    (doc_a_span_start IS NULL AND doc_a_span_end IS NULL)
    OR (doc_a_span_start IS NOT NULL AND doc_a_span_end IS NOT NULL AND quote_text_a IS NOT NULL
        AND doc_a_span_start >= 0 AND doc_a_span_end >= doc_a_span_start)
  ),
  CONSTRAINT comparison_changes_span_b_check CHECK (
    (doc_b_span_start IS NULL AND doc_b_span_end IS NULL)
    OR (doc_b_span_start IS NOT NULL AND doc_b_span_end IS NOT NULL AND quote_text_b IS NOT NULL
        AND doc_b_span_start >= 0 AND doc_b_span_end >= doc_b_span_start)
  ),
  CONSTRAINT comparison_changes_verified_a_has_span_check CHECK (verification_status_a IS DISTINCT FROM 'verified' OR doc_a_span_start IS NOT NULL),
  CONSTRAINT comparison_changes_verified_b_has_span_check CHECK (verification_status_b IS DISTINCT FROM 'verified' OR doc_b_span_start IS NOT NULL)
);

-- owner_user_id NOT NULL: a guest's threads live only on the client and are never stored as rows.
CREATE TABLE threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL CONSTRAINT threads_owner_user_id_fkey REFERENCES users (id) ON DELETE RESTRICT,
  project_id uuid CONSTRAINT threads_project_id_fkey REFERENCES projects (id) ON DELETE SET NULL,
  title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE thread_documents (
  thread_id uuid NOT NULL CONSTRAINT thread_documents_thread_id_fkey REFERENCES threads (id) ON DELETE CASCADE,
  document_id uuid NOT NULL CONSTRAINT thread_documents_document_id_fkey REFERENCES documents (id) ON DELETE CASCADE,
  attached_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT thread_documents_pkey PRIMARY KEY (thread_id, document_id)
);

-- messages.id has NO default, on purpose: the app must supply a UUIDv7 (src/db/ids.ts). A
-- gen_random_uuid() fallback would mint v4 ids and silently break the
-- ORDER BY created_at DESC, id DESC tie-break that keeps "latest N messages" deterministic when
-- timestamps are equal. messages_id_uuidv7_check rejects a v4 id outright. It tests the version
-- nibble rather than calling uuid_extract_version(), which is PG17+ only; Supabase may run an older
-- major than local PGlite (PG18).
CREATE TABLE messages (
  id uuid PRIMARY KEY,
  thread_id uuid NOT NULL CONSTRAINT messages_thread_id_fkey REFERENCES threads (id) ON DELETE CASCADE,
  role message_role NOT NULL,
  content text NOT NULL,
  mode message_mode,
  routed_domain_array text[],
  model_used text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_id_uuidv7_check CHECK (substr(id::text, 15, 1) = '7'),
  CONSTRAINT messages_mode_by_role_check CHECK ((role = 'user') = (mode IS NULL)),
  CONSTRAINT messages_assistant_model_used_check CHECK (role = 'user' OR model_used IS NOT NULL)
);

-- source_document_id is SET NULL, not RESTRICT: citations must never block a document's deletion or
-- expiry. The citation survives and re-verifies to not_found on the next read.
CREATE TABLE message_citations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL CONSTRAINT message_citations_message_id_fkey REFERENCES messages (id) ON DELETE CASCADE,
  quote_text text NOT NULL,
  quote_span_start integer,
  quote_span_end integer,
  source_document_id uuid CONSTRAINT message_citations_source_document_id_fkey REFERENCES documents (id) ON DELETE SET NULL,
  verification_status verification_status NOT NULL,
  verifier_version text NOT NULL,
  CONSTRAINT message_citations_span_check CHECK (
    (quote_span_start IS NULL AND quote_span_end IS NULL)
    OR (quote_span_start IS NOT NULL AND quote_span_end IS NOT NULL
        AND quote_span_start >= 0 AND quote_span_end >= quote_span_start)
  ),
  CONSTRAINT message_citations_verified_has_span_check CHECK (verification_status <> 'verified' OR quote_span_start IS NOT NULL)
);

CREATE TABLE drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid CONSTRAINT drafts_owner_user_id_fkey REFERENCES users (id) ON DELETE RESTRICT,
  owner_guest_session_id text,
  project_id uuid CONSTRAINT drafts_project_id_fkey REFERENCES projects (id) ON DELETE SET NULL,
  document_type text NOT NULL,
  mode draft_mode NOT NULL,
  grounding_document_id uuid CONSTRAINT drafts_grounding_document_id_fkey REFERENCES documents (id) ON DELETE SET NULL,
  content text NOT NULL,
  revision_number integer NOT NULL,
  parent_draft_id uuid CONSTRAINT drafts_parent_draft_id_fkey REFERENCES drafts (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  CONSTRAINT drafts_owner_exclusive_check CHECK (num_nonnulls(owner_user_id, owner_guest_session_id) = 1),
  CONSTRAINT drafts_owner_guest_session_id_not_blank_check CHECK (owner_guest_session_id ~ '[^[:space:]]'),
  CONSTRAINT drafts_guest_expires_check CHECK (owner_guest_session_id IS NULL OR expires_at IS NOT NULL),
  CONSTRAINT drafts_document_type_check CHECK (document_type IN (
    'leave_and_license', 'job_offer_letter', 'nda', 'privacy_policy', 'freelance_service_agreement',
    'grounded_response', 'generic'
  )),
  -- One-directional on purpose: a document_grounded draft legitimately loses its grounding document
  -- to the SET NULL rule above, so "grounded => NOT NULL" cannot be enforced.
  CONSTRAINT drafts_grounding_only_when_grounded_check CHECK (mode = 'document_grounded' OR grounding_document_id IS NULL)
);

-- provenance stays open-ended text: user_edited is expected once hand-editing ships. It records where
-- a section's text came from, never whether it was checked: drafts are never verified against a
-- source, so any value naming verification ('verified', 'unverified', ...) is rejected.
CREATE TABLE draft_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id uuid NOT NULL CONSTRAINT draft_sections_draft_id_fkey REFERENCES drafts (id) ON DELETE CASCADE,
  section_key text NOT NULL,
  provenance text NOT NULL,
  content text NOT NULL,
  CONSTRAINT draft_sections_provenance_not_verification_check CHECK (provenance !~* 'verif')
);

-- ---------------------------------------------------------------------------------------------
-- Native-document verified ceiling: a row whose source is a scanned/native document (its canonical
-- text is a model transcription, not independent evidence) can never be stored as verified. verify()
-- enforces the same cap itself; this is the persistence-time backstop. Fail-closed: 'verified' is
-- accepted only when the source document exists, is processing_status = 'ready' AND
-- input_mode = 'text'. A pending or extraction_failed document has no canonical_text to have verified
-- against, so it cannot carry a verified row either.
--
-- The document a verified row is checked against must not move afterwards: documents.input_mode is
-- immutable once set, a finding's document is pinned to its analysis's (findings_analysis_document_fkey),
-- and a comparison's document pair is immutable (comparisons_document_pair_immutable).
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION findings_verified_ceiling() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.verification_status = 'verified' AND NOT EXISTS (
       SELECT 1 FROM documents WHERE id = NEW.document_id AND input_mode = 'text' AND processing_status = 'ready'
     ) THEN
    RAISE EXCEPTION 'finding cannot be verified: document % is not a ready text-mode document', NEW.document_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'findings_native_document_verified_ceiling';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER findings_native_document_verified_ceiling
  BEFORE INSERT OR UPDATE ON findings
  FOR EACH ROW EXECUTE FUNCTION findings_verified_ceiling();

CREATE FUNCTION comparison_changes_verified_ceiling() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  a_ok boolean;
  b_ok boolean;
BEGIN
  IF NEW.verification_status_a = 'verified' OR NEW.verification_status_b = 'verified' THEN
    SELECT da.input_mode = 'text' AND da.processing_status = 'ready',
           db.input_mode = 'text' AND db.processing_status = 'ready'
      INTO a_ok, b_ok
      FROM comparisons c
      JOIN documents da ON da.id = c.document_a_id
      JOIN documents db ON db.id = c.document_b_id
     WHERE c.id = NEW.comparison_id;
    IF NEW.verification_status_a = 'verified' AND a_ok IS NOT TRUE THEN
      RAISE EXCEPTION 'comparison change side A cannot be verified: document A of comparison % is not a ready text-mode document', NEW.comparison_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'comparison_changes_native_document_verified_ceiling';
    END IF;
    IF NEW.verification_status_b = 'verified' AND b_ok IS NOT TRUE THEN
      RAISE EXCEPTION 'comparison change side B cannot be verified: document B of comparison % is not a ready text-mode document', NEW.comparison_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'comparison_changes_native_document_verified_ceiling';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER comparison_changes_native_document_verified_ceiling
  BEFORE INSERT OR UPDATE ON comparison_changes
  FOR EACH ROW EXECUTE FUNCTION comparison_changes_verified_ceiling();

-- The ON DELETE SET NULL of source_document_id reaches this trigger as an UPDATE. Rejecting it would
-- block the document's own deletion, which citations must never do, so a row that was ALREADY
-- verified may lose its document; only a row that is newly becoming verified must name a text-mode
-- document.
CREATE FUNCTION message_citations_verified_ceiling() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.verification_status <> 'verified' THEN
    RETURN NEW;
  END IF;
  IF NEW.source_document_id IS NULL THEN
    IF TG_OP = 'UPDATE' AND OLD.verification_status = 'verified' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'citation cannot be verified without a source document'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'message_citations_native_document_verified_ceiling';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM documents WHERE id = NEW.source_document_id AND input_mode = 'text' AND processing_status = 'ready'
     ) THEN
    RAISE EXCEPTION 'citation cannot be verified: document % is not a ready text-mode document', NEW.source_document_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'message_citations_native_document_verified_ceiling';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER message_citations_native_document_verified_ceiling
  BEFORE INSERT OR UPDATE ON message_citations
  FOR EACH ROW EXECUTE FUNCTION message_citations_verified_ceiling();

-- Once set, input_mode never changes. Without this, flipping a text document to native_document
-- after its verified findings were written would leave the ceiling above silently bypassed.
CREATE FUNCTION documents_input_mode_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.input_mode IS NOT NULL AND NEW.input_mode IS DISTINCT FROM OLD.input_mode THEN
    RAISE EXCEPTION 'documents.input_mode is immutable once set (document %)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'documents_input_mode_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER documents_input_mode_immutable
  BEFORE UPDATE OF input_mode ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_input_mode_immutable();

-- A comparison's document pair never changes. Without this, re-pointing document_a_id/document_b_id
-- at a native_document after verified comparison_changes exist would store 'verified' against a
-- native_document without the comparison_changes ceiling ever firing. Compare different documents by
-- creating a new comparison.
CREATE FUNCTION comparisons_document_pair_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.document_a_id IS DISTINCT FROM OLD.document_a_id OR NEW.document_b_id IS DISTINCT FROM OLD.document_b_id THEN
    RAISE EXCEPTION 'comparisons.document_a_id/document_b_id are immutable (comparison %)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'comparisons_document_pair_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER comparisons_document_pair_immutable
  BEFORE UPDATE OF document_a_id, document_b_id ON comparisons
  FOR EACH ROW EXECUTE FUNCTION comparisons_document_pair_immutable();

-- ---------------------------------------------------------------------------------------------
-- Indexes. No IF NOT EXISTS anywhere: a same-name index with different columns must fail loudly, not
-- silently no-op. Where the data model lists an index that a UNIQUE/PK constraint's index already
-- leads with, it is still created as listed.
-- ---------------------------------------------------------------------------------------------

CREATE INDEX projects_owner_user_id_idx ON projects (owner_user_id);

CREATE INDEX documents_owner_user_id_idx ON documents (owner_user_id);
CREATE INDEX documents_owner_guest_session_id_idx ON documents (owner_guest_session_id);
CREATE INDEX documents_project_id_idx ON documents (project_id);
CREATE INDEX documents_expires_at_idx ON documents (expires_at);
-- Case-variant aliases of one ref ("…/Lease.pdf" vs "…/lease.pdf") resolve to the same file on a
-- case-insensitive filesystem (local dev on macOS); documents_storage_ref_key alone cannot see that.
CREATE UNIQUE INDEX documents_storage_ref_lower_key ON documents (lower(storage_ref));

CREATE INDEX analyses_document_id_idx ON analyses (document_id);

CREATE INDEX findings_document_id_idx ON findings (document_id);
CREATE INDEX findings_analysis_id_idx ON findings (analysis_id);

CREATE INDEX finding_lens_explanations_finding_id_idx ON finding_lens_explanations (finding_id);

CREATE INDEX threads_owner_user_id_idx ON threads (owner_user_id);
CREATE INDEX threads_project_id_idx ON threads (project_id);

-- Exactly the ORDER BY of the recent-messages query: thread, newest first, id breaking ties.
CREATE INDEX messages_thread_id_created_at_id_idx ON messages (thread_id, created_at DESC, id DESC);

CREATE INDEX comparisons_owner_user_id_idx ON comparisons (owner_user_id);
CREATE INDEX comparisons_owner_guest_session_id_idx ON comparisons (owner_guest_session_id);
CREATE INDEX comparisons_project_id_idx ON comparisons (project_id);
CREATE INDEX comparisons_document_a_id_idx ON comparisons (document_a_id);
CREATE INDEX comparisons_document_b_id_idx ON comparisons (document_b_id);
CREATE INDEX comparisons_expires_at_idx ON comparisons (expires_at);

CREATE INDEX comparison_changes_comparison_id_idx ON comparison_changes (comparison_id);

CREATE INDEX drafts_owner_user_id_idx ON drafts (owner_user_id);
CREATE INDEX drafts_owner_guest_session_id_idx ON drafts (owner_guest_session_id);
CREATE INDEX drafts_project_id_idx ON drafts (project_id);
CREATE INDEX drafts_expires_at_idx ON drafts (expires_at);
CREATE INDEX drafts_grounding_document_id_idx ON drafts (grounding_document_id);
CREATE INDEX drafts_parent_draft_id_idx ON drafts (parent_draft_id);

CREATE INDEX draft_sections_draft_id_idx ON draft_sections (draft_id);

CREATE INDEX thread_documents_document_id_idx ON thread_documents (document_id);
CREATE INDEX thread_documents_thread_id_idx ON thread_documents (thread_id);

CREATE INDEX message_citations_source_document_id_idx ON message_citations (source_document_id);
CREATE INDEX message_citations_message_id_idx ON message_citations (message_id);
