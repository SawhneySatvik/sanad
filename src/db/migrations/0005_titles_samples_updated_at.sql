-- User-facing titles, the sample-document link, a draft's recorded instructions, and updated_at on
-- documents, comparisons and drafts. Hand-written; additive.
--
-- title is nullable everywhere: an untitled row resolves to a fallback (filename, "<A> vs <B>", a
-- type label) at the service layer, never here — a NULL is the honest "never renamed" state.
--
-- sample_id names which bundled sample a document was opened from, if any. No CHECK: a registry-
-- mirrored CHECK like document_type's (0001) has to be replaced by a new migration every time the
-- registry changes, and the sample set is expected to grow, so sample_id is validated in the service
-- only, against the live registry, never pinned to a list frozen at migration time.
--
-- user_instructions records what a draft (or a revision of it) was actually asked for, so the
-- revision history can show it. Rows written before this column existed have nothing to show and stay
-- NULL — inventing a value for them would misattribute a request nobody made.
--
-- updated_at is backfilled from each table's existing activity timestamp so already-existing rows keep
-- a real order instead of tying at the moment this migration runs (uploaded_at for documents,
-- created_at for comparisons and drafts, matching the only timestamp each of those tables already had).
-- No trigger sets it going forward: every write that changes a row's visible state (rename, analysis
-- complete, save-to-project, unassign, a new revision) must set updated_at itself, in the same statement.
-- A blanket trigger would also fire on a write that must NOT reorder a list, such as a guest->user
-- claim (which re-owns the row and clears expires_at in one UPDATE, unrelated to what the row shows).

ALTER TABLE documents
  ADD COLUMN title text,
  ADD COLUMN sample_id text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE comparisons
  ADD COLUMN title text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE drafts
  ADD COLUMN title text,
  ADD COLUMN user_instructions text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

UPDATE documents SET updated_at = uploaded_at;
UPDATE comparisons SET updated_at = created_at;
UPDATE drafts SET updated_at = created_at;

-- Keyset list pages ("newest activity first") scan one owner's rows in (updated_at DESC, id DESC)
-- order. Ownership on these three tables is split across two mutually-exclusive nullable columns (see
-- the *_owner_exclusive_check constraints in 0001), so — mirroring that same split, the way
-- messages_thread_id_created_at_id_idx mirrors messages' single owning column — each table gets one
-- composite index per owner column rather than one index with an OR.

CREATE INDEX documents_owner_user_id_updated_at_id_idx ON documents (owner_user_id, updated_at DESC, id DESC);
CREATE INDEX documents_owner_guest_session_id_updated_at_id_idx ON documents (owner_guest_session_id, updated_at DESC, id DESC);

CREATE INDEX comparisons_owner_user_id_updated_at_id_idx ON comparisons (owner_user_id, updated_at DESC, id DESC);
CREATE INDEX comparisons_owner_guest_session_id_updated_at_id_idx ON comparisons (owner_guest_session_id, updated_at DESC, id DESC);

CREATE INDEX drafts_owner_user_id_updated_at_id_idx ON drafts (owner_user_id, updated_at DESC, id DESC);
CREATE INDEX drafts_owner_guest_session_id_updated_at_id_idx ON drafts (owner_guest_session_id, updated_at DESC, id DESC);
