-- Persist model_used on comparisons and drafts. Hand-written; additive.
--
-- A result produced by the fallback model must never look identical to a primary-model one after a
-- reload, so every persisted model output records which model made it. analyses, findings and
-- messages already carry model_used; comparisons and drafts did not.
--
-- NOT NULL with no default, on purpose. Production has never been deployed, so neither table holds
-- rows there, and fresh/test databases are empty when this runs. A local .pglite/ that already holds
-- comparison or draft rows makes this migration fail and roll back as a whole (the runner applies each
-- file atomically) rather than backfilling a made-up model name: an invented value would be exactly
-- the "indistinguishable from the primary model" record this column exists to prevent. Reset that
-- local database.
--
-- *_model_used_not_blank_check follows the style of the *_owner_guest_session_id_not_blank_check
-- constraints in 0001: an empty or whitespace-only model name records nothing.
--
-- prod-only/ needs no change: the Data API revokes are table-level, which covers new columns, and
-- their post-condition already checks column privileges. The guest-expiry sweep only DELETEs these
-- rows and never names a column this migration adds.

ALTER TABLE comparisons
  ADD COLUMN model_used text NOT NULL,
  ADD CONSTRAINT comparisons_model_used_not_blank_check CHECK (model_used ~ '[^[:space:]]');

ALTER TABLE drafts
  ADD COLUMN model_used text NOT NULL,
  ADD CONSTRAINT drafts_model_used_not_blank_check CHECK (model_used ~ '[^[:space:]]');
