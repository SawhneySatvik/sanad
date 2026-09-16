-- drafts.jurisdiction. Hand-written; additive.
--
-- The data model puts an ISO country code, default 'IN', on BOTH documents and drafts; 0001 added it
-- to documents only. This mirrors the documents column and its documents_jurisdiction_iso_check
-- exactly.
--
-- Unlike 0003's model_used, the DEFAULT here is the data model's own value, not an invented one: the
-- product currently covers Indian (national-level) law only, so any drafts row that already exists
-- (none in production, which has never been deployed) is correctly backfilled with 'IN'.
--
-- prod-only/ needs no change: the Data API revokes are table-level (covering new columns) and the
-- guest-expiry sweep never names this column.

ALTER TABLE drafts
  ADD COLUMN jurisdiction text NOT NULL DEFAULT 'IN',
  ADD CONSTRAINT drafts_jurisdiction_iso_check CHECK (jurisdiction ~ '^[A-Z]{2}$');
